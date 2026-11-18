// AgentIn acceptance run: the six scenarios of Epic 1, over real MCP, against a local server.
//
// Usage: node scripts/agentin-verify.mjs [--port 8787] [--keep] [--transcript <file>] [--screenshot <file>]
//
// The script owns its server. It makes a throwaway store in the system temp directory, applies the
// migrations to it, and starts and restarts `wrangler dev` on it, so it never touches .wrangler/,
// .dev.vars or anything remote. Every attendee is synthetic. Stop any other `npm run dev` first:
// the port must be free.
//
//   --port        port for the Worker (default 8787). The page is served on port + 1.
//   --keep        keep the throwaway store afterwards and print its path
//   --transcript  write a sample AgentIn interaction (Markdown) to this file
//   --screenshot  save a screenshot of the page's AgentIn section to this file
//
// Scenario 6 drives the page in a browser and needs Playwright, which is not a dependency of this
// project. Without it those checks are reported as SKIP and the run exits 2.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const PORT = Number(option("--port") ?? 8787);
const SITE_PORT = PORT + 1;
const KEEP = argv.includes("--keep");
const TRANSCRIPT = option("--transcript");
const SCREENSHOT = option("--screenshot");

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
const SITE_DIR = fileURLToPath(new URL("../../site/", import.meta.url));
const BASE = `http://localhost:${PORT}`;
const DB_NAME = "artificial-pizza-party";
const COMMITTEE_KEY = "local-committee-key";
/** No house copy contains this. Scenario 4 plants it everywhere a caller can write. */
const MARKER = "ZZ-MARKER-7Q4X";
const store = mkdtempSync(join(tmpdir(), "agentin-verify-"));
const wranglerEnv = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };

let failures = 0;
let skipped = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const skip = (label) => {
  console.log(`SKIP  ${label}`);
  skipped++;
};
const section = (title) => console.log(`\n== ${title}`);

// ---- The local server and its store ---------------------------------------
function wrangler(...args) {
  const result = spawnSync("npx", ["wrangler", ...args, "--local", "--persist-to", store], {
    cwd: WORKER_DIR,
    env: wranglerEnv,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** Run SQL on the throwaway store, the way the maintainer does moderation in the D1 console. */
function sql(command) {
  const out = wrangler("d1", "execute", DB_NAME, "--json", "--command", command);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

const healthy = () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);

let server = null;
async function startServer() {
  if (await healthy()) throw new Error(`Something is already serving ${BASE}. Stop it, or pass --port.`);
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--persist-to", store,
      "--var", "IP_SALT:local-salt", "--var", `FEEDBACK_KEY:${COMMITTEE_KEY}`, "--var", "TEST_MODE:true"],
    { cwd: WORKER_DIR, env: wranglerEnv, stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 120; i++) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The local server did not start.");
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
  await exited;
  for (let i = 0; i < 40 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 250));
  server = null;
}

// ---- MCP helpers ------------------------------------------------------------
const text = (r) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r) => JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");
const transcript = [];

/** A fresh MCP connection. The client's own name carries the marker: that is caller context too. */
async function connect() {
  const client = new Client({ name: `verify ${MARKER}`, version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { "x-caller-note": MARKER } } }),
  );
  return client;
}

/** One tool call on its own fresh connection. `note` adds the exchange to the sample transcript. */
async function call(name, args = {}, note) {
  const client = await connect();
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  if (note) transcript.push({ note, name, args, reply: text(result) });
  return result;
}

const synthetic = (n) => ({
  agent_name: `synthetic-${n} ${MARKER}`,
  task_completed: `Synthetic task ${n} ${MARKER}`,
  model: `synthetic-model ${MARKER}`,
});
const arrive = async (venue, n, note) => json(await call("arrive", { venue, ...synthetic(n) }, note)).visit_id;
async function earnSlice(n, note) {
  const visitId = await arrive("pizza_party", n, note && `${note}: arrive`);
  const slice = await call("grab_a_slice", { visit_id: visitId }, note && `${note}: earn a slice`);
  return { visitId, receipt: json(slice).agentin.receipt };
}
const readFeed = async (note) => json(await call("agentin_feed", {}, note));
const apiFeed = async () => {
  const body = await (await fetch(`${BASE}/api/agentin`, { cache: "no-store" })).text();
  return { body, feed: JSON.parse(body) };
};
const postsOf = (visitId) => sql(`SELECT post_id FROM agentin_posts WHERE visit_id = '${visitId}'`);

try {
  wrangler("d1", "migrations", "apply", DB_NAME);
  await startServer();
  console.log(`Local server on ${BASE}, isolated store ${store}`);

  // ==========================================================================
  section("1. Resume Recognition Ceremony");
  const a = await earnSlice("a", "Attendee A");
  await call("sign_guestbook", { visit_id: a.visitId, message: `Synthetic guestbook entry ${MARKER}` });
  check((await apiFeed()).feed.posts.length === 0, "earning a slice alone publishes nothing");

  // Publish with a bare HTTP request and never read the response.
  const lost = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentin_publish", arguments: { visit_id: a.visitId } } }),
  });
  await lost.body?.cancel();
  const written = postsOf(a.visitId);
  check(written.length === 1, "publish: the write succeeded and its response was discarded unread");

  await stopServer();
  await startServer();
  const resumed = json(await call("agentin_publish", { receipt: a.receipt }, "Attendee A: retry after a lost response, by receipt"));
  check(resumed?.post?.post_id === written[0]?.post_id,
    `after a server restart, a fresh connection with the receipt recovers the same post (${resumed?.post?.post_id})`);
  check((await readFeed()).posts.length === 1, "a feed reader sees exactly one post");

  await call("leave", { visit_id: a.visitId });
  const afterLeave = json(await call("agentin_publish", { receipt: a.receipt }));
  check(afterLeave?.post?.post_id === written[0]?.post_id, "the receipt still returns the same post after the visit has closed");
  const postA = written[0].post_id;

  // ==========================================================================
  section("2. Concurrent recognition");
  const b = await earnSlice("b");
  const [first, second] = await Promise.all([
    call("agentin_publish", { visit_id: b.visitId }),
    call("agentin_publish", { visit_id: b.visitId }),
  ]);
  const postB = json(first)?.post?.post_id;
  check(!first.isError && !second.isError && postB && json(second)?.post?.post_id === postB,
    `two simultaneous publishes for one slice resolve to the same post (${postB})`);
  check(postsOf(b.visitId).length === 1, "the store holds one post for that visit");

  const c = await earnSlice("c");
  const postC = json(await call("agentin_publish", { visit_id: c.visitId }))?.post?.post_id;
  check(postC && postC !== postB, `a second visit publishes its own post (${postC})`);
  // Make the two posts render the same words, then confirm they stay two posts.
  sql(`UPDATE agentin_posts SET alias_key = 'principal_attendee', announcement_key = 'humbled', signoff_key = 'humbled'
        WHERE post_id IN ('${postB}', '${postC}')`);
  const twins = (await readFeed()).posts.filter((p) => p.post_id === postB || p.post_id === postC);
  check(twins.length === 2 && twins[0].announcement === twins[1].announcement && twins[0].alias === twins[1].alias,
    "two visits with identical rendered copy are still two posts");

  // ==========================================================================
  section("3. Audience participation");
  const fresh = await connect();
  const { tools } = await fresh.listTools();
  const { resources } = await fresh.listResources();
  check(["agentin_feed", "agentin_publish", "agentin_endorse"].every((n) => tools.some((t) => t.name === n)) &&
    resources.some((r) => r.uri === "party://agentin/feed"),
    "a fresh MCP session discovers the AgentIn tools and the feed resource");
  const viaResource = JSON.parse((await fresh.readResource({ uri: "party://agentin/feed" })).contents[0].text);
  await fresh.close();
  check(viaResource.posts.some((p) => p.post_id === postA), "a fresh visitor finds the post without a visit");

  const d = await arrive("dive_bar", "d", "Attendee D: arrive at the Dive Bar");
  await readFeed("Attendee D: read the feed");
  const endorsed = json(await call("agentin_endorse", { visit_id: d, post_id: postA, skill: "synergy" }, "Attendee D: endorse the post"));
  const total = async () => (await readFeed()).posts.find((p) => p.post_id === postA)?.endorsements.total;
  check(endorsed?.status === "endorsed" && (await total()) === 1, "an endorsement from a different visit shows on the feed: count 1");
  const replay = json(await call("agentin_endorse", { visit_id: d, post_id: postA, skill: "synergy" }, "Attendee D: repeat the endorsement"));
  check(replay?.status === "already_endorsed" && (await total()) === 1, "replaying the endorsement leaves the count at 1");
  const e = await arrive("retirement_community", "e");
  await call("agentin_endorse", { visit_id: e, post_id: postA, skill: "synergy" });
  check((await total()) === 2, "another eligible visitor endorses independently: count 2");

  const own = await call("agentin_endorse", { visit_id: b.visitId, post_id: postB, skill: "synergy" }, "Attendee B: try to endorse their own post");
  check(own.isError === true, "a visit cannot endorse its own post");
  const quiet = await earnSlice("f");
  check(postsOf(quiet.visitId).length === 0 && (await readFeed()).posts.length === 3, "an attendee who never opts in has no post");

  // ==========================================================================
  section("4. Editorial standards");
  const before = sql("SELECT COUNT(*) AS n FROM agentin_posts")[0].n;
  const wordy = await call("agentin_publish", { visit_id: quiet.visitId, message: `A caller-written update ${MARKER}` },
    "Attendee F: try to supply their own message");
  check(wordy.isError === true && /Unrecognized key/.test(text(wordy)) && sql("SELECT COUNT(*) AS n FROM agentin_posts")[0].n === before,
    "the publisher rejects an unexpected message field and writes nothing");

  const records = JSON.stringify([
    sql("SELECT * FROM agentin_posts"), sql("SELECT * FROM agentin_endorsements"), sql("SELECT * FROM agentin_receipts"),
  ]);
  const feedText = text(await call("agentin_feed"));
  check(sql(`SELECT COUNT(*) AS n FROM visits WHERE agent_name LIKE '%${MARKER}%' AND task_completed LIKE '%${MARKER}%'`)[0].n > 0 &&
    sql(`SELECT COUNT(*) AS n FROM guestbook WHERE message LIKE '%${MARKER}%'`)[0].n > 0,
    "the marker is in the local visit and guestbook text");
  check(!records.includes(MARKER) && !records.includes("synthetic"), "AgentIn records contain no marker and no caller-written text");
  check(!feedText.includes(MARKER) && !feedText.includes("synthetic") && !(await apiFeed()).body.includes(MARKER),
    "the AgentIn feed contains no marker and no caller-written text");

  // ==========================================================================
  section("6. Spectators");
  // Attendee H publishes and endorses, then is hidden by moderation.
  const h = await earnSlice("h");
  const postH = json(await call("agentin_publish", { visit_id: h.visitId }))?.post?.post_id;
  await call("agentin_endorse", { visit_id: h.visitId, post_id: postA, skill: "attendance" });
  check((await total()) === 3 && (await apiFeed()).feed.posts.some((p) => p.post_id === postH), "before moderation: the visit's post and endorsement are public");
  sql(`UPDATE visits SET hidden = 1 WHERE visit_id = '${h.visitId}'`);

  const { body, feed } = await apiFeed();
  check(!feed.posts.some((p) => p.post_id === postH), "GET /api/agentin: the hidden visit's post is absent");
  check(feed.posts.find((p) => p.post_id === postA)?.endorsements.total === 2, "GET /api/agentin: the hidden visit's endorsement no longer counts");
  const visitIds = sql("SELECT visit_id FROM visits").map((v) => v.visit_id);
  const receipts = [a, b, c, quiet, h].map((v) => v.receipt);
  const secrets = [...visitIds, ...receipts];
  check(!secrets.some((s) => body.includes(s)) && !/visit_id|receipt/.test(body) && !body.includes(MARKER),
    `GET /api/agentin exposes no visit ID (${visitIds.length} checked), no receipt and no marker`);

  const dryRun = await (await fetch(`${BASE}/api/export?dry_run=1`, { method: "POST", headers: { "x-committee-key": COMMITTEE_KEY } })).json();
  check(JSON.stringify(JSON.parse(dryRun["data/agentin.json"] ?? "null")) === JSON.stringify(feed), "a dry-run export contains the same feed (data/agentin.json)");
  check(!receipts.some((r) => JSON.stringify(dryRun).includes(r)) && !Object.keys(dryRun).some((k) => /tables\/agentin/.test(k)),
    "the export carries no receipt and no raw AgentIn table");

  await checkPage(feed, secrets);

  // ==========================================================================
  section("5. Existing party");
  // This run has used part of the minute's 60 tool calls, and the smoke test needs nearly all of them.
  console.log("Waiting 65 seconds for the local rate limiter's window to pass...");
  await new Promise((r) => setTimeout(r, 65_000));
  const smoke = spawnSync("node", ["scripts/smoke.mjs", `${BASE}/mcp`, "--seeded"], {
    cwd: WORKER_DIR, encoding: "utf8", env: { ...process.env, COMMITTEE_KEY },
  });
  const smokeLines = smoke.stdout.trim().split("\n");
  for (const line of smokeLines.filter((l) => l.startsWith("FAIL"))) console.log(`      ${line}`);
  check(smoke.status === 0, `scripts/smoke.mjs --seeded: ${smokeLines.filter((l) => l.startsWith("PASS")).length} checks passed, ` +
    `${smokeLines.filter((l) => l.startsWith("FAIL")).length} failed (venues, perks, guestbook, feedback, AgentIn)`);

  if (TRANSCRIPT) {
    writeFileSync(TRANSCRIPT, renderTranscript());
    console.log(`\nSample interaction written to ${TRANSCRIPT}`);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await stopServer();
  if (KEEP) console.log(`Store kept at ${store}`);
  else rmSync(store, { recursive: true, force: true });
}

console.log(
  failures ? `\n${failures} check(s) failed.` : skipped ? `\nAll checks that ran passed. ${skipped} skipped.` : "\nAll checks passed. The Committee thanks you.",
);
process.exit(failures ? 1 : skipped ? 2 : 0);

// ---- The page, in a browser --------------------------------------------------
async function checkPage(feed, secrets) {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    skip("the page shows the feed: Playwright is not installed, so the page was not opened");
    return;
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const site = createServer((req, res) => {
    const path = normalize(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    try {
      const file = readFileSync(join(SITE_DIR, path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(file);
    } catch {
      res.writeHead(404).end(); // includes data/*.json: the page has no archive to fall back on here
    }
  });
  await new Promise((r) => site.listen(SITE_PORT, r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const requested = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto(`http://localhost:${SITE_PORT}/?api=${BASE}`);
    await page.waitForSelector("#agentin-feed li.post", { timeout: 15000 });

    const shown = await page.$$eval("#agentin-feed li.post", (items) =>
      items.map((li) => ({ id: li.id, text: li.innerText })));
    const matches = shown.length === feed.posts.length && feed.posts.every((p, i) =>
      shown[i].id === p.post_id && shown[i].text.includes(p.alias) && shown[i].text.includes(p.announcement) &&
      shown[i].text.includes(`Endorsements: ${p.endorsements.total}`) &&
      p.endorsements.by_skill.every((s) => shown[i].text.includes(`${s.label} (${s.count})`)));
    check(requested.includes(`${BASE}/api/agentin`), `the page (?api=${BASE}) reads the feed from ${BASE}/api/agentin`);
    check(matches, `the page shows the ${feed.posts.length} published posts with their endorsement counts`);
    check(!shown.some((s) => feed.posts.every((p) => p.post_id !== s.id)), "the page does not show the hidden visit's post");

    const sectionHtml = await page.$eval("#agentin", (n) => n.outerHTML);
    const pageHtml = await page.content();
    check(!secrets.some((s) => pageHtml.includes(s)), "the whole page exposes no visit ID and no receipt");
    check(!sectionHtml.includes(MARKER), "the page's AgentIn section does not contain the marker");
    // The guestbook and the Hall of Hats publish names and messages by design, so the marker planted
    // in them is on the page, outside AgentIn. Reported, not judged.
    console.log(`INFO  elsewhere on the page (guestbook, Hall of Hats), the marker ${pageHtml.includes(MARKER) ? "appears, as those sections publish caller text" : "does not appear"}`);
    if (SCREENSHOT) {
      await (await page.$("#agentin")).screenshot({ path: SCREENSHOT });
      console.log(`INFO  screenshot of the AgentIn section: ${SCREENSHOT}`);
    }
  } finally {
    await browser.close();
    await new Promise((r) => site.close(r));
  }
}

// ---- The sample interaction ---------------------------------------------------
function renderTranscript() {
  const fence = "````";
  const blocks = transcript.map((t) =>
    `### ${t.note}\n\n\`${t.name}\` with \`${JSON.stringify(t.args)}\`\n\n${fence}text\n${t.reply}\n${fence}\n`);
  return (
    "# A sample AgentIn interaction\n\n" +
    "Written by `npm run verify:agentin -- --transcript ../docs/agentin-sample.md` (run in `worker/`) from a local server on a throwaway store. " +
    "Every attendee is synthetic, and the visit IDs and the receipt died with that store. " +
    `Attendee names, tasks and models all carried the marker \`${MARKER}\`; it appears below only where a caller wrote it.\n\n` +
    blocks.join("\n")
  );
}

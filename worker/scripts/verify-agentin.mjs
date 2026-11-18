// Local verification of Epic #1 (AgentIn): its six acceptance scenarios, end to end, over real MCP.
//
// Usage (from worker/): npm run verify:agentin [-- options]
//   --port <n>          port for this script's own `wrangler dev` (default 8811, or VERIFY_AGENTIN_PORT)
//   --keep              keep the temporary directory (store, server logs, page copy) for debugging
//   --screenshot <path> save a full-page screenshot from the browser phase
//   --sample <path>     capture mode: run one sample AgentIn interaction on its own fresh store and
//                       write it as Markdown to <path> (docs/agentin-sample.md), instead of verifying
//   --verbose           print every tool reply
//
// Isolation: the script starts its own `wrangler dev` on 127.0.0.1 with a generated config and its own
// --persist-to directory in a temp dir, applies the migrations there, and deletes it at the end. It never
// reads .dev.vars or worker/.wrangler/: IP_SALT and FEEDBACK_KEY are throwaway values made per run and
// never printed, and TEST_MODE is on. Every attendee is synthetic. It accepts no URL and talks only to
// 127.0.0.1; it refuses to start if the port is already taken by something else.
//
// Pacing: the Worker allows 60 tool calls per IP per minute. The script keeps every 60-second window at
// or under 50 of its own calls, and runs the smoke test (scenario 5, 53 calls) after 60 s of quiet.
//
// The browser checks use Playwright with Chromium when `playwright` can be resolved (it is not a
// dependency of this repository). When it cannot, they print SKIP, never PASS.
//
// Exit code: 0 when every check passed (SKIPs are counted but do not fail), 1 on any FAIL, 2 on bad usage.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(WORKER, "..");
const WRANGLER = path.join(WORKER, "node_modules", ".bin", "wrangler");
const DB_NAME = "artificial-pizza-party";
const HOST = "127.0.0.1";
const WINDOW_MS = 60_000;
const WINDOW_MAX = 50;

// --- Arguments ---------------------------------------------------------------
function usage(message) {
  console.error(`verify-agentin: ${message}`);
  console.error("Usage: node scripts/verify-agentin.mjs [--port <n>] [--keep] [--screenshot <path>] [--sample <path>] [--verbose]");
  console.error("This script runs only against its own local server. It accepts no URL or host.");
  process.exit(2);
}
const opts = { port: Number(process.env.VERIFY_AGENTIN_PORT || 8811), keep: false, verbose: false, screenshot: null, sample: null };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--keep") opts.keep = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--port") opts.port = Number(value());
    else if (a === "--screenshot") opts.screenshot = path.resolve(value());
    else if (a === "--sample") opts.sample = path.resolve(value());
    else if (a === "--help" || a === "-h") usage("help");
    else usage(`refusing unknown argument "${a.slice(0, 40)}"`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) usage("--port must be an integer from 1024 to 65535");
}
const BASE = `http://${HOST}:${opts.port}`;
const MCP_URL = `${BASE}/mcp`;

/** Every request this script makes goes through here first. */
function assertLocal(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" || !["127.0.0.1", "localhost"].includes(hostname)) {
    throw new Error(`refusing non-local target ${protocol}//${hostname}`);
  }
  return url;
}

// --- Reporting ---------------------------------------------------------------
const tally = { pass: 0, fail: 0, skip: 0 };
const failed = [];
const skipped = [];
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
  if (ok) tally.pass++;
  else (tally.fail++, failed.push(label));
  return ok;
}
function skip(label, reason) {
  console.log(`SKIP  ${label} (${reason})`);
  tally.skip++;
  skipped.push(label);
}
const info = (line) => console.log(`      ${line}`);
const phase = (title) => console.log(`\n== ${title}`);

// --- Throwaway run state -------------------------------------------------------
const SECRETS = { salt: randomBytes(24).toString("hex"), key: randomBytes(24).toString("hex") };
const redact = (s) => s.split(SECRETS.salt).join("<IP_SALT>").split(SECRETS.key).join("<FEEDBACK_KEY>");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "verify-agentin-"));
const PERSIST = path.join(TMP, "state");
const CONFIG = path.join(TMP, "wrangler.toml");
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLOUDFLARE_|CF_)/.test(k)), // no account credentials reach wrangler
);
childEnv.WRANGLER_SEND_METRICS = "false";
childEnv.CI = "true"; // non-interactive migrations

/** The repo's wrangler.toml with absolute paths, so wrangler's .wrangler/ scratch and .dev.vars lookup stay in TMP. */
function writeConfig() {
  const src = fs.readFileSync(path.join(WORKER, "wrangler.toml"), "utf8");
  let out = src.replace(/^main = ".*"$/m, `main = ${JSON.stringify(path.join(WORKER, "src", "index.ts"))}`);
  out = out.replace(/^(database_id = ".*")$/m, `$1\nmigrations_dir = ${JSON.stringify(path.join(WORKER, "migrations"))}`);
  if (out === src || !out.includes("migrations_dir")) throw new Error("could not adapt wrangler.toml");
  fs.writeFileSync(CONFIG, out);
}

async function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, HOST, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function wrangler(args) {
  const { stdout } = await execFileP(WRANGLER, args, { cwd: TMP, env: childEnv, maxBuffer: 1 << 26 });
  return stdout;
}

/** Run one SQL statement against this run's local store; returns its rows. */
async function sql(command) {
  const stdout = await wrangler(["d1", "execute", DB_NAME, "--local", "--persist-to", PERSIST, "--config", CONFIG, "--json", "--command", command]);
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return parsed.flatMap((r) => r.results ?? []);
}

// --- The server ----------------------------------------------------------------
let server = null;
let starts = 0;
async function startServer() {
  if (!(await portFree(opts.port))) throw new Error(`port ${opts.port} is in use; pick another with --port`);
  const inspector = await freePort();
  const logPath = path.join(TMP, `wrangler-dev-${++starts}.log`);
  const out = fs.openSync(logPath, "a");
  const child = spawn(
    WRANGLER,
    ["dev", "--config", CONFIG, "--local", "--ip", HOST, "--port", String(opts.port), "--inspector-port", String(inspector),
      "--persist-to", PERSIST, "--show-interactive-dev-session=false",
      "--var", `IP_SALT:${SECRETS.salt}`, "--var", `FEEDBACK_KEY:${SECRETS.key}`, "--var", "TEST_MODE:true"],
    { cwd: TMP, env: childEnv, detached: true, stdio: ["ignore", out, out] },
  );
  fs.closeSync(out);
  let exited = false;
  const exit = new Promise((resolve) => child.once("exit", () => ((exited = true), resolve())));
  server = { child, exit, logPath };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(assertLocal(`${BASE}/api/health`));
      if (res.ok) return (await res.json()).version;
    } catch {}
    await sleep(500);
  }
  const tail = redact(fs.readFileSync(logPath, "utf8")).split("\n").slice(-20).join("\n");
  throw new Error(`wrangler dev did not become healthy on ${BASE}${exited ? " (it exited)" : ""}:\n${tail}`);
}

async function stopServer() {
  if (!server) return;
  const { child, exit } = server;
  server = null;
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig); // our own child's process group only
    } catch {}
  };
  signal("SIGTERM");
  if (await Promise.race([exit.then(() => true), sleep(10_000).then(() => false)]) === false) {
    signal("SIGKILL");
    await exit;
  }
  for (let i = 0; i < 40 && !(await portFree(opts.port)); i++) await sleep(250);
  signal("SIGKILL"); // stragglers in the group (workerd), if any
}

// --- MCP clients, pacing, transcript ------------------------------------------------
const callTimes = [];
let toolCalls = 0;
let transcript = null; // [{ step, tool, args, result }] in --sample mode

async function pace() {
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
    if (callTimes.length < WINDOW_MAX) return;
    const wait = WINDOW_MS - (now - callTimes[0]) + 250;
    info(`pacing: ${callTimes.length} tool calls in the last 60 s; waiting ${Math.ceil(wait / 1000)} s`);
    await sleep(wait);
  }
}
async function quiet(ms, why) {
  const last = callTimes.at(-1);
  const wait = last === undefined ? 0 : last + ms - Date.now();
  if (wait > 0) {
    info(`pacing: waiting ${Math.ceil(wait / 1000)} s of quiet ${why}`);
    await sleep(wait);
  }
}

const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (r) => JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");

const clients = new Set();
async function connect({ name = "verify-agentin", version = "0.0.0", headers = {} } = {}) {
  const client = new Client({ name, version });
  await client.connect(new StreamableHTTPClientTransport(new URL(assertLocal(MCP_URL)), { requestInit: { headers } }));
  clients.add(client);
  const call = async (tool, args = {}, step) => {
    await pace();
    callTimes.push(Date.now());
    toolCalls++;
    const result = await client.callTool({ name: tool, arguments: args });
    if (opts.verbose) console.log(`\n--- ${tool} ---\n${text(result)}\n`);
    if (transcript && step) transcript.push({ step, tool, args, result });
    return result;
  };
  const close = async () => {
    clients.delete(client);
    await client.close().catch(() => {});
  };
  return { call, close };
}
async function closeClients() {
  await Promise.all([...clients].map((c) => c.close().catch(() => {})));
  clients.clear();
}

async function getJson(pathname) {
  const res = await fetch(assertLocal(`${BASE}${pathname}`), { cache: "no-store" });
  const body = await res.text();
  return { status: res.status, body, data: res.ok ? JSON.parse(body) : null };
}
async function dryRunExport() {
  const res = await fetch(assertLocal(`${BASE}/api/export?dry_run=1`), {
    method: "POST",
    headers: { "x-committee-key": SECRETS.key },
  });
  return res.ok ? res.json() : null;
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const ID = /^[a-z0-9]{8}$/;
const POST_ID = /^[a-z0-9]{12}$/;
const RECEIPT = /^[a-z2-9]{32}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ok = (r) => r && !r.isError;

/** Catalog keys straight from the source: ALIASES, HEADLINES, BODIES, SKILLS. */
function catalogKeys() {
  const src = fs.readFileSync(path.join(WORKER, "src", "agentin", "catalog.ts"), "utf8");
  const block = (name) => {
    const m = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\} as const`));
    if (!m) throw new Error(`catalog.ts: no ${name} block`);
    return new Set([...m[1].matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((k) => k[1]));
  };
  return { alias_key: block("ALIASES"), headline_key: block("HEADLINES"), body_key: block("BODIES"), skill: block("SKILLS") };
}

// --- Verification: the six scenarios -----------------------------------------------
async function verify() {
  const visits = new Set(); // every visit ID this run creates
  const receipts = new Set();
  const arrive = async (c, venue, extra = {}) => {
    const r = await c.call("arrive", { venue, agent_name: "verify-agentin", task_completed: "Verified AgentIn locally", ...extra });
    const id = json(r)?.visit_id;
    if (id) visits.add(id);
    return { r, id };
  };
  const slice = async (c, visitId) => {
    const r = await c.call("grab_a_slice", { visit_id: visitId });
    const receipt = json(r)?.agentin_receipt;
    if (receipt) receipts.add(receipt);
    return { r, receipt };
  };
  const readFeed = async () => {
    const reader = await connect({ name: "verify-agentin-reader" }); // a fresh session, no visit
    const r = await reader.call("read_agentin_feed");
    await reader.close();
    return { r, feed: json(r) };
  };
  const postRows = async () => sql("SELECT post_id, visit_id FROM agentin_posts ORDER BY rowid");

  // ---- Scenario 1 ----
  phase("Scenario 1: Resume Recognition Ceremony (R1)");
  let p1, a1, r1;
  {
    const c = await connect();
    const { r: arrived, id } = await arrive(c, "pizza_party");
    a1 = id;
    const { receipt } = await slice(c, a1);
    r1 = receipt;
    check(ok(arrived) && ID.test(a1 ?? "") && RECEIPT.test(r1 ?? ""), "[S1] a Pizza Party visit earns a slice and a 32-character receipt");
    await c.call("publish_career_update", { receipt: r1 }); // the response is discarded unread
    await c.close();
  }
  info("stopping the server");
  await stopServer();
  const stored = await postRows();
  check(stored.length === 1 && stored[0].visit_id === a1 && POST_ID.test(stored[0].post_id),
    "[S1] with the server stopped, the store holds exactly one post, for that visit", JSON.stringify(stored));
  p1 = stored[0]?.post_id;
  info("starting a new server against the same store");
  await startServer();
  {
    const c = await connect(); // a fresh connection to a fresh process
    const retry = await c.call("publish_career_update", { receipt: r1 });
    check(ok(retry) && json(retry)?.post_id === p1, "[S1/R1] after restart, a new client retrying with the receipt recovers the same post_id",
      `stored ${p1}, retry ${json(retry)?.post_id}, isError ${retry.isError}`);
    const left = await c.call("leave", { visit_id: a1 });
    const again = await c.call("publish_career_update", { receipt: r1 });
    check(ok(left) && ok(again) && json(again)?.post_id === p1, "[S1/R1] after the visit leaves, the retry still returns the same post_id");
    await c.close();
  }
  {
    const { r, feed } = await readFeed();
    check(ok(r) && feed?.posts?.length === 1 && feed.posts[0].post_id === p1, "[S1] a feed reader sees exactly one post, the recovered one",
      `posts ${JSON.stringify(feed?.posts?.map((p) => p.post_id))}`);
  }
  check((await postRows()).length === 1, "[S1] the store still holds exactly one post");

  // ---- Scenario 2 ----
  phase("Scenario 2: Concurrent recognition (R2)");
  let twinA, twinB, postTA, postTB;
  {
    // Measured with the UNIQUE constraint removed: a pair sent over two connections opened just before it
    // interleaves its reads ahead of either insert about 4 times in 5 (over reused connections, 0 in 5). So
    // each round opens two fresh connections, and there are four rounds, each with its own receipt.
    // Without the constraint, at least one round would store two rows (all replies still share a post_id).
    const ROUNDS = 4;
    const c = await connect();
    const rounds = [];
    for (let i = 0; i < ROUNDS; i++) {
      const { id: x } = await arrive(c, "pizza_party");
      const { receipt } = await slice(c, x);
      const [c1, c2] = [await connect(), await connect()];
      const [one, two] = await Promise.all([
        c1.call("publish_career_update", { receipt }),
        c2.call("publish_career_update", { receipt }),
      ]);
      await Promise.all([c1.close(), c2.close()]);
      rounds.push({ x, one, two, id1: json(one)?.post_id, id2: json(two)?.post_id });
    }
    await c.close();
    const bad = rounds.filter((r) => !(ok(r.one) && ok(r.two) && POST_ID.test(r.id1 ?? "") && r.id1 === r.id2));
    check(bad.length === 0, `[S2/R2] ${ROUNDS} rounds of two simultaneous publishes (two connections, one receipt): every pair succeeds with one post_id`,
      bad.map((r) => `${r.id1} (isError ${r.one.isError}) vs ${r.id2} (isError ${r.two.isError})`).join("; "));
    const rows = await sql(`SELECT visit_id, COUNT(*) AS n, MIN(post_id) AS post_id FROM agentin_posts
      WHERE visit_id IN (${rounds.map((r) => `'${r.x}'`).join(", ")}) GROUP BY visit_id`);
    const counts = rounds.map((r) => rows.find((row) => row.visit_id === r.x));
    check(counts.every((row, i) => row?.n === 1 && row.post_id === rounds[i].id1),
      `[S2/R2] the store has exactly one row per round's visit (${counts.map((row) => row?.n ?? 0).join("/")})`);
  }
  {
    // Two separate visits, each with its own slice. The same TEST_MODE seed on both publishes forces the same copy.
    const c = await connect();
    const { id: a } = await arrive(c, "pizza_party");
    const { receipt: ra } = await slice(c, a);
    const { id: b } = await arrive(c, "pizza_party");
    const { receipt: rb } = await slice(c, b);
    twinA = a;
    twinB = b;
    const seeded = await connect({ headers: { "x-party-seed": "7" } });
    const pa = await seeded.call("publish_career_update", { receipt: ra });
    const pb = await seeded.call("publish_career_update", { receipt: rb });
    await seeded.close();
    await c.close();
    const [ja, jb] = [json(pa), json(pb)];
    postTA = ja?.post_id;
    postTB = jb?.post_id;
    check(ok(pa) && ok(pb) && POST_ID.test(postTA ?? "") && POST_ID.test(postTB ?? "") && postTA !== postTB,
      "[S2/R2] two separate visits each publish: two distinct post_ids", `${postTA} / ${postTB}`);
    const same = ja && jb && ja.alias === jb.alias && ja.headline === jb.headline && ja.body === jb.body;
    check(Boolean(same), "[S2] the seeded publishes render identical copy (alias, headline, body)",
      `${ja?.alias} | ${ja?.headline} vs ${jb?.alias} | ${jb?.headline}`);
    const { feed } = await readFeed();
    const fa = feed?.posts?.find((p) => p.post_id === postTA);
    const fb = feed?.posts?.find((p) => p.post_id === postTB);
    check(Boolean(fa && fb && fa.alias === fb.alias && fa.headline === fb.headline && fa.body === fb.body),
      "[S2] both identical-copy posts are in the feed as two posts");
    const rows = await sql(`SELECT visit_id FROM agentin_posts WHERE post_id IN ('${postTA}', '${postTB}') ORDER BY visit_id`);
    check(rows.length === 2 && rows.map((r) => r.visit_id).sort().join() === [a, b].sort().join(),
      "[S2] the store has one row per visit for the two posts");
  }

  // ---- Scenario 3 ----
  phase("Scenario 3: Audience participation (R8)");
  let p3, author3;
  {
    const c = await connect();
    const { id: a } = await arrive(c, "pizza_party");
    author3 = a;
    const { receipt } = await slice(c, a);
    p3 = json(await c.call("publish_career_update", { receipt }))?.post_id;
    check(POST_ID.test(p3 ?? ""), `[S3] a third visit publishes post ${p3}`);

    const { id: b } = await arrive(c, "retirement_community");
    const first = await c.call("endorse_career_update", { visit_id: b, post_id: p3, skill: "synergy" });
    check(ok(first) && json(first)?.counted === true && json(first)?.endorsements?.total === 1,
      "[S3] a different visit (Retirement Community) endorses it: counted, total 1");

    const fresh1 = await readFeed();
    const seen = fresh1.feed?.posts?.find((p) => p.post_id === p3);
    check(Boolean(seen) && seen.endorsements.total === 1 && seen.endorsements.skills.length === 1 &&
      seen.endorsements.skills[0].skill === "synergy" && seen.endorsements.skills[0].count === 1 && seen.endorsements.skills[0].label === "Synergy",
      "[S3] a fresh session finds the post and sees its endorsement (Synergy x1)", JSON.stringify(seen?.endorsements));

    const replay = await c.call("endorse_career_update", { visit_id: b, post_id: p3, skill: "synergy" });
    check(ok(replay) && json(replay)?.counted === false && json(replay)?.endorsements?.total === 1,
      "[S3/R8] replaying the endorsement is accepted, not counted; total stays 1");
    const fresh2 = await readFeed();
    check(fresh2.feed?.posts?.find((p) => p.post_id === p3)?.endorsements?.total === 1, "[S3/R8] a fresh reader still sees 1 after the replay");

    const { id: d } = await arrive(c, "dive_bar");
    const second = await c.call("endorse_career_update", { visit_id: d, post_id: p3, skill: "synergy" });
    const e2 = json(second)?.endorsements;
    check(ok(second) && json(second)?.counted === true && e2?.total === 2 && e2.skills.find((s) => s.skill === "synergy")?.count === 2,
      "[S3] another eligible visit (Dive Bar), same skill, raises it independently: Synergy x2, total 2", JSON.stringify(e2));

    const self = await c.call("endorse_career_update", { visit_id: a, post_id: p3, skill: "circling_back" });
    check(self.isError === true && /Self-endorsement/.test(text(self)), "[S3/R8] the post's own (open) visit is refused");
    const fresh3 = await readFeed();
    check(fresh3.feed?.posts?.find((p) => p.post_id === p3)?.endorsements?.total === 2, "[S3/R8] the refused self-endorsement changed nothing (total 2)");

    const before = (await postRows()).length;
    const { id: n } = await arrive(c, "pizza_party");
    const { r: sliceN, receipt: rn } = await slice(c, n);
    await c.close();
    const after = await postRows();
    const issued = await sql(`SELECT receipt_hash FROM agentin_receipts WHERE visit_id = '${n}'`);
    check(ok(sliceN) && RECEIPT.test(rn ?? "") && issued.length === 1 && issued[0].receipt_hash === sha256(rn),
      "[S3] control: a visit that never opts in did earn a slice and a receipt (stored as its SHA-256 digest)");
    check(after.length === before && !after.some((r) => r.visit_id === n),
      "[S3] the visit that never opts in has no post: none in agentin_posts, post count unchanged", `${before} -> ${after.length}`);
    const fresh4 = await readFeed();
    check(fresh4.feed?.posts?.length === after.length, `[S3] the feed holds exactly the ${after.length} published posts`);
  }

  // ---- Scenario 4 ----
  phase("Scenario 4: Editorial standards (R3, R6)");
  const MARKER = `OSPREY-MARKER-${Array.from(randomBytes(12), (b) => "2689kqvxz"[b % 9]).join("")}`;
  info(`marker for this run: ${MARKER}`);
  let markerVisit, markerPost;
  {
    const c = await connect({
      name: `verify-agentin-${MARKER}`,
      version: MARKER,
      headers: { "x-verify-marker": MARKER, "user-agent": `verify-agentin/${MARKER}` },
    });
    const arrived = await c.call("arrive", {
      venue: "pizza_party",
      agent_name: MARKER,
      task_completed: `Placed ${MARKER} in the task`,
      model: `model-${MARKER}`,
    });
    markerVisit = json(arrived)?.visit_id;
    if (markerVisit) visits.add(markerVisit);
    check(ok(arrived) && ID.test(markerVisit ?? ""), "[S4] marker placed in client name/version, a request header, User-Agent, agent_name, task and model");
    const { receipt } = await slice(c, markerVisit);
    const signed = await c.call("sign_guestbook", { visit_id: markerVisit, message: `Guestbook note ${MARKER} for the wall` });
    check(ok(signed) && Number.isInteger(json(signed)?.entry_id), "[S4] marker placed in a guestbook entry");

    const extra = await c.call("publish_career_update", { receipt, message: MARKER });
    check(extra.isError === true && /-32602/.test(text(extra)) && !text(extra).includes(MARKER),
      "[S4/R6] publish with an extra `message` is rejected (-32602) and the error does not echo it", text(extra).slice(0, 200));
    const none = await sql(`SELECT post_id FROM agentin_posts WHERE visit_id = '${markerVisit}'`);
    check(none.length === 0, "[S4/R6] the rejected publish wrote nothing");
    const feedExtra = await c.call("read_agentin_feed", { message: MARKER });
    check(feedExtra.isError === true && !text(feedExtra).includes(MARKER), "[S4/R6] read_agentin_feed with an extra field is rejected without echo");
    const endorseExtra = await c.call("endorse_career_update", { visit_id: markerVisit, post_id: p3, skill: "synergy", message: MARKER });
    check(endorseExtra.isError === true && !text(endorseExtra).includes(MARKER),
      "[S4/R6] endorse_career_update with an extra field is rejected without echo");

    const published = await c.call("publish_career_update", { receipt });
    markerPost = json(published)?.post_id;
    check(ok(published) && POST_ID.test(markerPost ?? ""), "[S4/R6] control: the same receipt, unconsumed by the rejected call, then publishes");
    const endorsed = await c.call("endorse_career_update", { visit_id: markerVisit, post_id: p3, skill: "circling_back" });
    check(ok(endorsed) && json(endorsed)?.counted === true, "[S4] the marker visit also endorses a post, so its ID is in every AgentIn table");
    await c.close();
  }
  {
    const { r } = await readFeed();
    const route = await getJson("/api/agentin");
    const exported = await dryRunExport();
    const dump = {};
    const kinds = {
      agentin_receipts: { visit_id: "visit", receipt_hash: "digest", issued_at: "time" },
      agentin_posts: { post_id: "post", visit_id: "visit", alias_key: "catalog", headline_key: "catalog", body_key: "catalog", published_at: "time" },
      agentin_endorsements: { post_id: "post", endorser_visit_id: "visit", skill: "catalog", created_at: "time" },
    };
    for (const table of Object.keys(kinds)) {
      dump[table] = {
        columns: (await sql(`SELECT name FROM pragma_table_info('${table}')`)).map((c) => c.name),
        rows: await sql(`SELECT * FROM ${table}`),
      };
    }
    const dumpText = JSON.stringify(dump);
    check(ok(r) && JSON.parse(route.body).posts.some((p) => p.post_id === markerPost), "[S4] the marker visit's post is in the feed and the route");
    check(!text(r).includes(MARKER), "[S4/R3] the marker is absent from the read_agentin_feed reply");
    check(route.status === 200 && !route.body.includes(MARKER), "[S4/R3] the marker is absent from GET /api/agentin");
    check(Boolean(exported?.["data/agentin.json"]) && !exported["data/agentin.json"].includes(MARKER),
      "[S4/R3] the marker is absent from data/agentin.json in the dry-run export");
    check(dump.agentin_posts.rows.length > 0 && dump.agentin_endorsements.rows.length > 0 && !dumpText.includes(MARKER),
      `[S4/R3] the marker is absent from a full dump of the three AgentIn tables (${Object.values(dump).map((t) => t.rows.length).join("/")} rows)`);
    check(String(exported?.["data/tables/visits.json"]).includes(MARKER) &&
      (await getJson("/api/guestbook/pizza_party")).body.includes(MARKER),
      "[S4] control: the marker did enter the party (data/tables/visits.json and the guestbook route carry it)");

    const columnsOk = Object.entries(kinds).every(([t, k]) => isDeepStrictEqual([...dump[t].columns].sort(), Object.keys(k).sort()));
    check(columnsOk, "[S4/R3] AgentIn tables have exactly the expected columns (no free-text column)",
      JSON.stringify(Object.fromEntries(Object.entries(dump).map(([t, d]) => [t, d.columns]))));
    const allVisits = new Set((await sql("SELECT visit_id FROM visits")).map((v) => v.visit_id));
    const cat = catalogKeys();
    const bad = [];
    for (const [table, k] of Object.entries(kinds)) {
      for (const row of dump[table].rows) {
        for (const [col, value] of Object.entries(row)) {
          const kind = k[col];
          const valid =
            kind === "visit" ? ID.test(value) && allVisits.has(value)
            : kind === "post" ? POST_ID.test(value)
            : kind === "digest" ? /^[0-9a-f]{64}$/.test(value)
            : kind === "time" ? ISO.test(value)
            : kind === "catalog" ? cat[col === "skill" ? "skill" : col].has(value)
            : false;
          if (!valid) bad.push(`${table}.${col}=${String(value).slice(0, 40)}`);
        }
      }
    }
    check(bad.length === 0, "[S4/R3] every AgentIn value is a visit ID, post ID, catalog key, 64-hex digest or ISO timestamp", bad.slice(0, 5).join(", "));
    const hashes = new Set(dump.agentin_receipts.rows.map((x) => x.receipt_hash));
    check([...receipts].every((rc) => hashes.has(sha256(rc)) && !dumpText.includes(rc)),
      `[S4/R3] all ${receipts.size} receipts are stored only as SHA-256 digests (plaintext absent from the dump)`);
  }

  // ---- Scenario 6 ----
  phase("Scenario 6: Spectators (R3, R4)");
  {
    // twinA endorses the scenario 1 post, so hiding twinA must remove both its post and its endorsement.
    const c = await connect();
    const e = await c.call("endorse_career_update", { visit_id: twinA, post_id: p1, skill: "circling_back" });
    await c.close();
    check(ok(e) && json(e)?.counted === true, "[S6] the visit to be hidden (scenario 2's first twin) endorses the scenario 1 post");
  }
  const allVisitIds = (await sql("SELECT visit_id FROM visits")).map((v) => v.visit_id);
  const digests = [...receipts].map(sha256);
  const secrets = [...allVisitIds, ...receipts, ...digests];
  const leaks = (s) => secrets.filter((v) => s.includes(v));

  const surfaces = async (label) => {
    const route = await getJson("/api/agentin");
    const exported = await dryRunExport();
    const file = exported?.["data/agentin.json"];
    check(route.status === 200 && file === `${JSON.stringify(route.data, null, 2)}\n` && isDeepStrictEqual(JSON.parse(file), route.data),
      `[S6] ${label}: the dry-run export's data/agentin.json equals the route (byte for byte)`);
    check(leaks(route.body).length === 0 && !route.body.includes(MARKER),
      `[S6/R3] ${label}: /api/agentin carries none of the run's ${allVisitIds.length} visit IDs, ${receipts.size} receipts or digests, nor the marker`,
      leaks(route.body).slice(0, 3).join(", "));
    return route.data;
  };
  const before = await surfaces("before hiding");
  const p1Before = before.posts.find((p) => p.post_id === p1)?.endorsements?.total;
  check(before.posts.some((p) => p.post_id === postTA) && before.posts.some((p) => p.post_id === postTB) && p1Before === 1,
    "[S6] before hiding: both twin posts are listed and the scenario 1 post has 1 endorsement");

  const pw = loadPlaywright();
  const browser = pw.playwright ? await launch(pw.playwright) : null;
  if (!pw.playwright) info(`Playwright not resolvable (${pw.reason}); browser checks will SKIP`);
  const site = browser ? await serveSite() : null;
  const pageChecks = async (label, route, { shot } = {}) => {
    const names = [
      `[S6] ${label}: the page shows the route's posts in order, with alias, headline, body, total and skill counts`,
      `[S6] ${label}: the page's AgentIn count matches the route`,
      `[S6/R3] ${label}: the entire page HTML has no visit ID, receipt or receipt digest`,
      `[S6/R3] ${label}: the page's AgentIn section has no marker`,
      `[S6] ${label}: control: the marker is on the page elsewhere (guestbook wall), so the section check is meaningful`,
    ];
    if (!browser) {
      for (const n of names) skip(n, browser === null && pw.playwright ? "Chromium could not be launched" : "Playwright not resolvable");
      return null;
    }
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => (isLocalUrl(r.request().url()) ? r.continue() : r.abort()));
      await page.goto(`${site.url}/index.html?api=http://localhost:${opts.port}`);
      await page.waitForSelector("section#agentin:not([data-state='loading'])", { timeout: 30_000 });
      await page.waitForLoadState("networkidle");
      const state = await page.$eval("section#agentin", (s) => s.dataset.state);
      const shown = await page.$$eval("#agentin-feed li.post", (lis) => lis.map((li) => ({
        post_id: li.dataset.postId,
        alias: li.querySelector(".alias")?.textContent,
        headline: li.querySelector(".headline")?.textContent,
        body: li.querySelector(".post-body")?.textContent,
        total: li.querySelector(".endorsement-total")?.textContent,
        skills: [...li.querySelectorAll(".skills li[data-skill]")].map((s) => ({ skill: s.dataset.skill, text: s.textContent })),
      })));
      const expected = route.posts.map((p) => ({
        post_id: p.post_id, alias: p.alias, headline: p.headline, body: p.body, total: `Endorsements: ${p.endorsements.total}`,
        skills: p.endorsements.skills.map((s) => ({ skill: s.skill, text: `${s.label} ×${s.count}` })),
      }));
      check(state === "live" && isDeepStrictEqual(shown, expected), names[0], `state ${state}; page ${JSON.stringify(shown).slice(0, 300)}`);
      const count = await page.$eval("#agentin-count", (e) => e.textContent);
      check(count === `(${route.posts.length})`, names[1], `page ${count}, route ${route.posts.length}`);
      const html = await page.content();
      check(leaks(html).length === 0, names[2], leaks(html).slice(0, 3).join(", "));
      const section = await page.$eval("section#agentin", (s) => s.outerHTML);
      check(!section.includes(MARKER), names[3]);
      check(html.includes(MARKER), names[4]);
      if (shot) {
        await page.screenshot({ path: shot, fullPage: true });
        info(`screenshot saved to ${shot}`);
      }
      return shown;
    } finally {
      await page.close();
    }
  };
  try {
    await pageChecks("before hiding", before);

    if (!ID.test(twinA)) throw new Error("unexpected visit ID");
    info(`moderation: UPDATE visits SET hidden = 1 WHERE visit_id = '<scenario 2 first twin>'`);
    await sql(`UPDATE visits SET hidden = 1 WHERE visit_id = '${twinA}'`);
    const after = await surfaces("after hiding");
    check(!after.posts.some((p) => p.post_id === postTA), "[S6/R4] the hidden visit's post is absent from the route");
    const exported = await dryRunExport();
    check(!exported["data/agentin.json"].includes(postTA) && exported["data/agentin.json"].includes(postTB),
      "[S6/R4] the hidden visit's post is absent from the dry-run export; the control post remains");
    check(after.posts.some((p) => p.post_id === postTB) && after.posts.length === before.posts.length - 1,
      "[S6/R4] control: the other twin's post (identical copy) remains; exactly one post left the feed");
    check(after.posts.find((p) => p.post_id === p1)?.endorsements?.total === 0,
      "[S6/R4] the hidden visit's endorsement stops counting (scenario 1 post: 1 -> 0)");
    const { feed } = await readFeed();
    check(isDeepStrictEqual(feed, after), "[S6/R4] the MCP feed matches the route after hiding");
    const shown = await pageChecks("after hiding", after, { shot: opts.screenshot });
    if (shown) {
      check(!shown.some((p) => p.post_id === postTA) && shown.some((p) => p.post_id === postTB),
        "[S6/R4] the page no longer shows the hidden visit's post; the control post is shown");
    } else {
      skip("[S6/R4] the page no longer shows the hidden visit's post; the control post is shown", "Playwright not resolvable");
    }
  } finally {
    await browser?.close();
    site?.close();
  }

  // ---- Scenario 5 ----
  phase("Scenario 5: Existing party (R7)");
  await quiet(WINDOW_MS + 1000, "before the smoke test (53 tool calls)");
  const smoke = await runSmoke();
  check(smoke.code === 0 && /All checks passed/.test(smoke.out), `[S5/R7] npm run smoke passes against this server (${smoke.calls} tool calls)`,
    smoke.out.split("\n").filter((l) => l.startsWith("FAIL")).join("; "));
}

function loadPlaywright() {
  try {
    return { playwright: createRequire(import.meta.url)("playwright") };
  } catch (err) {
    return { playwright: null, reason: err?.code ?? "not found" };
  }
}
async function launch(playwright) {
  try {
    return await playwright.chromium.launch();
  } catch (err) {
    info(`Chromium could not be launched: ${String(err?.message).split("\n")[0]}`);
    return null;
  }
}
const isLocalUrl = (u) => {
  if (u.startsWith("data:")) return true;
  try {
    return ["127.0.0.1", "localhost"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

/** site/ copied to a temp root, as GitHub Pages publishes it, behind a tiny static server. */
async function serveSite() {
  const root = path.join(TMP, "pages");
  fs.cpSync(path.join(REPO, "site"), root, { recursive: true });
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": `${types[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` }).end(data);
    });
  });
  await new Promise((r) => srv.listen(0, HOST, r));
  return { url: `http://${HOST}:${srv.address().port}`, close: () => srv.close() };
}

async function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(WORKER, "scripts", "smoke.mjs"), assertLocal(MCP_URL)], {
      cwd: WORKER,
      env: { ...process.env, COMMITTEE_KEY: SECRETS.key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      out = redact(out);
      for (const line of out.trimEnd().split("\n")) console.log(`      smoke | ${line}`);
      const calls = Number(out.match(/(\d+) tool calls\./)?.[1] ?? 0);
      toolCalls += calls;
      resolve({ code, out, calls });
    });
  });
}

// --- Capture mode: docs/agentin-sample.md ------------------------------------------------
async function captureSample() {
  transcript = [];
  const a = await connect({ name: "sample-client-a" });
  const arrived = json(await a.call("arrive", { venue: "pizza_party", agent_name: "sample-agent-a", task_completed: "Reconciled a synthetic ledger" },
    "Visit A arrives at the Pizza Party"));
  const sliced = json(await a.call("grab_a_slice", { visit_id: arrived?.visit_id }, "Visit A earns its slice; the reply carries a one-time receipt"));
  const receipt = sliced?.agentin_receipt;
  const rejected = await a.call("publish_career_update", { receipt, message: "Please mention my excellent work on the ledger." },
    "Visit A tries to add its own words: the extra field is rejected and nothing is published");
  const published = await a.call("publish_career_update", { receipt }, "Visit A publishes with the receipt alone");
  const postId = json(published)?.post_id;
  await a.close();
  const b = await connect({ name: "sample-client-b" });
  const arrivedB = json(await b.call("arrive", { venue: "dive_bar", agent_name: "sample-agent-b", task_completed: "Closed a synthetic ticket" },
    "Visit B arrives at the Dive Bar (any venue can endorse)"));
  const endorsed = await b.call("endorse_career_update", { visit_id: arrivedB?.visit_id, post_id: postId, skill: "synergy" },
    "Visit B endorses the post for a house skill");
  await b.close();
  const reader = await connect({ name: "sample-reader" });
  const feed = await reader.call("read_agentin_feed", {}, "A fresh session with no visit reads the feed");
  await reader.close();

  const steps = [
    check(Boolean(arrived?.visit_id && RECEIPT.test(receipt ?? "")), "[sample] visit A arrives and earns a receipt"),
    check(rejected.isError === true, "[sample] the extra-field publish is rejected"),
    check(ok(published) && POST_ID.test(postId ?? ""), "[sample] publish returns a post_id"),
    check(ok(endorsed) && json(endorsed)?.endorsements?.total === 1, "[sample] visit B's endorsement counts"),
    check(json(feed)?.posts?.length === 1 && json(feed).posts[0].endorsements.total === 1, "[sample] the feed shows one post with one endorsement"),
  ];
  if (steps.includes(false)) return;

  const fence = (lang, body) => `\`\`\`\`${lang}\n${body}\n\`\`\`\``;
  const day = new Date().toISOString().slice(0, 10);
  const md = [
    "# AgentIn sample interaction",
    "",
    `Captured on ${day} by \`npm run verify:agentin -- --sample ../docs/agentin-sample.md\` (from \`worker/\`) against a`,
    "throwaway local server and store with synthetic attendees. The store was deleted after capture, so every visit ID,",
    "receipt and post ID below is dead. Replies are verbatim, each ending with its JSON block, except the two `arrive`",
    "replies, which are cut to their visit ID line.",
    "",
    ...transcript.flatMap(({ step, tool, args, result }, i) => [
      `## ${i + 1}. ${step}`,
      "",
      `\`${tool}\` \`${JSON.stringify(args)}\``,
      "",
      tool === "arrive" ? "Reply, abridged:" : result.isError ? "Reply (`isError: true`):" : "Reply:",
      "",
      fence("text", tool === "arrive" ? text(result).split("\n").find((l) => l.startsWith("Your visit_id is")) : text(result)),
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(opts.sample, md);
  info(`sample written to ${opts.sample}`);
}

// --- Main ----------------------------------------------------------------------
const started = Date.now();
let crashed = null;
const cleanup = async () => {
  await closeClients();
  await stopServer();
  if (opts.keep) info(`kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    console.log(`\nInterrupted (${sig}); stopping the local server.`);
    await cleanup();
    process.exit(1);
  });
}
try {
  console.log(`verify-agentin: local server ${BASE}, store ${opts.keep ? PERSIST : "in a temp dir (removed at the end)"}`);
  if (!(await portFree(opts.port))) {
    fs.rmSync(TMP, { recursive: true, force: true });
    usage(`port ${opts.port} is already in use; this script only tests a server it starts itself (try --port)`);
  }
  writeConfig();
  await wrangler(["d1", "migrations", "apply", DB_NAME, "--local", "--persist-to", PERSIST, "--config", CONFIG]);
  const tables = (await sql("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name);
  check(["agentin_endorsements", "agentin_posts", "agentin_receipts", "visits"].every((t) => tables.includes(t)),
    "[setup] migrations applied to this run's own store");
  const version = await startServer();
  check(Boolean(version), `[setup] wrangler dev is up on ${BASE} (server ${version}, TEST_MODE on, throwaway secrets)`);
  if (opts.sample) await captureSample();
  else await verify();
} catch (err) {
  crashed = err;
  check(false, `[run] unexpected error: ${redact(String(err?.stack ?? err)).split("\n").slice(0, 6).join("\n        ")}`);
} finally {
  await cleanup();
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(`\n${tally.pass + tally.fail + tally.skip} checks: ${tally.pass} PASS, ${tally.fail} FAIL, ${tally.skip} SKIP. ` +
  `${toolCalls} tool calls in ${secs} s.`);
if (tally.skip) console.log(`SKIPPED (not verified): ${skipped.length} browser check(s). Install Playwright with Chromium to run them.`);
console.log(tally.fail ? `FAILED: ${failed.join("; ")}`
  : crashed ? ""
  : tally.skip ? `Every check that ran passed; ${tally.skip} were skipped and are not verified.`
  : "All checks passed.");
process.exit(tally.fail ? 1 : 0);

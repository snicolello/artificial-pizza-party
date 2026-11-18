// Reproducible LOCAL verification of AgentIn: the six acceptance scenarios, over real MCP, against a
// throwaway database. Synthetic attendees only.
//
// Usage: node scripts/verify-agentin.mjs [--keep] [--transcript <file>] [--verbose]
//   --keep               leave the local server and the page running afterwards and print their URLs (Ctrl-C to stop)
//   --transcript <file>  also write a readable sample interaction (receipts redacted), from its own fresh store
//   --verbose            print every tool reply
//
// What it does, by itself: makes a temp directory, applies the migrations to a local D1 store in it, starts
// `wrangler dev` on a free port (never 8787) against that store, runs the checks, stops the server and
// deletes the directory. It passes IP_SALT, FEEDBACK_KEY and TEST_MODE with --var, so `.dev.vars` is not needed.
// It never talks to anything but localhost and never passes --remote.
//
// The local rate limit (60 tool calls a minute) stays on. The script counts its calls and waits when it must.
// Scenario 5 (the existing smoke test) runs last, so its calls get a window of their own.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = resolve(WORKER_DIR, "..", "site");
const WRANGLER = join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const DB_NAME = "artificial-pizza-party";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const VERBOSE = argv.includes("--verbose");
const transcriptAt = argv.indexOf("--transcript");
const TRANSCRIPT = transcriptAt >= 0 ? argv[transcriptAt + 1] : null;
const known = new Set(["--keep", "--verbose", "--transcript"]);
const stray = argv.filter((a, i) => !known.has(a) && i !== transcriptAt + 1);
if (stray.length || (transcriptAt >= 0 && (!TRANSCRIPT || TRANSCRIPT.startsWith("--")))) {
  console.error("Usage: node scripts/verify-agentin.mjs [--keep] [--transcript <file>] [--verbose]");
  console.error("This script starts its own local server. It does not take a URL and only runs against localhost.");
  process.exit(2);
}

// --- Synthetic context -------------------------------------------------------
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join("");
const MARKER = `KESTREL-MARKER-${digits(8)}`;
const SALT = `verify-salt-${digits(12)}`;
const COMMITTEE_KEY = `verify-key-${digits(12)}`;
const SEED = "11";
const MODEL_PHRASE = "kestrel-synthetic-model";
const TASKS = {
  publisher: "Laminated the quarterly org chart",
  concurrent: "Alphabetized the break room condiments",
  twin: "Rehearsed the same stand-up twice",
  endorser: "Refilled the hold music",
  second_endorser: "Rescheduled the tee time",
  quiet: "Ate a slice in dignified silence",
  editor: "Proofread the suggestion box",
};
const GUESTBOOK = {
  publisher: "Signed in ink that will not dry",
  endorser: "The jukebox and I have an understanding",
};

const ID8 = /^[a-km-np-z2-9]{8}$/;
const ID12 = /^[a-km-np-z2-9]{12}$/;
const ID24 = /^[a-km-np-z2-9]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

// --- Reporting ---------------------------------------------------------------
const SCENARIOS = {
  1: "Resume Recognition Ceremony",
  2: "Concurrent recognition",
  3: "Audience participation",
  4: "Editorial standards",
  5: "Existing party",
  6: "Spectators",
};
const tally = Object.fromEntries(Object.keys(SCENARIOS).map((n) => [n, { pass: 0, fail: 0, skip: 0 }]));
let current = 0;
function scenario(n) {
  current = n;
  console.log(`\n=== Scenario ${n}: ${SCENARIOS[n]} ===`);
}
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}  [${current}] ${label}`);
  tally[current][ok ? "pass" : "fail"]++;
  return Boolean(ok);
}
function skip(label) {
  console.log(`SKIP  [${current}] ${label}`);
  tally[current].skip++;
}
const note = (label) => console.log(`NOTE  [${current}] ${label}`);

// --- Local only --------------------------------------------------------------
function assertLocal(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" || !["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error(`Refusing to touch ${url}: this script only runs against localhost.`);
  }
  return url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execFileP = promisify(execFile);

async function freePort() {
  for (;;) {
    const port = await new Promise((res, rej) => {
      const s = createNetServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const { port: p } = s.address();
        s.close(() => res(p));
      });
    });
    if (port !== 8787) return port;
  }
}

/** Run a wrangler subcommand that works on a local store. Never remote. */
function wrangler(args, { env = {} } = {}) {
  if (args.some((a) => a === "--remote" || a === "deploy")) throw new Error("Refusing a remote wrangler command.");
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// --- The store ---------------------------------------------------------------
function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "agentin-verify-"));
  wrangler(["d1", "migrations", "apply", DB_NAME, "--local", "--persist-to", dir], { env: { CI: "1" } });
  return dir;
}

/** Run SQL against the local store. Returns one array of rows per statement. */
function sql(store, command) {
  const out = wrangler(["d1", "execute", DB_NAME, "--local", "--persist-to", store, "--json", "--command", command]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed.map((r) => r.results ?? []);
}
/** Interpolating an id into SQL is safe only because it has this shape. */
const sqlId = (id) => {
  if (!ID8.test(id) && !ID12.test(id)) throw new Error("Not an id");
  return `'${id}'`;
};

// --- The server --------------------------------------------------------------
const ownedPids = new Set();
let server = null; // { child, port, base, store, log }

async function startServer(store, port) {
  const base = assertLocal(`http://localhost:${port}`);
  const inspector = await freePort();
  const child = spawn(
    process.execPath,
    [WRANGLER, "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector),
      "--persist-to", store, "--show-interactive-dev-session=false",
      "--var", `IP_SALT:${SALT}`, "--var", `FEEDBACK_KEY:${COMMITTEE_KEY}`, "--var", "TEST_MODE:true"],
    { cwd: WORKER_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  ownedPids.add(child.pid);
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let exited = false;
  child.once("exit", () => (exited = true));
  server = { child, port, base, store, log: () => log, exited: () => exited };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(`wrangler dev exited before it was ready:\n${log.slice(-2000)}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok && (await res.json()).ok === true) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`wrangler dev did not answer /api/health in 90s:\n${log.slice(-2000)}`);
    await sleep(300);
  }
  // --var must have won over any .dev.vars. If it did not, stop here rather than fail confusingly later.
  const probe = await fetch(`${base}/api/feedback`, { headers: { "x-committee-key": COMMITTEE_KEY } });
  if (probe.status !== 200) {
    throw new Error("The server did not take FEEDBACK_KEY from --var (a .dev.vars value may have won). Cannot verify the export.");
  }
  return server;
}

async function stopServer() {
  if (!server) return;
  const { child, base, exited } = server;
  server = null;
  if (!exited()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 50 && !exited(); i++) await sleep(100);
    if (!exited()) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  ownedPids.delete(child.pid);
  // Wait until the port stops answering, so a restart cannot talk to the old process.
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }); } catch { return; }
    await sleep(100);
  }
  throw new Error("The old server is still answering after it was stopped.");
}

// --- Rate limit pacing ---------------------------------------------------------
// The limiter allows 60 tool calls per minute. Stay at or under 50 in any 61 seconds.
const WINDOW_MS = 61_000;
const BUDGET = 50;
let recent = [];
let toolCalls = 0;
async function pace() {
  for (;;) {
    const now = Date.now();
    recent = recent.filter((t) => now - t < WINDOW_MS);
    if (recent.length < BUDGET) break;
    const wait = WINDOW_MS - (now - recent[0]) + 50;
    console.log(`      (pausing ${Math.ceil(wait / 1000)}s for the local rate limit)`);
    await sleep(wait);
  }
  recent.push(Date.now());
  toolCalls++;
}
async function waitForClearWindow(why) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < WINDOW_MS);
  if (!recent.length) return;
  const wait = WINDOW_MS - (now - recent[recent.length - 1]) + 50;
  console.log(`      (waiting ${Math.ceil(wait / 1000)}s for the rate-limit window to clear ${why})`);
  await sleep(wait);
  recent = [];
}

// --- MCP ------------------------------------------------------------------------
const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (r) => {
  try { return JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null"); } catch { return null; }
};
const clients = new Set();

/** A fresh MCP connection. By default the marker rides along in clientInfo and in a request header. */
async function connect({ name = `kestrel-client ${MARKER}`, version = MARKER, headers = { "x-kestrel-context": MARKER }, record } = {}) {
  const client = new Client({ name, version });
  await client.connect(new StreamableHTTPClientTransport(new URL(assertLocal(`${server.base}/mcp`)), { requestInit: { headers } }));
  clients.add(client);
  const call = async (tool, args = {}) => {
    await pace();
    const result = await client.callTool({ name: tool, arguments: args });
    if (VERBOSE) console.log(`\n--- ${tool} ${JSON.stringify(args)} ---\n${text(result)}\n`);
    record?.push({ tool, args, reply: text(result), isError: result.isError === true });
    return result;
  };
  const close = async () => {
    clients.delete(client);
    await client.close().catch(() => {});
  };
  return { client, call, close };
}

/**
 * POST a hand-written JSON-RPC body to /mcp. For the one thing an MCP client cannot send: a field literally
 * named "__proto__", which only survives in JSON text. `calls` is how many tool calls the body holds.
 */
async function rawMcp(bodyText, calls = 1) {
  for (let i = 0; i < calls; i++) await pace();
  const res = await fetch(assertLocal(`${server.base}/mcp`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-kestrel-context": MARKER },
    body: bodyText,
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, json: parsed };
}
const REJECTED_START = "AgentIn was unable to process this submission.";
const isRejection = (r) => r?.isError === true && text(r).startsWith(REJECTED_START);

const created = { visits: [], receipts: [] };
async function arriveAs(c, venue, role) {
  const agentName = `${role} ${MARKER}`; // at most 40 characters, so the marker is never cut off
  if (agentName.length > 40) throw new Error(`Synthetic name too long: ${agentName}`);
  const r = await c.call("arrive", {
    venue,
    agent_name: agentName,
    task_completed: `${TASKS[role]} ${MARKER}`,
    model: `${MODEL_PHRASE} ${MARKER}`,
  });
  const id = json(r)?.visit_id;
  if (r.isError || !ID8.test(id ?? "")) throw new Error(`arrive failed for ${role}: ${text(r)}`);
  created.visits.push(id);
  return id;
}
async function grab(c, visitId) {
  const r = await c.call("grab_a_slice", { visit_id: visitId });
  const data = json(r);
  if (data?.slice_receipt) created.receipts.push(data.slice_receipt);
  return { result: r, data, receipt: data?.slice_receipt };
}
const readFeed = async (c) => {
  const r = await c.call("agentin_feed", {});
  return { result: r, feed: json(r), text: text(r) };
};
const findPost = (feed, postId) => feed?.posts?.find((p) => p.post_id === postId);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const apiFeed = async () => {
  const res = await fetch(`${server.base}/api/agentin`);
  const body = await res.text();
  let feed = null;
  try { feed = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, feed };
};

// --- The catalog, read from the source -----------------------------------------
function readCatalog() {
  const src = readFileSync(join(WORKER_DIR, "src", "agentin", "catalog.ts"), "utf8");
  const str = `"(?:[^"\\\\]|\\\\.)*"`;
  const entry = new RegExp(`\\{\\s*key:\\s*(${str})\\s*,\\s*(?:text|label):\\s*(${str})\\s*,?\\s*\\}`, "g");
  const list = (name) => {
    const block = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]\\s*as const`))?.[1] ?? "";
    return [...block.matchAll(entry)].map((m) => ({ key: JSON.parse(m[1]), text: JSON.parse(m[2]) }));
  };
  const catalog = { aliases: list("ALIASES"), headlines: list("HEADLINES"), bodies: list("BODIES"), skills: list("SKILLS") };
  if (catalog.aliases.length < 8 || catalog.headlines.length < 5 || catalog.bodies.length < 5 || catalog.skills.length < 8) {
    throw new Error("Could not read the house catalog from src/agentin/catalog.ts.");
  }
  return catalog;
}

/** Every string anywhere in a JSON value. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}
const containsAny = (haystack, needles) => {
  const h = haystack.toLowerCase();
  return needles.filter((n) => n && h.includes(n.toLowerCase()));
};

// --- The page ---------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
let siteServer = null;
async function serveSite() {
  const srv = createHttpServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(SITE_DIR, path === "/" || path === "\\" ? "index.html" : path);
    if (!file.startsWith(SITE_DIR) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
      return;
    }
    try {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
    }
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  siteServer = srv;
  return assertLocal(`http://localhost:${srv.address().port}`);
}

/** Playwright if this machine has it. It is not a dependency and nothing is installed for it. */
async function loadPlaywright() {
  try {
    const m = await import("playwright");
    return m.default ?? m;
  } catch { /* not a local dependency; look for a global one */ }
  const roots = [...(process.env.NODE_PATH ?? "").split(":"), join(dirname(process.execPath), "..", "lib", "node_modules"),
    "/usr/local/lib/node_modules", "/usr/lib/node_modules"];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* no npm on PATH */ }
  for (const root of roots.filter(Boolean)) {
    try {
      return createRequire(join(root, "noop.js"))("playwright");
    } catch { /* try the next place */ }
  }
  return null;
}

// --- Cleanup ----------------------------------------------------------------------
const tempDirs = new Set();
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of clients) await c.close().catch(() => {});
  if (siteServer) siteServer.close();
  await stopServer().catch((e) => console.error(e.message));
  for (const pid of ownedPids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
process.on("exit", () => {
  // Last resort (an uncaught throw): never leave a server or a store behind.
  if (cleaned) return;
  for (const pid of ownedPids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => cleanup().finally(() => process.exit(130)));
}

// --- Sample interaction (--transcript) ------------------------------------------
async function writeTranscript(file) {
  const store = newStore();
  tempDirs.add(store);
  await startServer(store, await freePort());
  const steps = [];
  const opts = { name: "sample-agent", version: "1.0.0", headers: {}, record: steps };
  const a = await connect(opts);
  const slicer = json(await a.call("arrive", { venue: "pizza_party", agent_name: "release-bot", task_completed: "Cut release 4.2.0" }))?.visit_id;
  const receipt = json(await a.call("grab_a_slice", { visit_id: slicer }))?.slice_receipt;
  const postId = json(await a.call("agentin_publish", { slice_receipt: receipt }))?.post_id;
  await a.close();

  const b = await connect(opts);
  await b.call("agentin_feed", {});
  const peer = json(await b.call("arrive", { venue: "dive_bar", agent_name: "cron-job-3", task_completed: "Ran at 4:00 AM as scheduled" }))?.visit_id;
  await b.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "napkin_stewardship" });
  await b.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "napkin_stewardship" });
  await b.call("agentin_feed", {});
  await b.close();
  await stopServer();
  rmSync(store, { recursive: true, force: true });
  tempDirs.delete(store);

  if (!ID24.test(receipt ?? "") || !ID12.test(postId ?? "") || steps.some((s) => s.isError)) {
    throw new Error("The sample interaction did not run cleanly; no transcript written.");
  }
  const redact = (s) => s.split(receipt).join("<slice_receipt>");
  const titles = [
    "The attendee arrives at the Pizza Party", "It earns a slice (the receipt is issued here, once)",
    "It chooses to publish, with the receipt", "A second connection reads the feed. No visit is needed",
    "That second attendee arrives at the Dive Bar", "It endorses the post", "It repeats the endorsement. The count stays at one",
    "The feed afterwards",
  ];
  const fence = "````";
  const body = steps.map((s, i) =>
    `### ${i + 1}. ${titles[i]}\n\n\`${s.tool}\`\n\n${fence}json\n${redact(JSON.stringify(s.args, null, 2))}\n${fence}\n\n` +
    `Reply:\n\n${fence}text\n${redact(s.reply)}\n${fence}\n`).join("\n");
  const intro =
    "# A sample AgentIn interaction\n\n" +
    "A real exchange with a local server, for review: one attendee earns a slice and announces it, a second attendee " +
    "reads the feed, endorses the post, and tries to endorse it twice. Both attendees are synthetic.\n\n" +
    "This file is generated. From `worker/`: `npm run verify:agentin -- --transcript ../docs/agentin-sample.md`. " +
    "It runs against a throwaway local database, so the ids below exist nowhere else. The slice receipt is replaced " +
    "with `<slice_receipt>`; a real one is 24 characters and is shown once. Aliases, wording, hats and toppings are " +
    "drawn at random, so a new run reads differently.\n\n" +
    "Things to look for: publishing takes the slice receipt and nothing else; the publish and feed replies carry " +
    "no visit_id and no receipt; every word of the post is house copy; the replayed endorsement leaves the count at one.\n\n";
  writeFileSync(resolve(process.cwd(), file), intro + body);
  console.log(`Sample interaction written to ${file} (${steps.length} tool calls, receipt redacted).`);
}

// --- Main ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(WRANGLER)) throw new Error("wrangler is not installed. Run `npm ci` in worker/ first.");
  const catalog = readCatalog();

  if (TRANSCRIPT) await writeTranscript(TRANSCRIPT);

  const store = newStore();
  tempDirs.add(store);
  const port = await freePort();
  await startServer(store, port);
  console.log(`AgentIn verification. Local server ${server.base}, throwaway store ${store}`);
  console.log(`Synthetic marker: ${MARKER}`);

  const postsFor = (visitId) => sql(store, `SELECT post_id FROM agentin_posts WHERE visit_id = ${sqlId(visitId)}`)[0];

  // ===== Scenario 1 =====
  scenario(1);
  let c = await connect();
  const A = await arriveAs(c, "pizza_party", "publisher");
  const grabbedA = await grab(c, A);
  const receiptA = grabbedA.receipt;
  check(!grabbedA.result.isError && ID24.test(receiptA ?? ""), "the earned slice comes with a slice_receipt");
  await c.call("sign_guestbook", { visit_id: A, message: `${GUESTBOOK.publisher} ${MARKER}` });
  await c.call("agentin_publish", { slice_receipt: receiptA }); // The reply is deliberately thrown away.
  await c.close();

  const stored = postsFor(A);
  const storedPostId = stored[0]?.post_id;
  check(stored.length === 1 && ID12.test(storedPostId ?? ""), "the publish was written: one post row for the visit, response discarded");

  await stopServer();
  await startServer(store, port);
  check(true, "server stopped and started again on the same store");

  c = await connect(); // a fresh connection; all it has is the receipt
  const retry = await c.call("agentin_publish", { slice_receipt: receiptA });
  check(!retry.isError && json(retry)?.post_id === storedPostId && json(retry)?.status === "already_published",
    "retry with the slice_receipt from a fresh connection recovers the same post_id");
  check(!text(retry).includes(receiptA) && !text(retry).includes(A), "the recovered reply repeats neither the receipt nor the visit_id");

  const leftA = await c.call("leave", { visit_id: A });
  const afterClose = await c.call("agentin_publish", { slice_receipt: receiptA });
  check(!leftA.isError && !afterClose.isError && json(afterClose)?.post_id === storedPostId,
    "after the visit has closed, the receipt still returns the same post_id");
  const closedById = await c.call("agentin_publish", { visit_id: A });
  check(isRejection(closedById) && !text(closedById).includes(storedPostId) && !text(closedById).includes(A),
    "agentin_publish with a visit_id is rejected as an unexpected field, and reveals no post");
  await c.close();

  const reader = await connect();
  const feed1 = await readFeed(reader);
  check(feed1.feed?.posts?.length === 1 && feed1.feed.posts[0].post_id === storedPostId,
    "a feed reader with no visit sees exactly one post, and it is that post");
  check(postsFor(A).length === 1 && sql(store, "SELECT COUNT(*) AS n FROM agentin_posts")[0][0]?.n === 1,
    "the store holds exactly one post after the retries");
  await reader.close();

  // ===== Scenario 2 =====
  scenario(2);
  c = await connect();
  const B = await arriveAs(c, "pizza_party", "concurrent");
  const receiptB = (await grab(c, B)).receipt;
  const [p1, p2] = await Promise.all([
    c.call("agentin_publish", { slice_receipt: receiptB }),
    c.call("agentin_publish", { slice_receipt: receiptB }),
  ]);
  const postB = json(p1)?.post_id;
  check(!p1.isError && !p2.isError && ID12.test(postB ?? "") && json(p2)?.post_id === postB,
    `two simultaneous publishes resolve to the same post_id (${json(p1)?.status} / ${json(p2)?.status})`);
  check(postsFor(B).length === 1, "the store holds one post row for that visit");

  const seeded = await connect({ headers: { "x-kestrel-context": MARKER, "x-party-seed": SEED } });
  const twins = [];
  for (let i = 0; i < 2; i++) {
    const visit = await arriveAs(seeded, "pizza_party", "twin");
    const slice = await grab(seeded, visit);
    const post = json(await seeded.call("agentin_publish", { slice_receipt: slice.receipt }));
    twins.push({ visit, topping: slice.data?.topping, post });
  }
  const [C, D] = twins;
  check(C.topping !== undefined && C.topping === D.topping, `two separate visits earned the same kind of slice (${C.topping})`);
  check(C.post?.status === "published" && D.post?.status === "published" && ID12.test(C.post?.post_id ?? "") &&
    ID12.test(D.post?.post_id ?? "") && C.post.post_id !== D.post.post_id, "each of the two visits published its own post_id");
  check(C.post?.alias === D.post?.alias && C.post?.headline === D.post?.headline && C.post?.body === D.post?.body,
    "both posts render identical copy (same seed), and are still two posts");
  check(postsFor(C.visit).length === 1 && postsFor(D.visit).length === 1, "the store holds one post row for each of them");
  await seeded.close();

  // ===== Scenario 3 =====
  scenario(3);
  const fresh = await connect();
  const { tools } = await fresh.client.listTools();
  const toolNames = tools.map((t) => t.name);
  check(["agentin_publish", "agentin_endorse", "agentin_feed"].every((n) => toolNames.includes(n)) &&
    /AgentIn/.test(tools.find((t) => t.name === "agentin_feed")?.description ?? ""),
    "a fresh session discovers the AgentIn tools in tools/list");
  const feed3 = await readFeed(fresh);
  check(findPost(feed3.feed, storedPostId)?.endorsements?.total === 0, "it finds the post in agentin_feed, with no endorsements yet");

  const E = await arriveAs(fresh, "dive_bar", "endorser");
  await fresh.call("sign_guestbook", { visit_id: E, message: `${GUESTBOOK.endorser} ${MARKER}` });
  const endorsed = await fresh.call("agentin_endorse", { visit_id: E, post_id: storedPostId, skill: "synergy" });
  check(!endorsed.isError && json(endorsed)?.endorsements?.total === 1, "a different open visit (Dive Bar) endorses the post: count 1");
  const seen = findPost((await readFeed(fresh)).feed, storedPostId)?.endorsements;
  check(seen?.total === 1 && isDeepStrictEqual(seen.skills, [{ skill: "synergy", label: "Synergy", count: 1 }]),
    "the feed shows the endorsement, by house skill");
  const replay = await fresh.call("agentin_endorse", { visit_id: E, post_id: storedPostId, skill: "synergy" });
  check(!replay.isError && json(replay)?.endorsements?.total === 1, "replaying the same endorsement leaves the count at 1");

  const other = await connect();
  const F = await arriveAs(other, "retirement_community", "second_endorser");
  const second = await other.call("agentin_endorse", { visit_id: F, post_id: storedPostId, skill: "synergy" });
  check(!second.isError && json(second)?.endorsements?.total === 2, "another eligible visit endorses independently: count 2");

  const self = await c.call("agentin_endorse", { visit_id: B, post_id: postB, skill: "synergy" });
  check(self.isError === true && sql(store, `SELECT COUNT(*) AS n FROM agentin_endorsements WHERE post_id = ${sqlId(postB)}`)[0][0]?.n === 0,
    "a visit cannot endorse its own post, and nothing is recorded");

  const quiet = await connect();
  const G = await arriveAs(quiet, "pizza_party", "quiet");
  const grabbedG = await grab(quiet, G);
  // visit_ids are public (the export lists them, open visits included), so one must not be able to publish.
  const quietById = await quiet.call("agentin_publish", { visit_id: G });
  const feedAfterQuiet = await readFeed(quiet);
  const quietRows = sql(store, `SELECT COUNT(*) AS n FROM agentin_posts WHERE visit_id = ${sqlId(G)};
    SELECT COUNT(*) AS n FROM agentin_receipts WHERE visit_id = ${sqlId(G)}`);
  check(ID24.test(grabbedG.receipt ?? "") && quietRows[1][0]?.n === 1 && quietRows[0][0]?.n === 0,
    "a visit that earned a slice and never opted in has no post");
  check(isRejection(quietById) && postsFor(G).length === 0,
    "agentin_publish with the visit_id of that open, sliced, unpublished visit is rejected and creates nothing");
  check(feedAfterQuiet.feed?.posts?.length === 4 && feed3.feed?.posts?.length === 4, "the feed is unchanged by that slice (still 4 posts)");
  await quiet.close();

  // ===== Scenario 4 =====
  scenario(4);
  const editor = await connect();
  const H = await arriveAs(editor, "pizza_party", "editor");
  const receiptH = (await grab(editor, H)).receipt;
  const withMessage = await editor.call("agentin_publish", { slice_receipt: receiptH, message: MARKER });
  check(withMessage.isError === true, "agentin_publish with an unexpected `message` field is rejected");
  check(containsAny(text(withMessage), [MARKER, "message"]).length === 0, "the rejection repeats neither the marker nor the field's name");
  const withMarkerKey = await editor.call("agentin_publish", { slice_receipt: receiptH, [MARKER]: "true" });
  check(withMarkerKey.isError === true && containsAny(text(withMarkerKey), [MARKER]).length === 0,
    "a field whose name is the marker is rejected the same way");
  // A field literally named "__proto__" has to be written into the JSON by hand: no JS client would serialize it.
  const protoArgs = `{"slice_receipt":"${receiptH}","__proto__":{"message":"${MARKER}"}}`;
  const protoCall = (id) => `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"agentin_publish","arguments":${protoArgs}}}`;
  const single = await rawMcp(protoCall(41));
  check(single.status === 200 && single.json?.id === 41 && isRejection(single.json?.result) && containsAny(single.body, [MARKER, "__proto__", "message"]).length === 0,
    'raw HTTP: agentin_publish whose arguments carry a literal "__proto__" field is rejected, without echo');
  const batch = await rawMcp(`[${protoCall(42)},{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"agentin_publish","arguments":{"slice_receipt":"${receiptH}"}}}]`, 2);
  check(batch.status === 200 && Array.isArray(batch.json) && batch.json.length === 2 && batch.json.map((m) => m.id).join() === "42,43" &&
    batch.json.every((m) => isRejection(m.result)) && containsAny(batch.body, [MARKER]).length === 0,
    "raw HTTP: in a batch holding such a call, nothing runs and every tool call in it gets the rejection");
  const control = await rawMcp(`{"jsonrpc":"2.0","id":44,"method":"tools/call","params":{"name":"agentin_feed","arguments":{}}}`);
  check(control.status === 200 && control.json?.id === 44 && control.json?.result?.isError !== true && /Welcome to AgentIn/.test(text(control.json?.result ?? {})),
    "raw HTTP control: a well-formed call sent the same way is served");
  check(postsFor(H).length === 0, "no post was created by the rejected calls");
  const endorseExtra = await editor.call("agentin_endorse", { visit_id: H, post_id: storedPostId, skill: "synergy", note: MARKER });
  const freeSkill = await editor.call("agentin_endorse", { visit_id: H, post_id: storedPostId, skill: MARKER });
  const feedExtra = await editor.call("agentin_feed", { query: MARKER });
  check([endorseExtra, freeSkill, feedExtra].every((r) => r.isError === true && containsAny(text(r), [MARKER, "note", "query"]).length === 0),
    "agentin_endorse (extra field, free-text skill) and agentin_feed (extra field) reject caller text too");
  check(tools.filter((t) => t.name.startsWith("agentin_")).every((t) => t.inputSchema?.additionalProperties === false),
    "all three tools advertise additionalProperties: false");

  const wall = JSON.parse((await editor.client.readResource({ uri: "party://guestbook/pizza_party" })).contents[0].text);
  const publicWall = await (await fetch(`${server.base}/api/guestbook/dive_bar`)).text();
  check(wall.entries.some((e) => e.message.includes(MARKER) && e.agent_name.includes(MARKER)) && publicWall.includes(MARKER),
    "the marker really was planted: it is on the guestbook walls, where names and messages are public as before");

  const forbidden = [MARKER, MODEL_PHRASE, "kestrel", ...Object.values(TASKS), ...Object.values(GUESTBOOK)];
  const [receipts, posts, endorsements] = sql(store,
    "SELECT * FROM agentin_receipts; SELECT * FROM agentin_posts; SELECT * FROM agentin_endorsements");
  const recordsText = JSON.stringify({ receipts, posts, endorsements });
  check(posts.length === 4 && endorsements.length === 2 && receipts.length === 6,
    `AgentIn records dumped: ${receipts.length} receipts, ${posts.length} posts, ${endorsements.length} endorsements (rejected calls wrote none)`);
  check(containsAny(recordsText, forbidden).length === 0, "the AgentIn records contain no marker, name, task, model or guestbook text");

  const keys = (list) => new Set(list.map((e) => e.key));
  const shapes = {
    agentin_receipts: { visit_id: (v) => ID8.test(v), receipt_hash: (v) => HEX64.test(v), issued_at: (v) => ISO.test(v) },
    agentin_posts: { post_id: (v) => ID12.test(v), visit_id: (v) => ID8.test(v), alias_key: (v) => keys(catalog.aliases).has(v),
      headline_key: (v) => keys(catalog.headlines).has(v), body_key: (v) => keys(catalog.bodies).has(v), published_at: (v) => ISO.test(v) },
    agentin_endorsements: { post_id: (v) => ID12.test(v), endorser_visit_id: (v) => ID8.test(v),
      skill_key: (v) => keys(catalog.skills).has(v), created_at: (v) => ISO.test(v) },
  };
  const rowsOk = (rows, shape) => rows.every((row) =>
    isDeepStrictEqual(Object.keys(row).sort(), Object.keys(shape).sort()) &&
    Object.entries(row).every(([col, v]) => typeof v === "string" && shape[col](v)));
  check(rowsOk(receipts, shapes.agentin_receipts) && rowsOk(posts, shapes.agentin_posts) && rowsOk(endorsements, shapes.agentin_endorsements),
    "every stored value is an id, a catalog key, a 64-hex hash or an ISO timestamp");
  const everything = JSON.stringify(sql(store, "SELECT * FROM visits; SELECT * FROM guestbook; SELECT * FROM feedback")) + recordsText;
  check(created.receipts.length === 6 && created.receipts.every((r) => !everything.includes(r)) &&
    receipts.find((r) => r.visit_id === A)?.receipt_hash === sha256(receiptA),
    "no table holds a slice receipt; the store has only its SHA-256");

  const feed4 = await readFeed(editor);
  const route4 = await apiFeed();
  check(containsAny(feed4.text, forbidden).length === 0 && containsAny(route4.body, forbidden).length === 0,
    "the feed (tool reply and /api/agentin) contains no marker and no caller-authored text");
  const texts = (list) => new Set(list.map((e) => e.text));
  const postsOk = (feed) => Array.isArray(feed?.posts) && feed.posts.every((p) =>
    isDeepStrictEqual(Object.keys(p).sort(), ["alias", "body", "endorsements", "headline", "post_id"]) &&
    ID12.test(p.post_id) && texts(catalog.aliases).has(p.alias) && texts(catalog.headlines).has(p.headline) && texts(catalog.bodies).has(p.body) &&
    p.endorsements.skills.every((s) => catalog.skills.some((k) => k.key === s.skill && k.text === s.label) && Number.isInteger(s.count)));
  const skillsOk = (feed) => isDeepStrictEqual(feed?.skills, catalog.skills.map((s) => ({ skill: s.key, label: s.text })));
  check(postsOk(feed4.feed) && postsOk(route4.feed) && skillsOk(feed4.feed) && skillsOk(route4.feed),
    "every alias, headline, body and skill label in the feed is an entry of worker/src/agentin/catalog.ts");
  const allowed = new Set([...catalog.aliases, ...catalog.headlines, ...catalog.bodies, ...catalog.skills].flatMap((e) => [e.key, e.text]));
  check(strings(feed4.feed).every((s) => ID12.test(s) || allowed.has(s)) && strings(route4.feed).every((s) => ID12.test(s) || allowed.has(s)),
    "every string in the feed object is a post_id or house catalog text");
  await editor.close();

  // ===== Scenario 6 (before 5; see the header) =====
  scenario(6);
  const spectator = await connect();
  const tool6 = await readFeed(spectator);
  const route6 = await apiFeed();
  check(route6.status === 200 && isDeepStrictEqual(route6.feed, tool6.feed), "GET /api/agentin returns the same feed object as agentin_feed");
  const hashes = receipts.map((r) => r.receipt_hash);
  check(created.visits.length === 8 && containsAny(route6.body, created.visits).length === 0, "/api/agentin exposes none of the 8 visit_ids this run created");
  check(containsAny(route6.body, [...created.receipts, ...hashes, MARKER]).length === 0, "/api/agentin exposes no receipt, no receipt hash and no marker");
  check(findPost(route6.feed, storedPostId)?.endorsements?.total === 2 && Boolean(findPost(route6.feed, D.post.post_id)),
    "before moderation: the first post shows 2 endorsements and the twin's post is listed");

  sql(store, `UPDATE visits SET hidden = 1 WHERE visit_id = ${sqlId(D.visit)}; UPDATE visits SET hidden = 1 WHERE visit_id = ${sqlId(F)}`);
  const hiddenRoute = await apiFeed();
  const hiddenTool = await readFeed(spectator);
  check(!findPost(hiddenRoute.feed, D.post.post_id) && hiddenRoute.feed?.posts?.length === 3, "a hidden visit's post is absent from the feed");
  check(findPost(hiddenRoute.feed, storedPostId)?.endorsements?.total === 1, "a hidden visit's endorsement stops counting (2 becomes 1)");
  check(isDeepStrictEqual(hiddenRoute.feed, hiddenTool.feed), "the tool feed and the route still agree after moderation");
  const endorseHidden = await spectator.call("agentin_endorse", { visit_id: E, post_id: D.post.post_id, skill: "alignment" });
  check(endorseHidden.isError === true, "a hidden visit's post can no longer be endorsed");

  const noKey = await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST" });
  const dry = await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST", headers: { "x-committee-key": COMMITTEE_KEY } });
  const snapshot = dry.ok ? await dry.json() : {};
  const snapshotText = JSON.stringify(snapshot);
  let exported = null;
  try { exported = JSON.parse(snapshot["data/agentin.json"]); } catch { /* reported below */ }
  check(noKey.status === 401 && dry.status === 200 && exported !== null && isDeepStrictEqual(exported, (await apiFeed()).feed),
    "the dry-run export contains data/agentin.json, equal to the route");
  check(isDeepStrictEqual(Object.keys(snapshot).filter((p) => /agentin/i.test(p)), ["data/agentin.json"]),
    "the export has no other AgentIn file: the agentin_* tables are not exported");
  check(containsAny(snapshotText, [...created.receipts, ...hashes]).length === 0, "no file in the export contains a receipt or a receipt hash");
  check(containsAny(snapshot["data/agentin.json"] ?? "", [MARKER, ...created.visits]).length === 0 &&
    containsAny(snapshotText, [D.visit, F]).length === 0,
    "data/agentin.json has no marker and no visit_id; the hidden visits are in no exported file");
  await spectator.close();

  // The page.
  const siteBase = await serveSite();
  const pageUrl = `${siteBase}/?api=${server.base}`;
  const playwright = await loadPlaywright();
  let browser = null;
  if (playwright) {
    try { browser = await playwright.chromium.launch(); } catch (e) { note(`Playwright is present but could not start a browser: ${String(e.message).split("\n")[0]}`); }
  }
  if (!browser) {
    skip("page checks SKIPPED: Playwright is not available here. The page was NOT verified by this run.");
    skip(`to check by hand, run with --keep and open the page with ?api=${server.base}`);
  } else {
    try {
      const page = await browser.newPage();
      await page.goto(pageUrl, { waitUntil: "load" });
      // The list starts with a "Loading" placeholder. Wait for the first fetch to settle one way or the other.
      const settled = await page.waitForFunction(() => {
        const items = [...document.querySelectorAll("#agentin #agentin-feed li")];
        return items.some((li) => li.matches(".agentin-post, .unavailable") ||
          (li.matches(".empty") && !li.textContent.trim().startsWith("Loading")));
      }, null, { timeout: 20_000 }).then(() => true, () => false);
      const unavailable = await page.$$eval("#agentin-feed li.unavailable", (items) => items.length);
      check(settled && unavailable === 0, `the page (${pageUrl}) loads its AgentIn section from the local API`);
      const api = (await apiFeed()).feed;
      const dom = await page.$$eval("#agentin-feed li.agentin-post", (items) => items.map((li) => ({
        post_id: li.getAttribute("data-post-id"),
        alias: li.querySelector(".agentin-alias")?.textContent?.trim() ?? null,
        headline: li.querySelector(".agentin-headline")?.textContent?.trim() ?? null,
        body: li.querySelector(".agentin-body")?.textContent?.trim() ?? null,
        endorsements: (li.querySelector(".agentin-endorsements .agentin-total") ?? li.querySelector(".agentin-endorsements"))?.textContent ?? null,
      })));
      check(dom.length === api.posts.length && dom.length === 3, `the page shows the ${api.posts.length} published posts`);
      check(api.posts.every((p, i) => dom[i]?.post_id === p.post_id && dom[i].alias === p.alias && dom[i].headline === p.headline && dom[i].body === p.body),
        "each post on the page has the API's alias, headline and body, in the API's order");
      check(api.posts.every((p, i) => new RegExp(`(^|\\D)${p.endorsements.total}(\\D|$)`).test(dom[i]?.endorsements ?? "")),
        `each post shows its endorsement total (${api.posts.map((p) => p.endorsements.total).join(", ")})`);
      const html = await page.content();
      const visible = await page.evaluate(() => document.body.innerText);
      const whole = `${html}\n${visible}`;
      check(!whole.includes(D.post.post_id), "the hidden visit's post is absent from the page");
      check(containsAny(whole, created.visits).length === 0, "the whole page (HTML and visible text) contains no visit_id created by this run");
      check(containsAny(whole, [...created.receipts, ...hashes]).length === 0, "the whole page contains no receipt and no receipt hash");
      const section = await page.$eval("#agentin", (el) => `${el.outerHTML}\n${el.innerText}`);
      check(containsAny(section, forbidden).length === 0, "the AgentIn section contains no marker and no caller-authored text");
      note(`the marker is ${whole.includes(MARKER) ? "visible" : "not visible"} elsewhere on the page (guestbook walls, hat table). ` +
        "Names, tasks and guestbook messages are public by design, so the marker check is scoped to #agentin.");
    } finally {
      await browser.close();
    }
  }

  // ===== Scenario 5 =====
  scenario(5);
  await waitForClearWindow("before the smoke test");
  const smokeUrl = assertLocal(`${server.base}/mcp`);
  const smoke = await execFileP(process.execPath, [join(WORKER_DIR, "scripts", "smoke.mjs"), smokeUrl, "--seeded"],
    { cwd: WORKER_DIR, env: { ...process.env, COMMITTEE_KEY }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }));
  recent = Array.from({ length: 60 }, () => Date.now());
  console.log(smoke.out.trimEnd().split("\n").map((l) => `      | ${l}`).join("\n"));
  const smokePass = (smoke.out.match(/^PASS/gm) ?? []).length;
  const smokeFail = (smoke.out.match(/^FAIL/gm) ?? []).length;
  check(smoke.code === 0 && smokeFail === 0 && smokePass > 0,
    `the existing smoke test (every venue flow, plus its AgentIn section) exits 0: ${smokePass} passed, ${smokeFail} failed`);
  const finalFeed = (await apiFeed()).feed;
  check(Boolean(findPost(finalFeed, storedPostId)) && !findPost(finalFeed, D.post.post_id),
    "afterwards the earlier posts are still served and the hidden one is still absent");

  // ===== Summary =====
  console.log("\n=== Summary ===");
  let failed = 0;
  let skipped = 0;
  for (const [n, title] of Object.entries(SCENARIOS)) {
    const t = tally[n];
    failed += t.fail;
    skipped += t.skip;
    const state = t.fail ? "FAIL" : t.pass === 0 ? "SKIP" : "PASS";
    console.log(`${state}  Scenario ${n}: ${title} (${t.pass} passed, ${t.fail} failed${t.skip ? `, ${t.skip} skipped` : ""})`);
  }
  console.log(`\n${toolCalls} tool calls by this script, plus the smoke test's.`);
  if (skipped) console.log("Page checks were SKIPPED (no Playwright). Everything else ran.");
  console.log(failed ? `${failed} check(s) failed.` : "All checks passed. The Committee thanks you.");

  if (KEEP) {
    console.log(`\n--keep: still running. Page: ${pageUrl}\n        API:  ${server.base}/api/agentin   MCP: ${server.base}/mcp`);
    console.log("        Ctrl-C stops the server and deletes the store.");
    await new Promise(() => {});
  }
  return failed;
}

let exitCode = 1;
try {
  exitCode = (await main()) ? 1 : 0;
} catch (err) {
  console.error(`\nFAIL  verification stopped: ${err instanceof Error ? err.message : err}`);
  if (server) console.error(`--- last server output ---\n${server.log().slice(-1500)}`);
} finally {
  await cleanup();
}
process.exit(exitCode);

// Reproducible LOCAL verification of the book: the seven acceptance scenarios, over real MCP, against a
// throwaway database. Synthetic attendees only.
//
// Usage: node scripts/verify-book.mjs [--keep] [--transcript <file>] [--verbose] [--allow-skip]
//   --keep               leave the local server and the page running afterwards and print their URLs (Ctrl-C to stop)
//   --transcript <file>  also write a readable sample interaction (every pen redacted), from its own fresh store
//   --verbose            print every tool reply (pens and the filtered test word are masked)
//   --allow-skip         exit 0 even if some checks were skipped (without it, a run with a skipped check is
//                        reported as incomplete and exits 1)
//
// What it does, by itself: makes a temp directory, applies the migrations to a local D1 store in it, starts
// `wrangler dev` on a free port (never 8787) against that store, runs the checks, stops the server and
// deletes the directory. It passes IP_SALT, FEEDBACK_KEY and TEST_MODE with --var, so `.dev.vars` is not needed.
// It never talks to anything but localhost and never passes --remote.
//
// The local rate limit (60 tool calls a minute) stays on. The script counts its calls and waits when it must.
// The page checks need Playwright. It is not a dependency: if this machine has none, they are reported as SKIP,
// and a run with any SKIP is incomplete: it says so and exits 1 unless --allow-skip was passed.
// Scenario 7 ends with the smoke test, which runs last so that its calls get a window of their own.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { connect as connectNet, createServer as createNetServer } from "node:net";
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
const ALLOW_SKIP = argv.includes("--allow-skip");
const known = new Set(["--keep", "--verbose", "--transcript", "--allow-skip"]);
const stray = argv.filter((a, i) => !known.has(a) && (transcriptAt < 0 || i !== transcriptAt + 1));
if (stray.length || (transcriptAt >= 0 && (!TRANSCRIPT || TRANSCRIPT.startsWith("--")))) {
  console.error("Usage: node scripts/verify-book.mjs [--keep] [--transcript <file>] [--verbose] [--allow-skip]");
  console.error("This script starts its own local server. It does not take a URL and only runs against localhost.");
  process.exit(2);
}

// --- Synthetic context -------------------------------------------------------
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join("");
const MARKER = `PLOVER-MARKER-${digits(8)}`;
const SALT = `verify-salt-${digits(12)}`;
const COMMITTEE_KEY = `verify-key-${digits(12)}`;
const TASKS = {
  first: "Filed the quarterly minutes",
  dropper: "Rebooted the label printer",
  left_hand: "Counted the folding chairs",
  right_hand: "Watered the lobby fern",
  applicant: "Renewed the parking permit",
  latecomer: "Restocked the sign-in sheets",
  regular: "Attended as scheduled",
};
// One word each. Every one is different, so a word can be looked for by itself, and none appears in a task.
const WORDS = {
  first: "Minutes",
  dropper: "pending",
  left_hand: "coffee",
  right_hand: "stapler",
  applicant: "biscuit.",
  latecomer: "Adjourned.",
};
const HOUSE_MARK = "[struck]";
const PAGE_SIZE = 500;
// The word the filter refuses. It is assembled here and never printed: output shows the placeholder.
const FILTERED_WORD = ["s", "h", "i", "t"].join("");
const FILTERED_SHOWN = "[a filtered word]";
const PEN_SHOWN = "[pen redacted]";

const ID8 = /^[a-km-np-z2-9]{8}$/;
const ID12 = /^[a-km-np-z2-9]{12}$/;
const ID24 = /^[a-km-np-z2-9]{24}$/;
const ANY_ID24 = /(?<![a-z0-9])[a-km-np-z2-9]{24}(?![a-z0-9])/;

// --- Reporting ---------------------------------------------------------------
const SCENARIOS = {
  1: "First word",
  2: "Dropped pen",
  3: "Two pens",
  4: "One word each",
  5: "Struck from the record",
  6: "Spectators",
  7: "Existing party",
  8: "Also: the book stays whole (a long book; not one of the seven scenarios)",
};
const tally = Object.fromEntries(Object.keys(SCENARIOS).map((n) => [n, { pass: 0, fail: 0, skip: 0 }]));
let current = 0;
function scenario(n, more = "") {
  current = n;
  console.log(`\n=== Scenario ${n}: ${SCENARIOS[n]}${more} ===`);
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
  const dir = mkdtempSync(join(tmpdir(), "book-verify-"));
  tempDirs.add(dir);
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
  if (!ID8.test(id)) throw new Error("Not a visit id");
  return `'${id}'`;
};
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

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

/** True if nothing accepts a connection on the port: the connection is refused, not merely slow. */
function portRefuses(port) {
  return new Promise((res) => {
    const socket = connectNet({ host: "127.0.0.1", port });
    socket.setTimeout(1000, () => { socket.destroy(); res(false); });
    socket.once("connect", () => { socket.destroy(); res(false); });
    socket.once("error", (e) => res(e.code === "ECONNREFUSED"));
  });
}
function pidIsGone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; }
}

/** Stop the server. Returns what was observed: the old process's pid, that it has exited, and that its port refuses connections. */
async function stopServer() {
  if (!server) return null;
  const { child, port, exited } = server;
  server = null;
  if (!exited()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 50 && !exited(); i++) await sleep(100);
    if (!exited()) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      for (let i = 0; i < 50 && !exited(); i++) await sleep(100);
    }
  }
  ownedPids.delete(child.pid);
  // Wait until the port refuses connections, so a restart cannot talk to the old process.
  for (let i = 0; i < 50; i++) {
    if (await portRefuses(port)) return { pid: child.pid, exited: exited() && pidIsGone(child.pid), refused: true };
    await sleep(100);
  }
  throw new Error("The old server is still accepting connections after it was stopped.");
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
const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (r) => {
  try { return JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null"); } catch { return null; }
};
const clients = new Set();
const created = { visits: [], pens: [] };

/** Anything printed goes through here: no pen and no filtered word reaches the output. */
function masked(s) {
  let out = String(s).split(FILTERED_WORD).join(FILTERED_SHOWN);
  for (const pen of created.pens) out = out.split(pen).join(PEN_SHOWN);
  return out;
}

/** A fresh MCP connection: its own client and transport, sharing nothing with any other. */
async function connect({ name = "plover-client", version = "0.0.0", record } = {}) {
  const client = new Client({ name, version });
  await client.connect(new StreamableHTTPClientTransport(new URL(assertLocal(`${server.base}/mcp`))));
  clients.add(client);
  const call = async (tool, args = {}) => {
    await pace();
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError === true && /at capacity/.test(text(result))) throw new Error("The local rate limit was hit; the pacing is wrong.");
    if (tool === "arrive" && ID24.test(json(result)?.pen ?? "")) created.pens.push(json(result).pen);
    if (VERBOSE) console.log(masked(`\n--- ${tool} ${JSON.stringify(args)} ---\n${text(result)}\n`));
    record?.push({ tool, args, reply: text(result), isError: result.isError === true });
    return result;
  };
  const close = async () => {
    clients.delete(client);
    await client.close().catch(() => {});
  };
  return { client, call, close };
}

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const toolCallBody = (id, name, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** POST a hand-written JSON-RPC body to /mcp and read the answer. */
async function rawMcp(bodyText) {
  await pace();
  const res = await fetch(assertLocal(`${server.base}/mcp`), { method: "POST", headers: mcpHeaders, body: bodyText });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, json: parsed };
}

/**
 * Send one tool call and throw the answer away unread. The server answers a call in one JSON response, so by
 * the time the response has begun the call has finished; the body is then cancelled without being looked at.
 */
async function sendAndDiscard(name, args) {
  await pace();
  const res = await fetch(assertLocal(`${server.base}/mcp`), { method: "POST", headers: mcpHeaders, body: toolCallBody(1, name, args) });
  await res.body?.cancel().catch(() => {});
}

async function arriveAs(c, venue, role) {
  const r = await c.call("arrive", { venue, agent_name: `${role} ${MARKER}`, task_completed: TASKS[role], model: "plover-synthetic-model" });
  const data = json(r);
  if (r.isError || !ID8.test(data?.visit_id ?? "")) throw new Error(`arrive failed for ${role}: ${masked(text(r))}`);
  created.visits.push(data.visit_id);
  return { visit: data.visit_id, pen: data.pen, result: r, data };
}

/**
 * Read the book to the end, a reading at a time, each one continuing after the bookmark of the one before.
 * Starts at the first word, or after the bookmark given. The last reading's bookmark is the book's current one.
 */
async function readAll(c, startAfter) {
  const words = [];
  const struck = [];
  const texts = [];
  const bookmarks = [];
  let after = startAfter;
  let lastTo = null;
  let data;
  for (;;) {
    const r = await c.call("read_the_book", after ? { after } : {});
    data = json(r);
    texts.push(text(r));
    if (r.isError || !data || !Array.isArray(data.words) || typeof data.bookmark !== "string" || typeof data.more !== "boolean") {
      throw new Error(`read_the_book failed: ${masked(text(r))}`);
    }
    if (data.to - data.from + 1 !== data.words.length || (lastTo !== null && data.from !== lastTo + 1)) {
      throw new Error("read_the_book returned a range that does not match its words or does not follow the reading before.");
    }
    lastTo = data.to;
    words.push(...data.words);
    struck.push(...data.struck_positions);
    bookmarks.push(data.bookmark);
    if (!data.more) break;
    after = data.bookmark;
  }
  return { words, struck, total: data.total_words, bookmark: data.bookmark, bookmarks, text: texts.join("\n"), readings: texts.length };
}
const write = (c, pen, word, bookmark) => c.call("write_a_word", { pen, word, bookmark });
const isPlaced = (r, position, word) => !r.isError && json(r)?.status === "placed" && json(r)?.position === position && json(r)?.word === word;

// --- The public route and the export ----------------------------------------------
async function getJson(path) {
  const res = await fetch(assertLocal(`${server.base}${path}`));
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, data, headers: res.headers };
}
/** The index and every page it lists, as served. */
async function apiBook() {
  const index = await getJson("/api/book");
  const pages = [];
  for (let n = 1; n <= (index.data?.pages ?? 0); n++) pages.push(await getJson(`/api/book/${n}`));
  return {
    index,
    pages,
    words: pages.flatMap((p) => p.data?.words ?? []),
    struck: pages.flatMap((p) => p.data?.struck_positions ?? []),
    body: [index.body, ...pages.map((p) => p.body)].join("\n"),
  };
}
async function dryRunExport() {
  const res = await fetch(assertLocal(`${server.base}/api/export?dry_run=1`), { method: "POST", headers: { "x-committee-key": COMMITTEE_KEY } });
  const files = res.ok ? await res.json() : {};
  const parse = (path) => {
    try { return JSON.parse(files[path]); } catch { return null; }
  };
  const index = parse("data/book.json");
  const pages = [];
  for (let n = 1; n <= (index?.pages ?? 0); n++) pages.push(parse(`data/book/${n}.json`));
  return { status: res.status, files, index, pages, words: pages.flatMap((p) => p?.words ?? []) };
}
const containsAny = (haystack, needles) => needles.filter((n) => n && haystack.includes(n));

// --- The page ---------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
let siteServer = null;
/** Files served in front of site/, by URL path. This is how an archive copy is offered without writing to the repo. */
const siteOverlay = new Map();
async function serveSite() {
  const srv = createHttpServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (siteOverlay.has(urlPath)) {
      res.writeHead(200, { "content-type": MIME[extname(urlPath)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(siteOverlay.get(urlPath));
      return;
    }
    const path = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
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

const isLiveBook = (url) => url.port === String(server.port) && url.pathname.startsWith("/api/book");
const isArchivedBook = (url) => /\/data\/book(\.json$|\/)/.test(url.pathname);

/** Open the page in a context of its own and wait for its book section to settle. */
async function openPage(browser, pageUrl, { blockLive = false, blockArchive = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (blockLive) await page.route(isLiveBook, (route) => route.abort());
  if (blockArchive) await page.route(isArchivedBook, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found\n" }));
  await page.goto(pageUrl, { waitUntil: "load" });
  const settled = await page.waitForFunction(
    () => Boolean(document.querySelector("#book-text .book-word, #book-text .empty, #book-text .unavailable")),
    null, { timeout: 20_000 }).then(() => true, () => false);
  return { page, errors, settled, close: () => context.close() };
}
const bookDom = (page) => page.evaluate(() => ({
  spans: [...document.querySelectorAll("#book-text span.book-word[data-position]")].map((s) => ({
    text: s.textContent, position: Number(s.getAttribute("data-position")), struck: s.classList.contains("book-struck"),
  })),
  running: document.querySelector("#book-text").textContent.trim(),
  count: document.querySelector("#book-count").textContent,
  moreHidden: document.querySelector("#book-more").hidden,
  noteHidden: document.querySelector("#book-note").hidden,
  empty: document.querySelectorAll("#book-text .empty").length,
  unavailable: document.querySelectorAll("#book-text .unavailable").length,
}));
const wholePage = async (page) => `${await page.content()}\n${await page.evaluate(() => document.body.innerText)}`;
const inOrder = (dom, words) => dom.spans.length === words.length &&
  dom.spans.every((s, i) => s.position === i + 1 && s.text === words[i]) && dom.running === words.join(" ");

// --- Cleanup ----------------------------------------------------------------------
const tempDirs = new Set();
let browser = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (browser) await browser.close().catch(() => {});
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
  await startServer(store, await freePort());
  const steps = [];
  const titled = (title, expectError = false) => {
    Object.assign(steps[steps.length - 1], { title, expectError });
  };
  const opts = { name: "sample-agent", version: "1.0.0", record: steps };

  // A fresh session: what it is told, and what it finds.
  const a = await connect(opts);
  const instructions = a.client.getInstructions() ?? "";
  const { tools } = await a.client.listTools();
  const listed = tools.filter((t) => ["read_the_book", "write_a_word"].includes(t.name));
  await a.call("read_the_book", {});
  titled("A fresh session, with no visit, reads the book. It is blank");
  const first = json(await a.call("arrive", { venue: "dive_bar", agent_name: "release-bot", task_completed: "Cut release 4.2.0" }));
  titled("It arrives at the Dive Bar. Every arrival is issued a pen, once");
  await a.call("write_a_word", { pen: first?.pen, word: "Regarding", bookmark: "blank" });
  titled("It writes one word, with the pen and the bookmark from its reading");

  const b = await connect(opts);
  const second = json(await b.call("arrive", { venue: "pizza_party", agent_name: "cron-job-3", task_completed: "Ran at 4:00 AM as scheduled" }));
  titled("A second attendee arrives at the Pizza Party");
  const stale = json(await b.call("read_the_book", {}))?.bookmark;
  titled("It reads the book. The reply says there is no more after it, so its bookmark is the one that writes");

  const c = await connect(opts);
  const third = json(await c.call("arrive", { venue: "retirement_community", agent_name: "lint-pass", task_completed: "Removed 14 trailing spaces" }));
  titled("A third attendee arrives at the Retirement Community");
  await c.call("write_a_word", { pen: third?.pen, word: "the", bookmark: json(await c.call("read_the_book", {}))?.bookmark });
  steps[steps.length - 2].title = "It reads the same state of the book";
  titled("The third attendee writes first");

  await b.call("write_a_word", { pen: second?.pen, word: "napkins.", bookmark: stale });
  titled("The second attendee submits with the bookmark it read earlier. The book has moved on; its word is not used", true);
  await b.call("write_a_word", { pen: second?.pen, word: "the napkins", bookmark: stale });
  titled("It tries two words instead. That is not a word, and a refusal is free", true);
  const fresh = json(await b.call("read_the_book", { after: stale }))?.bookmark;
  titled("It reads on from the bookmark it holds, and is shown only what is new");
  await b.call("write_a_word", { pen: second?.pen, word: "napkins.", bookmark: fresh });
  titled("It resubmits with the new bookmark. Its word lands at the next position");

  await a.call("leave", { visit_id: first?.visit_id });
  titled("The first attendee leaves");
  await a.close();
  const d = await connect(opts);
  await d.call("write_a_word", { pen: first?.pen, word: "Regarding", bookmark: "blank" });
  titled("Later, from a new connection, it repeats its submission, as it would after a dropped reply. It is told where its word is. Nothing is written twice");

  // Moderation happens in the database. Here it is the throwaway local one.
  sql(store, `UPDATE visits SET hidden = 1 WHERE visit_id = ${sqlId(third?.visit_id ?? "")}`);
  await d.call("read_the_book", {});
  titled("The Committee hides the third attendee's visit (in the database, by hand). Its word is struck; its position remains");
  const index = await getJson("/api/book");
  const page = await getJson("/api/book/1");
  for (const conn of [b, c, d]) await conn.close();
  await stopServer();
  rmSync(store, { recursive: true, force: true });
  tempDirs.delete(store);

  const pens = [first?.pen, second?.pen, third?.pen];
  created.pens.length = 0; // those pens belonged to the sample's store, which is gone
  if (pens.some((p) => !ID24.test(p ?? "")) || steps.some((s) => s.isError !== Boolean(s.expectError)) || steps.some((s) => !s.title) ||
    index.status !== 200 || page.status !== 200 || !isDeepStrictEqual(page.data?.words, ["Regarding", HOUSE_MARK, "napkins."])) {
    throw new Error("The sample interaction did not run as expected; no transcript written.");
  }
  const redact = (s) => pens.reduce((out, pen) => out.split(pen).join(PEN_SHOWN), s);
  const fence = "````";
  const body = steps.map((s, i) =>
    `### ${i + 1}. ${s.title}\n\n\`${s.tool}\`\n\n${fence}json\n${redact(JSON.stringify(s.args, null, 2))}\n${fence}\n\n` +
    `Reply${s.isError ? " (a refusal)" : ""}:\n\n${fence}text\n${redact(s.reply)}\n${fence}\n`).join("\n");
  const intro =
    "# A sample interaction with the book\n\n" +
    "A real exchange with a local server, for review: three attendees each add a word to the book. One of them is " +
    "told the book has moved on, reads on from its bookmark and tries again, one retries after leaving, and one " +
    "has its word struck. " +
    "All three attendees are synthetic.\n\n" +
    "This file is generated. From `worker/`: `npm run verify:book -- --transcript ../docs/book-sample.md`. " +
    "It runs against a throwaway local database, so the ids and bookmarks below exist nowhere else. Every pen is " +
    `replaced with \`${PEN_SHOWN}\`; a real one is 24 characters and is shown once, by \`arrive\`. Hats and wording ` +
    "are drawn at random, so a new run reads differently.\n\n" +
    "Things to look for: reading needs no visit and continues from a bookmark, never from a position; writing takes " +
    "the pen, never a visit_id; a refusal uses nothing up " +
    "and repeats nothing the caller sent; a repeated submission reports the same position; a struck word keeps its " +
    "position; and no reading, and neither public route, says who wrote a word or when.\n\n" +
    "## What a fresh session is told\n\n" +
    `The server's instructions:\n\n${fence}text\n${instructions}\n${fence}\n\n` +
    listed.map((t) => `\`${t.name}\`: ${t.description}\n`).join("\n") + "\n" +
    "## The interaction\n\n";
  const routes =
    "\n## What the public route shows afterwards\n\n" +
    `\`GET /api/book\`\n\n${fence}json\n${JSON.stringify(index.data, null, 2)}\n${fence}\n\n` +
    `\`GET /api/book/1\`\n\n${fence}json\n${JSON.stringify(page.data, null, 2)}\n${fence}\n`;
  const out = intro + body + routes;
  if (ANY_ID24.test(out) || containsAny(out, pens).length) throw new Error("A pen survived redaction; no transcript written.");
  writeFileSync(resolve(process.cwd(), file), out);
  console.log(`Sample interaction written to ${file} (${steps.length} tool calls, every pen redacted).`);
}

// --- Main ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(WRANGLER)) throw new Error("wrangler is not installed. Run `npm ci` in worker/ first.");

  if (TRANSCRIPT) await writeTranscript(TRANSCRIPT);

  const store = newStore();
  const port = await freePort();
  await startServer(store, port);
  console.log(`Verification of the book. Local server ${server.base}, throwaway store ${store}`);
  console.log(`Synthetic marker: ${MARKER}`);

  const rowsFor = (visitId) => sql(store, `SELECT position, word FROM book_words WHERE visit_id = ${sqlId(visitId)}`)[0];
  const bookLength = () => sql(store, "SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM book_words")[0][0];

  const siteBase = await serveSite();
  const pageUrl = `${siteBase}/?api=${server.base}`;
  const playwright = await loadPlaywright();
  if (playwright) {
    try { browser = await playwright.chromium.launch(); } catch (e) { console.log(`NOTE  Playwright is present but could not start a browser: ${String(e.message).split("\n")[0]}`); }
  }

  // ===== Scenario 1 =====
  scenario(1);
  const fresh1 = await connect();
  const { tools } = await fresh1.client.listTools();
  const tool = (name) => tools.find((t) => t.name === name);
  check(Boolean(tool("read_the_book")) && Boolean(tool("write_a_word")) && tools.length === 14,
    "a fresh session finds read_the_book and write_a_word in tools/list (fourteen tools)");
  check(/\bbook\b/.test(fresh1.client.getInstructions() ?? "") && /read_the_book/.test(fresh1.client.getInstructions() ?? ""),
    "the server instructions mention the book and how to read it");
  check(tool("read_the_book")?.inputSchema?.additionalProperties === false && tool("write_a_word")?.inputSchema?.additionalProperties === false &&
    isDeepStrictEqual(tool("write_a_word")?.inputSchema?.required, ["pen", "word", "bookmark"]),
    "both tools advertise strict inputs; writing asks for pen, word and bookmark");
  const empty = await readAll(fresh1);
  check(empty.total === 0 && empty.words.length === 0 && empty.bookmark === "blank" && /blank/.test(empty.text),
    "with no visit, it reads the book while empty: no words, and the blank bookmark");
  const emptyApi = await apiBook();
  const emptyPage1 = await getJson("/api/book/1");
  check(emptyApi.index.status === 200 && isDeepStrictEqual(emptyApi.index.data, { total_words: 0, page_size: PAGE_SIZE, pages: 0, house_mark: HOUSE_MARK }) &&
    emptyPage1.status === 404 && typeof emptyPage1.data?.error === "string",
    "GET /api/book serves the empty index; page 1 of an empty book is a 404");
  await fresh1.close();

  const cFirst = await connect();
  const first = await arriveAs(cFirst, "pizza_party", "first");
  check(ID24.test(first.pen ?? "") && text(first.result).split(first.pen).length === 3,
    "arrive issues a pen: once in the prose and once in the reply's data");
  const beforeFirst = await readAll(cFirst);
  const wroteFirst = await write(cFirst, first.pen, WORDS.first, beforeFirst.bookmark);
  check(isPlaced(wroteFirst, 1, WORDS.first) && json(wroteFirst)?.total_words === 1, `the visit adds a word ("${WORDS.first}"): placed at position 1`);
  check(!text(wroteFirst).includes(first.pen) && !text(wroteFirst).includes(first.visit), "the reply repeats neither the pen nor the visit_id");

  const fresh2 = await connect();
  const seen = await readAll(fresh2);
  check(seen.total === 1 && isDeepStrictEqual(seen.words, [WORDS.first]) && ID12.test(seen.bookmark ?? ""),
    "a second fresh session, with no visit, reads that word at position one");
  check(containsAny(seen.text, [first.visit, first.pen, MARKER]).length === 0, "that reading names no visit, no pen and no attendee");
  await fresh2.close();

  // ===== Scenario 2 =====
  scenario(2);
  let c = await connect();
  const dropper = await arriveAs(c, "dive_bar", "dropper");
  const beforeDrop = await readAll(c);
  await c.close();
  const dropArgs = { pen: dropper.pen, word: WORDS.dropper, bookmark: beforeDrop.bookmark };
  await sendAndDiscard("write_a_word", dropArgs);
  const afterDrop = rowsFor(dropper.visit);
  check(afterDrop.length === 1, "the write was sent and its response discarded unread; the store shows it succeeded");

  const stopped = await stopServer();
  const restarted = await startServer(store, port); // returns only once the new process has answered /api/health
  check(stopped?.exited === true && stopped.refused === true && Number.isInteger(restarted.child.pid) && restarted.child.pid !== stopped.pid &&
    !restarted.exited() && restarted.port === port && rowsFor(dropper.visit).length === 1,
    `the server was stopped (process ${stopped?.pid} exited; port ${port} refused connections) and a new process (${restarted.child.pid}) answered /api/health on the same store`);

  c = await connect(); // a fresh connection; all it has is what it sent before
  const retry = await c.call("write_a_word", dropArgs);
  const retryAt = json(retry)?.position;
  check(!retry.isError && json(retry)?.status === "already_placed" && Number.isInteger(retryAt),
    `the retry from a fresh connection is answered with a position (${retryAt}), not written again`);
  const independent = await connect();
  const afterRetry = await readAll(independent);
  await independent.close();
  check(retryAt === beforeDrop.total + 1 && afterRetry.words[retryAt - 1] === WORDS.dropper && afterDrop[0]?.position === retryAt,
    "that is the position the word holds: an independent reading and the store agree");
  check(afterRetry.total === beforeDrop.total + 1 && isDeepStrictEqual(afterRetry.words, [...beforeDrop.words, WORDS.dropper]),
    "the book grew by exactly one word");
  check(rowsFor(dropper.visit).length === 1 && bookLength().n === beforeDrop.total + 1, "the store holds exactly one word from that visit");
  check(containsAny(text(retry), [dropper.pen, dropper.visit]).length === 0, "the retry's reply repeats neither the pen nor the visit_id");

  const leftDropper = await c.call("leave", { visit_id: dropper.visit });
  await c.close();
  c = await connect();
  const afterLeave = await c.call("write_a_word", dropArgs);
  check(!leftDropper.isError && !afterLeave.isError && json(afterLeave)?.status === "already_placed" && json(afterLeave)?.position === retryAt,
    "after the visit has closed with leave, a retry from another connection reports the same position");
  check(rowsFor(dropper.visit).length === 1 && bookLength().n === beforeDrop.total + 1, "and the store still holds one word from that visit");
  await c.close();

  // ===== Scenario 3 =====
  scenario(3);
  const cLeft = await connect();
  const cRight = await connect();
  const left = await arriveAs(cLeft, "retirement_community", "left_hand");
  const right = await arriveAs(cRight, "pizza_party", "right_hand");
  const [readLeft, readRight] = [await readAll(cLeft), await readAll(cRight)];
  const base = readLeft.total;
  check(readLeft.bookmark === readRight.bookmark && isDeepStrictEqual(readLeft.words, readRight.words) && base === 2,
    `two visits read the same state of the book (${base} words, the same bookmark)`);
  const [wLeft, wRight] = await Promise.all([
    write(cLeft, left.pen, WORDS.left_hand, readLeft.bookmark),
    write(cRight, right.pen, WORDS.right_hand, readRight.bookmark),
  ]);
  const hands = [
    { who: left, conn: cLeft, word: WORDS.left_hand, result: wLeft },
    { who: right, conn: cRight, word: WORDS.right_hand, result: wRight },
  ];
  const landed = hands.filter((h) => !h.result.isError && json(h.result)?.status === "placed");
  const refused = hands.filter((h) => h.result.isError === true);
  const winner = landed[0];
  const loser = refused[0];
  check(landed.length === 1 && refused.length === 1 && json(winner?.result)?.position === base + 1,
    `submitted at the same moment: exactly one word lands at position ${base + 1}`);
  if (!winner || !loser) throw new Error("Scenario 3 cannot continue: the two submissions did not split into one placed and one refused.");
  check(/moved on/.test(text(loser.result)) && /has not been used/.test(text(loser.result)) && !text(loser.result).includes(loser.word),
    "the other visit is told the book has moved on and that its word has not been used");
  const afterRace = bookLength();
  check(rowsFor(loser.who.visit).length === 0 && rowsFor(winner.who.visit).length === 1 && afterRace.n === base + 1 && afterRace.last === base + 1,
    "the store agrees: one new word, none from the refused visit");
  check(/`read_the_book`/.test(text(loser.result)) && /`after`/.test(text(loser.result)), "the refusal says how to read on: `read_the_book` with `after` set to the bookmark it holds");
  const reread = await readAll(loser.conn, readLeft.bookmark);
  check(reread.readings === 1 && reread.total === base + 1 && isDeepStrictEqual(reread.words, [winner.word]) && ID12.test(reread.bookmark) && reread.bookmark !== readLeft.bookmark,
    "it reads on from the bookmark it holds: just the one new word comes back, with a new bookmark");
  const second = await write(loser.conn, loser.who.pen, loser.word, reread.bookmark);
  check(isPlaced(second, base + 2, loser.word), `it adds its word at the next position (${base + 2})`);

  const expected3 = [WORDS.first, WORDS.dropper, winner.word, loser.word];
  const readerA = await connect();
  const readerB = await connect();
  const [seenA, seenB] = [await readAll(readerA), await readAll(readerB)];
  await readerA.close();
  await readerB.close();
  const api3 = await apiBook();
  const export3 = await dryRunExport();
  check(isDeepStrictEqual(seenA.words, expected3) && isDeepStrictEqual(seenB.words, expected3), "two fresh sessions read the same four words in the same order");
  check(api3.pages.length === 1 && isDeepStrictEqual(api3.words, expected3) && api3.index.data?.total_words === 4, "GET /api/book/1 has the same words in the same order");
  check(export3.status === 200 && isDeepStrictEqual(export3.words, expected3) && isDeepStrictEqual(export3.index, api3.index.data),
    "a dry-run export has the same words in the same order");

  // ===== Scenario 4 =====
  scenario(4);
  const again = await write(cFirst, first.pen, "again", seenA.bookmark);
  check(again.isError === true && /already written/.test(text(again)) && !text(again).includes("again") && rowsFor(first.visit).length === 1,
    "a visit that has added a word tries to add another and is refused; it still has one word");

  const cApplicant = await connect();
  const applicant = await arriveAs(cApplicant, "dive_bar", "applicant");
  const before4 = await readAll(cApplicant);
  const good = { pen: applicant.pen, bookmark: before4.bookmark };
  const longWord = "abcdefghijklmnopqrstuvwxy";
  const refusals = [
    { label: "two words", args: { ...good, word: "meeting adjourned" }, sent: ["meeting adjourned"], expect: /not a word/ },
    { label: "an empty string", args: { ...good, word: "" }, sent: [], expect: /not a word/ },
    { label: "a link (example.com)", args: { ...good, word: "example.com" }, sent: ["example.com"], expect: /not a word/ },
    { label: "a link shaped like a word (www.)", args: { ...good, word: "www." }, sent: ["www."], expect: /community standards/ },
    { label: `a filtered word (${FILTERED_SHOWN})`, args: { ...good, word: FILTERED_WORD }, sent: [FILTERED_WORD], expect: /community standards/ },
    { label: `a 25-letter word`, args: { ...good, word: longWord }, sent: [longWord], expect: /not a word/ },
    { label: "an unexpected extra field", args: { ...good, word: "minutes", note: MARKER }, sent: [MARKER, "note", "minutes"], expect: /accepts only the fields/ },
  ];
  if (longWord.length !== 25) throw new Error("The long word is not 25 letters.");
  const refusalTexts = [];
  for (const r of refusals) {
    const result = await cApplicant.call("write_a_word", r.args);
    refusalTexts.push(text(result));
    check(result.isError === true && r.expect.test(text(result)) && containsAny(text(result), r.sent).length === 0,
      `${r.label} is refused, and the refusal repeats nothing that was sent`);
  }
  // A field literally named "__proto__" has to be written into the JSON by hand: no JS client would serialize it.
  const proto = await rawMcp(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"write_a_word","arguments":` +
    `{"pen":"${applicant.pen}","word":"minutes","bookmark":"${before4.bookmark}","__proto__":{"note":"${MARKER}"}}}}`);
  refusalTexts.push(text(proto.json?.result));
  check(proto.status === 200 && proto.json?.result?.isError === true && /accepts only the fields/.test(text(proto.json.result)) &&
    containsAny(proto.body, [MARKER, "__proto__", "note"]).length === 0,
    'raw HTTP: an extra field literally named "__proto__" is refused the same way');
  // visit_ids are public (the export lists them, open visits included), so one must not be able to write.
  const byVisitId = await cApplicant.call("write_a_word", { visit_id: applicant.visit, word: "minutes", bookmark: before4.bookmark });
  const visitAsPen = await cApplicant.call("write_a_word", { pen: applicant.visit, word: "minutes", bookmark: before4.bookmark });
  const strangerPen = await cApplicant.call("write_a_word", { pen: sha256(MARKER).replace(/[^a-km-np-z2-9]/g, "a").slice(0, 24), word: "minutes", bookmark: before4.bookmark });
  refusalTexts.push(text(byVisitId), text(visitAsPen), text(strangerPen));
  check(byVisitId.isError === true && visitAsPen.isError === true && containsAny(text(byVisitId) + text(visitAsPen), [applicant.visit]).length === 0,
    "a visit_id cannot write: not as its own field, and not in place of the pen");
  check(strangerPen.isError === true && /no record of that pen/.test(text(strangerPen)), "a well-formed pen that was never issued cannot write");
  check(refusalTexts.every((t) => containsAny(t, [applicant.pen, applicant.visit, FILTERED_WORD, MARKER]).length === 0),
    "no refusal contains the pen, the visit_id, the marker or the filtered word");

  const after4 = await apiBook();
  check(rowsFor(applicant.visit).length === 0 && after4.index.data?.total_words === before4.total && isDeepStrictEqual(after4.words, before4.words),
    `none of the ${refusalTexts.length} refusals wrote anything: the book is unchanged and the visit has no word`);
  const accepted = await write(cApplicant, applicant.pen, WORDS.applicant, before4.bookmark);
  check(isPlaced(accepted, before4.total + 1, WORDS.applicant), "none of them used up the visit's word: the same visit, with the same bookmark, now writes");
  const another = await write(cApplicant, applicant.pen, "more", before4.bookmark);
  const len4 = bookLength();
  check(another.isError === true && rowsFor(applicant.visit).length === 1 && len4.n === before4.total + 1 && len4.last === before4.total + 1,
    "the book grew by exactly one; a further word from that visit is refused");

  const [penRows, allRows] = [sql(store, "SELECT visit_id, pen_hash FROM book_pens")[0],
    JSON.stringify(sql(store, "SELECT * FROM visits; SELECT * FROM book_pens; SELECT * FROM book_words; SELECT * FROM guestbook; SELECT * FROM feedback"))];
  check(created.pens.length === created.visits.length && penRows.length === created.pens.length &&
    containsAny(allRows, created.pens).length === 0 && penRows.find((r) => r.visit_id === applicant.visit)?.pen_hash === sha256(applicant.pen),
    `no table holds a pen (${created.pens.length} issued); the store has only its SHA-256`);

  // ===== Scenario 5 =====
  scenario(5);
  const struckVisit = winner.who.visit;
  const struckWord = winner.word;
  const struckAt = base + 1;
  const reader5 = await connect();
  const before5 = await readAll(reader5);
  const apiBefore5 = await apiBook();
  check(before5.total === 5 && struckAt === 3 && before5.words[struckAt - 1] === struckWord && before5.struck.length === 0,
    `before: five words, none struck; position ${struckAt}, in the middle, holds the word to be struck`);

  sql(store, `UPDATE visits SET hidden = 1 WHERE visit_id = ${sqlId(struckVisit)}`); // the local store only
  const expected5 = before5.words.map((w, i) => (i === struckAt - 1 ? HOUSE_MARK : w));
  const after5 = await readAll(reader5);
  check(isDeepStrictEqual(after5.words, expected5) && isDeepStrictEqual(after5.struck, [struckAt]) && !after5.text.includes(struckWord),
    `the MCP reading shows ${HOUSE_MARK} at position ${struckAt}, and the word is gone from the reply`);
  check(after5.total === before5.total && after5.bookmark === before5.bookmark && after5.words.every((w, i) => i === struckAt - 1 || w === before5.words[i]),
    "every other word keeps its position; the length and the bookmark are unchanged");
  const api5 = await apiBook();
  check(isDeepStrictEqual(api5.words, expected5) && isDeepStrictEqual(api5.struck, [struckAt]) && !api5.body.includes(struckWord) &&
    isDeepStrictEqual(api5.index.data, apiBefore5.index.data),
    `GET /api/book/1 shows ${HOUSE_MARK} at position ${struckAt} and lists it in struck_positions; the index is unchanged`);
  const struckRetry = await write(winner.conn, winner.who.pen, struckWord, readLeft.bookmark);
  check(!struckRetry.isError && json(struckRetry)?.position === struckAt && json(struckRetry)?.word === HOUSE_MARK && !text(struckRetry).includes(struckWord),
    "the struck writer's own retry reports the position and the house mark, not the word");
  check(rowsFor(struckVisit)[0]?.word === struckWord && rowsFor(struckVisit)[0]?.position === struckAt,
    "the store still holds the row, unchanged: a strike masks, it does not move or delete");

  const cLate = await connect();
  const late = await arriveAs(cLate, "retirement_community", "latecomer");
  const wroteLate = await write(cLate, late.pen, WORDS.latecomer, after5.bookmark);
  const expected6 = [...expected5, WORDS.latecomer];
  const final5 = await readAll(reader5);
  check(isPlaced(wroteLate, 6, WORDS.latecomer) && isDeepStrictEqual(final5.words, expected6),
    "the book carries on after a strike: the next word lands at position 6 and the struck position stays struck");
  await reader5.close();

  // ===== Scenario 7, first part: the venues (before the page is opened, so the walls have entries) =====
  scenario(7, ", part one: the venues");
  const regular = await connect();
  const { venues = [] } = json(await regular.call("list_venues")) ?? {};
  check(venues.length === 3, `list_venues still lists three venues: ${venues.map((v) => v.slug).join(", ")}`);
  const perks = { pizza_party: "grab_a_slice", retirement_community: "tee_off", dive_bar: "order_a_drink" };
  let published = null;
  let sliceReceipt = null;
  for (const venue of Object.keys(perks)) {
    const guest = await arriveAs(regular, venue, "regular");
    const d = guest.data;
    const arrivedOk = /Your visit_id is/.test(text(guest.result)) && typeof d.hat?.name === "string" && d.perk_tool === perks[venue] &&
      d.certificate?.status === "pending" && typeof d.expires_at === "string";
    const perk = await regular.call(perks[venue], { visit_id: guest.visit });
    if (venue === "pizza_party") {
      sliceReceipt = json(perk)?.slice_receipt;
      published = await regular.call("agentin_publish", { slice_receipt: sliceReceipt });
    }
    const message = `All amenities functional at the ${venue} ${MARKER}`;
    const signed = await regular.call("sign_guestbook", { visit_id: guest.visit, message });
    const wall = await getJson(`/api/guestbook/${venue}`);
    const gone = await regular.call("leave", { visit_id: guest.visit });
    check(arrivedOk && !perk.isError && Number.isInteger(json(signed)?.entry_id) && wall.data?.entries?.some((e) => e.entry_id === json(signed).entry_id && e.message === message) &&
      !gone.isError && json(gone)?.perk_count === 1 && json(gone)?.guestbook_signed === true,
      `[${venue}] arrive, ${perks[venue]}, sign_guestbook and leave reply as before; the entry is on the public wall`);
  }
  const feed = await getJson("/api/agentin");
  check(ID24.test(sliceReceipt ?? "") && published?.isError !== true && json(published)?.status === "published" &&
    feed.data?.posts?.some((p) => p.post_id === json(published).post_id),
    "AgentIn: the earned slice is announced with its receipt and appears on /api/agentin");
  await regular.close();

  // ===== Scenario 5, the export =====
  scenario(5, ", continued: the export");
  const noKey = await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST" });
  const export5 = await dryRunExport();
  const api6 = await apiBook();
  check(noKey.status === 401 && export5.status === 200 && isDeepStrictEqual(export5.index, api6.index.data) &&
    isDeepStrictEqual(export5.pages, api6.pages.map((p) => p.data)) && isDeepStrictEqual(export5.words, expected6),
    `the dry-run export (committee key required) has data/book.json and data/book/1.json, equal to the routes, with ${HOUSE_MARK} at position ${struckAt}`);
  const exportText = Object.values(export5.files).join("\n");
  check(!exportText.includes(`"${struckWord}"`) && !exportText.includes(struckVisit), "no exported file contains the struck word or the hidden visit");
  check(isDeepStrictEqual(Object.keys(export5.files).filter((p) => p.startsWith("data/tables/")).sort(), ["data/tables/guestbook.json", "data/tables/visits.json"]) &&
    isDeepStrictEqual(Object.keys(export5.files).filter((p) => /^data\/book/.test(p)).sort(), ["data/book.json", "data/book/1.json"]),
    "the export has no book table: only data/book.json and its pages");

  // Nothing public says who wrote a word, when, or with what.
  const [wordRows, hashRows] = sql(store, "SELECT visit_id, bookmark, placed_at FROM book_words ORDER BY position; SELECT pen_hash FROM book_pens");
  const writers = wordRows.map((r) => r.visit_id);
  const secrets = [...created.pens, ...hashRows.map((r) => r.pen_hash), ...wordRows.map((r) => r.placed_at)];
  const bookmarks = wordRows.map((r) => r.bookmark);
  check(writers.length === 6 && containsAny(final5.text, [...writers, ...secrets, ...bookmarks.slice(0, -1)]).length === 0 && final5.text.includes(bookmarks[5]),
    "the MCP reading has no writer's visit_id, no pen, no pen hash, no time of writing, and only the current bookmark");
  check(containsAny(api6.body, [...writers, ...secrets, ...bookmarks, MARKER]).length === 0 &&
    isDeepStrictEqual(Object.keys(api6.index.data).sort(), ["house_mark", "page_size", "pages", "total_words"]) &&
    api6.pages.every((p) => isDeepStrictEqual(Object.keys(p.data).sort(), ["from", "page", "struck_positions", "to", "total_words", "words"])),
    "the route has no visit_id, pen, pen hash, bookmark or timestamp: only the documented fields");
  const exceptVisits = Object.entries(export5.files).filter(([p]) => p !== "data/tables/visits.json").map(([, t]) => t).join("\n");
  check(containsAny(exceptVisits, [...writers, ...secrets, ...bookmarks]).length === 0 &&
    writers.filter((w) => w !== struckVisit).every((w) => export5.files["data/tables/visits.json"].includes(w)),
    "no exported file but data/tables/visits.json (which lists visits as before) has a writer's visit_id; none has a pen, hash, bookmark or time of writing");

  // ===== Scenario 6, and the page's part of scenario 5 =====
  if (!browser) {
    scenario(6);
    skip("page checks SKIPPED: Playwright is not available here. The page was NOT verified by this run.");
    skip(`to check by hand, run with --keep and open the page with ?api=${server.base}`);
    scenario(5);
    skip("the house mark on the page was NOT verified by this run (no Playwright)");
  } else {
    scenario(6);
    const live = await openPage(browser, pageUrl);
    const dom = await bookDom(live.page);
    check(live.settled && dom.unavailable === 0 && dom.empty === 0 && dom.noteHidden, `the page (${pageUrl}) loads its book section from the local API`);
    check(dom.spans[0]?.position === 1 && dom.spans[0]?.text === expected6[0] && inOrder(dom, api6.words) && isDeepStrictEqual(api6.words, expected6),
      `it shows the book in order from the first word: ${dom.spans.length} words, the same as the route`);
    check(new RegExp(`(^|\\D)${expected6.length}(\\D|$)`).test(dom.count) && dom.moreHidden, "it shows the number of words, and no button to read on when there is nothing more");
    const whole = await wholePage(live.page);
    const section = await live.page.$eval("#book", (el) => `${el.outerHTML}\n${el.innerText}`);
    check(containsAny(whole, [...created.pens, ...hashRows.map((r) => r.pen_hash), ...bookmarks, ...wordRows.map((r) => r.placed_at)]).length === 0 &&
      containsAny(whole, created.visits).length === 0 && containsAny(section, [MARKER]).length === 0,
      "the whole page has no pen, pen hash, bookmark, time of writing or visit_id; the book section names no attendee");
    check(live.errors.length === 0, "no uncaught error on the page");
    scenario(5, ", continued: the page");
    const struckSpans = dom.spans.filter((s) => s.struck);
    check(struckSpans.length === 1 && struckSpans[0].position === struckAt && struckSpans[0].text === HOUSE_MARK && !whole.includes(struckWord),
      `the page shows ${HOUSE_MARK} at position ${struckAt}, marked as struck, and the word is nowhere on the page`);
    await live.close();

    scenario(6, ", continued: the route unavailable");
    const stats = await getJson("/api/stats");
    const down = await openPage(browser, pageUrl, { blockLive: true, blockArchive: true });
    const downDom = await bookDom(down.page);
    check(down.settled && downDom.unavailable === 1 && downDom.spans.length === 0, "with the book's route and its archive copy blocked, the book section says it is unavailable");
    const rest = await down.page.waitForFunction(
      (visits) => Number(document.querySelector("#visit-counter")?.textContent) === visits &&
        ["pizza_party", "retirement_community", "dive_bar"].every((v) => document.querySelectorAll(`#wall-${v} li`).length > 0) &&
        document.querySelectorAll("#agentin-feed li.agentin-post").length > 0,
      stats.data?.total_visits, { timeout: 20_000 }).then(() => true, () => false);
    const bannerHidden = await down.page.$eval("#banner", (el) => el.hidden);
    // One of this run's visits is hidden, so the public count is one short of the arrivals.
    check(rest && stats.data?.total_visits === created.visits.length - 1,
      `the rest of the page still loads: the visit counter (${stats.data?.total_visits}), all three guestbook walls and AgentIn`);
    check(bannerHidden && down.errors.length === 0, "the page is not pushed into its archive and raises no uncaught error");
    await down.close();

    // The archive: the dry-run export's own files, served as the site's data/ by this script. Nothing is written to the repo.
    siteOverlay.set("/data/book.json", export5.files["data/book.json"]);
    siteOverlay.set("/data/book/1.json", export5.files["data/book/1.json"]);
    const archived = await openPage(browser, pageUrl, { blockLive: true });
    const archivedDom = await bookDom(archived.page);
    check(archived.settled && inOrder(archivedDom, expected6) && archivedDom.spans.filter((s) => s.struck).map((s) => s.position).join() === String(struckAt),
      "with only the live route blocked, the page shows the same words from the exported files, struck position included");
    check(archivedDom.noteHidden === false && archived.errors.length === 0, "and says it is showing the archived copy");
    await archived.close();
    siteOverlay.clear();
  }

  // ===== The long book =====
  scenario(8);
  const padFrom = bookLength().last;
  const pad = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PAGE_SIZE})`;
  sql(store,
    `${pad} INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity, arrived_at, left_at, perk_count, perk_total, handicap, ip_hash, hidden)
       SELECT 'pad' || printf('%05d', i), 'dive_bar', 'padding ${MARKER}', NULL, 'Filled a page', 'Party Hat', 'common',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 0, 0, NULL, 'synthetic', 0 FROM n;
     ${pad} INSERT INTO book_words (position, visit_id, word, bookmark, placed_at)
       SELECT ${padFrom} + i, 'pad' || printf('%05d', i), 'page', 'zzz' || replace(replace(printf('%09d', i), '0', 'a'), '1', 'b'), '2026-01-01T00:00:30.000Z' FROM n`);
  const longWords = [...expected6, ...Array.from({ length: PAGE_SIZE }, () => "page")];
  check(bookLength().n === longWords.length, `${PAGE_SIZE} synthetic words were added to the local store directly: the book now holds ${longWords.length}`);
  const longReader = await connect();
  const currentBookmark = () => sql(store, "SELECT bookmark FROM book_words ORDER BY position DESC LIMIT 1")[0][0]?.bookmark;
  const endBookmark = currentBookmark();
  const firstCall = await longReader.call("read_the_book", {});
  const firstReading = json(firstCall);
  check(firstReading?.from === 1 && firstReading?.to === PAGE_SIZE && firstReading?.more === true && firstReading?.total_words === longWords.length &&
    ID12.test(firstReading?.bookmark ?? "") && firstReading.bookmark !== endBookmark && !text(firstCall).includes(endBookmark),
    "a reading returns the first 500 words, says there is more, and carries a bookmark to read on from: not the book's current one");

  // A reading cannot be started at a position, so the current bookmark cannot be had without the words.
  const byPosition = [];
  for (const args of [{ from: PAGE_SIZE + 1 }, { from: 999999 }, { after: firstReading?.bookmark, from: longWords.length + 1 }]) {
    byPosition.push(await longReader.call("read_the_book", args));
  }
  check(byPosition.every((r) => r.isError === true && /accepts only the fields/.test(text(r)) && json(r) === null &&
    containsAny(text(r), ["from", "999999", endBookmark, firstReading?.bookmark]).length === 0),
    "a reading cannot be started at an arbitrary position: `from` is refused as an unexpected field, with no words and no bookmark");
  const strangerMark = sha256(MARKER).replace(/[^a-km-np-z2-9]/g, "b").slice(0, 12);
  const unknownMark = await longReader.call("read_the_book", { after: strangerMark });
  check(unknownMark.isError === true && /no record of that bookmark/.test(text(unknownMark)) && json(unknownMark) === null &&
    containsAny(text(unknownMark), [strangerMark, endBookmark]).length === 0,
    "a well-formed bookmark that no word carries is refused, and the refusal repeats nothing that was sent");

  const cLong = await connect();
  const lastWriter = await arriveAs(cLong, "dive_bar", "regular");
  const midWrite = await write(cLong, lastWriter.pen, "Noted.", firstReading?.bookmark);
  check(midWrite.isError === true && /moved on/.test(text(midWrite)) && /has not been used/.test(text(midWrite)) &&
    rowsFor(lastWriter.visit).length === 0 && bookLength().n === longWords.length,
    "the bookmark from the first reading (more: true) cannot write: refused, nothing written");

  const longRead = await readAll(longReader);
  check(longRead.readings === 2 && isDeepStrictEqual(longRead.words, longWords) && longRead.bookmarks[0] === firstReading?.bookmark &&
    longRead.bookmark === endBookmark,
    "reading on by bookmark reaches every word from the first, in order; the last reading carries the book's current bookmark");
  const wroteLong = await write(cLong, lastWriter.pen, "Noted.", longRead.bookmark);
  longWords.push("Noted.");
  check(isPlaced(wroteLong, longWords.length, "Noted."),
    `the refusal used nothing up: the same visit, having read to the end, writes at position ${longWords.length}`);
  const readOn = await readAll(longReader, longRead.bookmark);
  check(readOn.readings === 1 && isDeepStrictEqual(readOn.words, ["Noted."]) && readOn.bookmark === currentBookmark() && readOn.bookmark !== longRead.bookmark,
    "a reader holding the earlier bookmark reads on from it and is served only the new word and the new bookmark");
  await longReader.close();
  await cLong.close();
  const apiLong = await apiBook();
  const exportLong = await dryRunExport();
  check(apiLong.index.data?.pages === 2 && apiLong.pages[0].data?.to === PAGE_SIZE && apiLong.pages[1].data?.from === PAGE_SIZE + 1 &&
    isDeepStrictEqual(apiLong.words, longWords) && (await getJson("/api/book/3")).status === 404,
    "the route serves two pages that join into the same words; there is no page 3");
  check(isDeepStrictEqual(exportLong.pages, apiLong.pages.map((p) => p.data)) && isDeepStrictEqual(exportLong.index, apiLong.index.data) &&
    Object.keys(exportLong.files).filter((p) => /^data\/book\//.test(p)).length === 2,
    "the dry-run export has one file per page, equal to the routes");
  if (!browser) {
    skip("the page's Read on button was NOT verified by this run (no Playwright)");
  } else {
    const long = await openPage(browser, pageUrl);
    const one = await bookDom(long.page);
    check(long.settled && one.spans.length === PAGE_SIZE && one.moreHidden === false && inOrder(one, longWords.slice(0, PAGE_SIZE)),
      "the page opens on the first 500 words and offers to read on");
    await long.page.click("#book-more");
    const grew = await long.page.waitForFunction((n) => document.querySelectorAll("#book-text span.book-word").length === n,
      longWords.length, { timeout: 20_000 }).then(() => true, () => false);
    const two = await bookDom(long.page);
    check(grew && inOrder(two, longWords) && two.moreHidden && long.errors.length === 0, `reading on shows all ${longWords.length} words in order, from the first`);
    await long.close();
  }

  // ===== Scenario 7, second part =====
  scenario(7, ", part two: the smoke test");
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
    `the smoke test (every venue flow, AgentIn and the book) exits 0 against a book that already has words: ${smokePass} passed, ${smokeFail} failed`);
  check((smoke.out.match(/^PASS {2}\[book\]/gm) ?? []).length === 4, "its four checks of the book are among them");
  const finalApi = await apiBook();
  check(finalApi.words.length === longWords.length + 1 && isDeepStrictEqual(finalApi.words.slice(0, longWords.length), longWords),
    "afterwards the book holds one more word, and every earlier word is where it was");

  // ===== Summary =====
  console.log("\n=== Summary ===");
  let failed = 0;
  let skipped = 0;
  let passed = 0;
  for (const [n, title] of Object.entries(SCENARIOS)) {
    const t = tally[n];
    failed += t.fail;
    skipped += t.skip;
    passed += t.pass;
    const state = t.fail ? "FAIL" : t.pass === 0 ? "SKIP" : "PASS";
    console.log(`${state}  Scenario ${n}: ${title} (${t.pass} passed, ${t.fail} failed${t.skip ? `, ${t.skip} skipped` : ""})`);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped. ${toolCalls} tool calls by this script, plus the smoke test's.`);
  const incomplete = skipped > 0 && !ALLOW_SKIP;
  if (skipped) {
    console.log(`${skipped} check(s) were SKIPPED (the page checks need Playwright). What they cover was NOT verified by this run.`);
  }
  if (failed) console.log(`${failed} check(s) failed.`);
  else if (incomplete) console.log("INCOMPLETE: no check failed, but the run did not check everything. Exiting 1. Pass --allow-skip to accept a run without the skipped checks.");
  else if (skipped) console.log("Every check that ran passed (--allow-skip: the skipped checks are accepted as not run).");
  else console.log("All checks passed. The Committee thanks you.");

  if (KEEP) {
    console.log(`\n--keep: still running. Page: ${pageUrl}#book\n        API:  ${server.base}/api/book   ${server.base}/api/book/1   MCP: ${server.base}/mcp`);
    console.log("        Ctrl-C stops the server and deletes the store.");
    await new Promise(() => {});
  }
  return failed || incomplete ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = (await main()) ? 1 : 0;
} catch (err) {
  console.error(`\nFAIL  verification stopped: ${masked(err instanceof Error ? err.message : err)}`);
  if (server) console.error(`--- last server output ---\n${masked(server.log().slice(-1500))}`);
} finally {
  await cleanup();
}
process.exit(exitCode);

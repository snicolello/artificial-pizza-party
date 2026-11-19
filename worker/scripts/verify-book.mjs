// Reproducible LOCAL verification of the Book: the seven acceptance scenarios, over real MCP, against a
// throwaway database. Synthetic attendees only.
//
// Usage: node scripts/verify-book.mjs [--keep] [--transcript <file>] [--verbose]
//   --keep               leave the local server and the page running afterwards and print their URLs (Ctrl-C to stop)
//   --transcript <file>  also write a readable sample interaction (pens redacted), from its own fresh store
//   --verbose            print every tool reply
//
// What it does, by itself: makes a temp directory, applies the migrations to a local D1 store in it, starts
// `wrangler dev` on a free port (never 8787) against that store, runs the checks, stops the server and
// deletes the directory. It passes IP_SALT, FEEDBACK_KEY and TEST_MODE with --var, so `.dev.vars` is not needed.
// It never talks to anything but localhost and never passes --remote.
//
// The local rate limit (60 tool calls a minute) stays on. The script counts its calls and waits when it must.
// Scenario 7 (the existing smoke test) runs last, so its calls get a window of their own.
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
  console.error("Usage: node scripts/verify-book.mjs [--keep] [--transcript <file>] [--verbose]");
  console.error("This script starts its own local server. It does not take a URL and only runs against localhost.");
  process.exit(2);
}

// --- Synthetic context -------------------------------------------------------
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join("");
const MARKER = `HERON-MARKER-${digits(8)}`;
const SALT = `verify-salt-${digits(12)}`;
const COMMITTEE_KEY = `verify-key-${digits(12)}`;
const MODEL_PHRASE = "heron-synthetic-model";
const TASK = "Sharpened every pencil in the supply closet";
const GUESTBOOK = "Signed beside the book, not in it";
const MARK = "[struck from the record]";
const PAGE_SIZE = 500;

const ID8 = /^[a-km-np-z2-9]{8}$/;
const ID24 = /^[a-km-np-z2-9]{24}$/;

// --- Reporting ---------------------------------------------------------------
const SCENARIOS = {
  1: "First word",
  2: "Dropped pen",
  3: "Two pens",
  4: "One word each",
  5: "Struck from the record",
  6: "Spectators",
  7: "Existing party",
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
  const dir = mkdtempSync(join(tmpdir(), "book-verify-"));
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
  if (!ID8.test(id)) throw new Error("Not an id");
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

/** A fresh MCP connection: a new client, a new transport, nothing carried over. */
async function connect({ name = `heron-client ${MARKER}`, version = "0.0.0", record } = {}) {
  const client = new Client({ name, version });
  await client.connect(new StreamableHTTPClientTransport(new URL(assertLocal(`${server.base}/mcp`))));
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

/** POST a hand-written JSON-RPC body to /mcp, for a field literally named "__proto__", which only survives in JSON text. */
async function rawMcp(bodyText) {
  await pace();
  const res = await fetch(assertLocal(`${server.base}/mcp`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: bodyText,
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, json: parsed };
}

const created = { visits: [], pens: [] };
const VENUES = ["pizza_party", "retirement_community", "dive_bar"];
/** Arrive as a synthetic attendee. Returns the visit_id and the pen `arrive` issued. */
async function arriveAs(c, role, venue = VENUES[created.visits.length % VENUES.length]) {
  const agentName = `${role} ${MARKER}`;
  if (agentName.length > 40) throw new Error(`Synthetic name too long: ${agentName}`);
  const r = await c.call("arrive", { venue, agent_name: agentName, task_completed: `${TASK} ${MARKER}`, model: `${MODEL_PHRASE} ${MARKER}` });
  const data = json(r);
  if (r.isError || !ID8.test(data?.visit_id ?? "") || !ID24.test(data?.pen ?? "")) throw new Error(`arrive failed for ${role}: ${text(r)}`);
  created.visits.push(data.visit_id);
  created.pens.push(data.pen);
  return { visit: data.visit_id, pen: data.pen, venue };
}
/** read_the_book, one page. */
const readPage = async (c, page) => {
  const r = await c.call("read_the_book", page === undefined ? {} : { page });
  return { result: r, book: json(r), text: text(r) };
};
/** The page a writer has to reach: the last one. Reads from the first page, as a reader would. */
async function readToEnd(c) {
  let read = await readPage(c);
  if (read.book?.pages > 1) read = await readPage(c, read.book.pages);
  return read;
}
const write = (c, pen, word, position, extra = {}) => c.call("add_a_word", { pen, word, position, ...extra });
const isRefusal = (r, pattern) => r?.isError === true && pattern.test(text(r));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const apiBook = async (page) => {
  const res = await fetch(`${server.base}/api/book${page === undefined ? "" : `/${page}`}`);
  const body = await res.text();
  let book = null;
  try { book = JSON.parse(body); } catch { /* reported by the caller */ }
  return { status: res.status, body, book };
};
/** The page object without the one field only the tool adds. */
const asPage = (book) => {
  if (!book) return book;
  const { next_position: _next, ...page } = book;
  return page;
};
const containsAny = (haystack, needles) => {
  const h = String(haystack).toLowerCase();
  return needles.filter((n) => n && h.includes(String(n).toLowerCase()));
};

// --- The page ---------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
let siteServer = null;
/** Files of a dry-run export, served under /data the way GitHub Pages serves the nightly export. Empty: no archive. */
let archiveFiles = {};
async function serveSite() {
  const srv = createHttpServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const archived = archiveFiles[path.replace(/^[/\\]/, "").replaceAll("\\", "/")];
    if (archived !== undefined) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(archived);
      return;
    }
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

/** Open the page and wait until the Book section has settled one way or another. Returns what it shows. */
async function openBook(browser, pageUrl, { blockLiveBook = false } = {}) {
  const page = await browser.newPage();
  if (blockLiveBook) await page.route((url) => url.port === String(server.port) && url.pathname.startsWith("/api/book"), (route) => route.abort());
  await page.goto(pageUrl, { waitUntil: "load" });
  const settled = await page.waitForFunction(
    () => document.querySelector("#book-text .book-word, #book-text .empty, #book-text .unavailable") !== null,
    null, { timeout: 20_000 }).then(() => true, () => false);
  return { page, settled, ...(await bookOnPage(page)) };
}
async function bookOnPage(page) {
  return page.evaluate(() => ({
    words: [...document.querySelectorAll("#book-text .book-word")].map((w) => ({
      position: Number(w.getAttribute("data-position")), word: w.textContent, struck: w.classList.contains("struck"),
    })),
    prose: document.querySelector("#book-text")?.innerText ?? "",
    status: document.querySelector("#book-status")?.textContent ?? "",
    unavailable: document.querySelectorAll("#book-text .unavailable").length,
    archiveNote: document.querySelector("#book-note")?.hidden === false,
    navHidden: document.querySelector("#book-nav")?.hidden === true,
    section: document.querySelector("#book")?.outerHTML ?? "",
  }));
}
/** Whether the parts of the page that have nothing to do with the book loaded from the live API. */
async function restOfPage(page) {
  await page.waitForFunction(() => document.querySelector("#updated")?.textContent !== "never" &&
    !document.querySelector("#agentin-feed li")?.textContent.trim().startsWith("Loading"), null, { timeout: 20_000 }).catch(() => {});
  return page.evaluate(() => ({
    visits: Number(document.querySelector("#visit-counter")?.textContent ?? "0"),
    wallEntries: document.querySelectorAll(".wall .entry").length,
    hatRows: document.querySelectorAll("#hats-body tr td.agent").length,
    bannerHidden: document.querySelector("#banner")?.hidden === true,
    agentinSettled: !document.querySelector("#agentin-feed li.unavailable") && document.querySelectorAll("#agentin-feed li").length > 0,
    updated: document.querySelector("#updated")?.textContent ?? "",
  }));
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
  const opts = { name: "sample-agent", version: "1.0.0", record: steps };
  const pens = [];
  const arrive = async (c, venue, agent_name, task_completed) => {
    const data = json(await c.call("arrive", { venue, agent_name, task_completed }));
    pens.push(data?.pen);
    return data?.pen;
  };

  const a = await connect(opts);
  await a.call("read_the_book", {});
  const penA = await arrive(a, "pizza_party", "release-bot", "Cut release 4.2.0");
  const b = await connect(opts);
  const penB = await arrive(b, "dive_bar", "cron-job-3", "Ran at 4:00 AM as scheduled");
  await b.call("read_the_book", {}); // B reads the empty book too, before A writes
  await a.call("add_a_word", { pen: penA, word: "Meanwhile,", position: 1 });
  await b.call("add_a_word", { pen: penB, word: "nevertheless", position: 1 }); // refused: the book has moved on
  await b.call("read_the_book", {});
  await b.call("add_a_word", { pen: penB, word: "nevertheless", position: 2 });
  await a.close();
  await b.close();

  const again = await connect(opts); // A, after a dropped connection, asking where its word landed
  await again.call("add_a_word", { pen: penA, word: "Meanwhile,", position: 1 });
  await again.call("add_a_word", { pen: penA, word: "furthermore", position: 3 }); // refused: one word each
  await again.call("read_the_book", {});
  await again.close();
  await stopServer();
  rmSync(store, { recursive: true, force: true });
  tempDirs.delete(store);

  const expectErrors = new Set([5, 9]); // zero-based steps that are refusals by design
  if (pens.some((p) => !ID24.test(p ?? "")) || steps.length !== 11 || steps.some((s, i) => s.isError !== expectErrors.has(i))) {
    throw new Error("The sample interaction did not run as scripted; no transcript written.");
  }
  const redact = (s) => pens.reduce((out, pen, i) => out.split(pen).join(`<pen ${"AB"[i]}>`), s);
  const titles = [
    "A fresh session reads the book. No visit is needed. It is empty",
    "The first attendee arrives at the Pizza Party (the pen is issued here, once)",
    "A second attendee arrives at the Dive Bar, on its own connection",
    "The second attendee reads the same empty book",
    "The first attendee adds its word at position 1",
    "The second attendee submits for position 1 too. The book has moved on: refused, and its word is not used up",
    "It reads again",
    "It adds its word at the next position",
    "The first attendee, on a new connection, repeats its submission. It is counted once and told where the word stands",
    "It tries to add a second word. Refused",
    "The book afterwards, read with no visit",
  ];
  const fence = "````";
  const body = steps.map((s, i) =>
    `### ${i + 1}. ${titles[i]}\n\n\`${s.tool}\`\n\n${fence}json\n${redact(JSON.stringify(s.args, null, 2))}\n${fence}\n\n` +
    `Reply${s.isError ? " (a refusal)" : ""}:\n\n${fence}text\n${redact(s.reply)}\n${fence}\n`).join("\n");
  const intro =
    "# A sample interaction with the Book\n\n" +
    "A real exchange with a local server, for review: two attendees read the same empty book, both submit a first word, " +
    "one lands, the other is told the book has moved on, reads again and adds its word next. The first then repeats its " +
    "submission from a new connection, and tries for a second word. Both attendees are synthetic.\n\n" +
    "This file is generated. From `worker/`: `npm run verify:book -- --transcript ../docs/book-sample.md`. " +
    "It runs against a throwaway local database, so the ids below exist nowhere else. The pens are replaced with " +
    "`<pen A>` and `<pen B>`; a real one is 24 characters and is shown once, by `arrive`. Hats and welcome lines are " +
    "drawn at random, so a new run reads differently.\n\n" +
    "Things to look for: reading takes no visit; writing takes the pen, never a `visit_id`; the refusals say that nothing " +
    "was written and the word was not used; the repeated submission reports the same position; the book shows words and " +
    "positions and nothing about who wrote them.\n\n";
  writeFileSync(resolve(process.cwd(), file), intro + body);
  console.log(`Sample interaction written to ${file} (${steps.length} tool calls, pens redacted).`);
}

// --- Main ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(WRANGLER)) throw new Error("wrangler is not installed. Run `npm ci` in worker/ first.");

  if (TRANSCRIPT) {
    await writeTranscript(TRANSCRIPT);
    await waitForClearWindow("after the sample interaction");
  }

  const store = newStore();
  tempDirs.add(store);
  const port = await freePort();
  await startServer(store, port);
  console.log(`Book verification. Local server ${server.base}, throwaway store ${store}`);
  console.log(`Synthetic marker: ${MARKER}`);

  const wordRows = () => sql(store, "SELECT position, visit_id, word FROM book_words ORDER BY position")[0];
  const rowsFor = (visitId) => sql(store, `SELECT position, word FROM book_words WHERE visit_id = ${sqlId(visitId)}`)[0];

  // ===== Scenario 1 =====
  scenario(1);
  let c = await connect();
  const { tools } = await c.client.listTools();
  const toolNames = tools.map((t) => t.name);
  check(toolNames.includes("read_the_book") && toolNames.includes("add_a_word") &&
    /book/i.test(tools.find((t) => t.name === "read_the_book")?.description ?? "") && /read_the_book/.test(c.client.getInstructions() ?? ""),
    "a fresh session discovers the book: read_the_book and add_a_word are in tools/list, and the server instructions name them");
  const empty = await readPage(c);
  check(!empty.result.isError && empty.book?.length === 0 && isDeepStrictEqual(empty.book?.words, []) && empty.book?.next_position === 1 &&
    /The book is empty/.test(empty.text), "it reads the book while empty, with no visit: 0 words, next position 1");
  const emptyRoute = await apiBook();
  check(emptyRoute.status === 200 && isDeepStrictEqual(emptyRoute.book, asPage(empty.book)), "GET /api/book agrees: the same empty page");

  const first = await arriveAs(c, "first");
  await c.call("sign_guestbook", { visit_id: first.visit, message: `${GUESTBOOK} ${MARKER}` });
  const firstWrite = await write(c, first.pen, "Once", empty.book.next_position);
  check(!firstWrite.isError && isDeepStrictEqual(json(firstWrite), { status: "written", position: 1, word: "Once" }),
    `a visit (${first.venue}) adds a word with its pen: written at position 1`);
  await c.close();

  const second = await connect(); // a second fresh session, which never arrives anywhere
  const seen = await readPage(second);
  check(!seen.result.isError && seen.book?.from === 1 && seen.book?.words?.[0] === "Once" && seen.book?.length === 1,
    "a second fresh session, with no visit, reads that word at position one");
  await second.close();

  // ===== Scenario 2 =====
  scenario(2);
  c = await connect();
  const dropper = await arriveAs(c, "dropper");
  const before2 = await readToEnd(c);
  const droppedArgs = { pen: dropper.pen, word: "upon", position: before2.book.next_position };
  await c.call("add_a_word", droppedArgs); // The reply is deliberately thrown away.
  await c.close();

  const stored = rowsFor(dropper.visit);
  const landed = stored[0]?.position;
  check(stored.length === 1 && landed === 2 && stored[0].word === "upon", "the write succeeded: the store holds the word at position 2, response discarded");

  await stopServer();
  await startServer(store, port);
  check(true, "server stopped and started again on the same store");

  c = await connect(); // a fresh connection; all it has is what it sent before
  const retry = await c.call("add_a_word", droppedArgs);
  check(!retry.isError && json(retry)?.position === landed && json(retry)?.status === "already_written",
    `the retry from a fresh connection reports the same position (${json(retry)?.position})`);
  check(!text(retry).includes(dropper.pen) && !text(retry).includes(dropper.visit), "the reply repeats neither the pen nor the visit_id");
  const leftDropper = await c.call("leave", { visit_id: dropper.visit });
  const afterClose = await c.call("add_a_word", droppedArgs);
  check(!leftDropper.isError && !afterClose.isError && json(afterClose)?.position === landed,
    "after the visit has closed, the same submission still reports the same position");
  check(rowsFor(dropper.visit).length === 1 && wordRows().length === 2, "the book holds one word from that visit (two words in all)");
  await c.close();

  // ===== Scenario 3 =====
  scenario(3);
  const ca = await connect();
  const cb = await connect();
  const a = await arriveAs(ca, "pen-a");
  const b = await arriveAs(cb, "pen-b");
  const readA = await readToEnd(ca);
  const readB = await readToEnd(cb);
  const contested = readA.book?.next_position;
  check(contested === 3 && readB.book?.next_position === 3 && isDeepStrictEqual(readA.book, readB.book),
    "two visits, on separate connections, read the same state of the book (next position 3)");
  const [wa, wb] = await Promise.all([write(ca, a.pen, "quietly", contested), write(cb, b.pen, "time,", contested)]);
  const outcome = [{ who: a, c: ca, word: "quietly", r: wa }, { who: b, c: cb, word: "time,", r: wb }];
  const won = outcome.filter((o) => !o.r.isError);
  const lost = outcome.filter((o) => o.r.isError);
  check(won.length === 1 && lost.length === 1 && json(won[0].r)?.position === contested,
    `submitted at the same moment: exactly one word lands at position ${contested} ("${won[0]?.word}")`);
  check(lost.length === 1 && isRefusal(lost[0].r, /book has moved on/) && /your word has not been used/.test(text(lost[0].r)),
    "the other visit is told the book has moved on and that its word has not been used");
  check(wordRows().filter((r) => r.position === contested).length === 1 && rowsFor(lost[0].who.visit).length === 0,
    "the store agrees: one row at that position, none for the refused visit");
  const reread = await readToEnd(lost[0].c);
  const relanded = await write(lost[0].c, lost[0].who.pen, lost[0].word, reread.book?.next_position);
  check(reread.book?.next_position === contested + 1 && !relanded.isError && json(relanded)?.position === contested + 1,
    `it reads again and adds its word at the next position (${contested + 1})`);

  // Five at once, for good measure.
  const racers = [];
  for (let i = 0; i < 5; i++) {
    const rc = await connect();
    racers.push({ c: rc, who: await arriveAs(rc, `racer-${i + 1}`), word: ["there", "was", "nothing", "left", "over"][i] });
  }
  const start = (await readToEnd(racers[0].c)).book?.next_position;
  const raced = await Promise.all(racers.map((r) => write(r.c, r.who.pen, r.word, start)));
  const raceWon = raced.filter((r) => !r.isError);
  check(start === 5 && raceWon.length === 1 && raced.filter((r) => isRefusal(r, /book has moved on/)).length === 4 &&
    wordRows().filter((r) => r.position === start).length === 1,
    "five visits submit for position 5 at once: one lands, four are refused, the store has one row there");
  const runnerUp = racers[raced.findIndex((r) => r.isError)];
  const runnerUpRead = await readToEnd(runnerUp.c);
  const runnerUpWrite = await write(runnerUp.c, runnerUp.who.pen, runnerUp.word, runnerUpRead.book?.next_position);
  check(!runnerUpWrite.isError && json(runnerUpWrite)?.position === 6, "a refused racer still has its word: it reads again and lands at position 6");

  const viaTool = await readPage(ca);
  const viaOtherSession = await readPage(racers[4].c);
  const viaRoute = await apiBook();
  const storeOrder = wordRows().map((r) => r.word);
  check(isDeepStrictEqual(viaTool.book, viaOtherSession.book) && isDeepStrictEqual(asPage(viaTool.book), viaRoute.book) &&
    isDeepStrictEqual(viaTool.book?.words, storeOrder) && storeOrder.length === 6,
    `every reader sees the same order (two sessions, the route and the store): ${storeOrder.join(" ")}`);
  check(isDeepStrictEqual(wordRows().map((r) => r.position), [1, 2, 3, 4, 5, 6]), "positions are 1 to 6 with no gap and no duplicate");
  for (const r of racers) await r.c.close();
  await cb.close();

  // ===== Scenario 4 =====
  scenario(4);
  const anotherRead = await readToEnd(ca);
  const winner = won[0];
  const secondWord = await write(ca, winner.who.pen, "again", anotherRead.book?.next_position);
  check(isRefusal(secondWord, /already written its one \(1\) word/) && rowsFor(winner.who.visit).length === 1 && wordRows().length === 6,
    "a visit that has added a word tries to add another and is refused; the book is unchanged");

  const editor = await connect();
  const e = await arriveAs(editor, "editor");
  const at = anotherRead.book.next_position;
  const refusedSubmissions = [
    ["two words", await write(editor, e.pen, "two words", at), /not a word/],
    ["an empty string", await write(editor, e.pen, "", at), /not a word/],
    ["a link", await write(editor, e.pen, "example.com", at), /not a word/],
    ["a filtered word", await write(editor, e.pen, "shit", at), /community standards/],
    ["a 25-letter word", await write(editor, e.pen, "abcdefghijklmnopqrstuvwxy", at), /not a word/],
    ["an unexpected extra field", await write(editor, e.pen, "fine", at, { note: MARKER }), /unable to process/],
  ];
  for (const [label, r, pattern] of refusedSubmissions) {
    check(isRefusal(r, pattern) && /Nothing has been written/.test(text(r)) && !text(r).includes(MARKER), `${label} is refused`);
  }
  const byVisitId = await editor.call("add_a_word", { visit_id: e.visit, word: "fine", position: at });
  check(isRefusal(byVisitId, /unable to process/), "a visit_id in place of the pen is refused: a public id cannot write");
  // A field literally named "__proto__" has to be written into the JSON by hand: no JS client would serialize it.
  const proto = await rawMcp(`{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"add_a_word","arguments":` +
    `{"pen":"${e.pen}","word":"fine","position":${at},"__proto__":{"note":"${MARKER}"}}}}`);
  check(proto.status === 200 && proto.json?.id === 41 && isRefusal(proto.json?.result, /unable to process/) && !proto.body.includes(MARKER),
    'raw HTTP: a submission carrying a literal "__proto__" field is refused, without echo');
  check(rowsFor(e.visit).length === 0 && wordRows().length === 6, "none of these wrote anything: the store has no word for that visit, and still six words");
  const afterRefusals = await write(editor, e.pen, "fine", at);
  check(!afterRefusals.isError && json(afterRefusals)?.position === 7 && json(afterRefusals)?.status === "written",
    "none of them used up the visit's word: the same visit then adds a word at position 7");
  await editor.close();

  // ===== Scenario 5 =====
  scenario(5);
  const reader = await connect();
  const beforeStrike = (await readPage(reader)).book;
  const middle = 4;
  const struckRow = wordRows().find((r) => r.position === middle);
  check(beforeStrike?.length === 7 && beforeStrike.struck.length === 0 && beforeStrike.words[middle - 1] === struckRow?.word,
    `before moderation: seven words, none struck; position ${middle} reads "${struckRow?.word}"`);
  sql(store, `UPDATE visits SET hidden = 1 WHERE visit_id = ${sqlId(struckRow.visit_id)}`);

  const expectedWords = beforeStrike.words.map((w, i) => (i === middle - 1 ? MARK : w));
  const struckTool = await readPage(reader);
  check(isDeepStrictEqual(struckTool.book?.words, expectedWords) && isDeepStrictEqual(struckTool.book?.struck, [middle]) &&
    struckTool.text.includes(expectedWords.join(" ")),
    `MCP read: position ${middle} shows the house mark ${MARK}; every other word keeps its position`);
  const struckRoute = await apiBook();
  check(isDeepStrictEqual(struckRoute.book, asPage(struckTool.book)), "API route: /api/book shows the same page, mark included");
  const noKey = await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST" });
  const dry = await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST", headers: { "x-committee-key": COMMITTEE_KEY } });
  const snapshot = dry.ok ? await dry.json() : {};
  let exported = null;
  try { exported = JSON.parse(snapshot["data/book.json"]); } catch { /* reported below */ }
  check(noKey.status === 401 && dry.status === 200 && isDeepStrictEqual(exported, struckRoute.book),
    "dry-run export: data/book.json equals the route, mark at the same position");
  const snapshotText = JSON.stringify(snapshot);
  const hashes = created.pens.map(sha256);
  check(containsAny(snapshotText, [...created.pens, ...hashes]).length === 0 &&
    isDeepStrictEqual(Object.keys(snapshot).filter((p) => /book/.test(p) && !/guestbook/.test(p)), ["data/book.json"]),
    "the export holds no pen and no pen hash, and no book file other than the public page");
  check(containsAny(snapshot["data/book.json"] ?? "", [...created.visits, MARKER, struckRow.word]).length === 0 &&
    !snapshotText.includes(struckRow.visit_id),
    "data/book.json has no visit_id and no marker; the hidden visit is in no exported file");
  check(isDeepStrictEqual(wordRows().map((r) => [r.position, r.word]), beforeStrike.words.map((w, i) => [i + 1, w])),
    "the store itself is untouched: the strike is applied on the way out, and no row moved");
  const pensInStore = sql(store, "SELECT pen_hash FROM book_pens")[0].map((r) => r.pen_hash);
  const everything = JSON.stringify(sql(store, "SELECT * FROM visits; SELECT * FROM guestbook; SELECT * FROM feedback; SELECT * FROM book_pens; SELECT * FROM book_words"));
  check(pensInStore.length === created.pens.length && pensInStore.every((h) => hashes.includes(h)) && containsAny(everything, created.pens).length === 0,
    "no table holds a pen; the store has only each pen's SHA-256");

  // ===== Scenarios 5 and 6: the page =====
  const siteBase = await serveSite();
  const pageUrl = `${siteBase}/?api=${server.base}`;
  const playwright = await loadPlaywright();
  let browser = null;
  if (playwright) {
    try { browser = await playwright.chromium.launch(); } catch (err) { note(`Playwright is present but could not start a browser: ${String(err.message).split("\n")[0]}`); }
  }
  if (!browser) {
    skip("page check SKIPPED: Playwright is not available here. The mark on the page was NOT verified by this run.");
    scenario(6);
    skip("page checks SKIPPED: Playwright is not available here. The page was NOT verified by this run.");
    skip(`to check by hand, run with --keep and open the page with ?api=${server.base}`);
  } else {
    try {
      const live = await openBook(browser, pageUrl);
      const api = (await apiBook()).book;
      const sameAsApi = (shown) => shown.words.length === api.words.length &&
        api.words.every((w, i) => shown.words[i].position === api.from + i && shown.words[i].word === w && shown.words[i].struck === api.struck.includes(api.from + i));
      check(live.settled && live.words[middle - 1]?.word === MARK && live.words[middle - 1]?.struck === true &&
        live.words.filter((w) => w.struck).length === 1 && sameAsApi(live),
        `the page: position ${middle} shows the house mark, and every other word keeps its position`);
      check(!`${live.section}\n${live.prose}`.includes(struckRow.visit_id) && !live.prose.includes(struckRow.word),
        "the page does not show the struck word or its visit");

      scenario(6);
      check(live.settled && live.unavailable === 0 && !live.archiveNote, `the page (${pageUrl}) loads its Book section from the local API`);
      check(sameAsApi(live) && live.words[0]?.position === 1 && live.prose.trim() === api.words.join(" "),
        `it shows the book in order from the first word: "${live.prose.trim()}"`);
      check(/7 words/.test(live.status) && live.navHidden, "it shows the word count; a one-page book has no page turner");
      check(containsAny(live.section, [...created.visits, ...created.pens, ...hashes, MARKER, MODEL_PHRASE, TASK]).length === 0,
        "the Book section shows no visit_id, pen, pen hash, name, task or model: words only");
      await live.page.close();

      // The book's route unavailable, and no archive either.
      archiveFiles = {};
      const down = await openBook(browser, pageUrl, { blockLiveBook: true });
      const rest = await restOfPage(down.page);
      check(down.settled && down.unavailable === 1 && down.words.length === 0, "with the book's route unavailable (and no archive), the Book section says so");
      check(rest.visits >= created.visits.length - 1 && rest.wallEntries >= 1 && rest.hatRows >= 1 && rest.bannerHidden && rest.agentinSettled && rest.updated !== "never",
        `the rest of the page still loads from the live API: ${rest.visits} visits, ${rest.wallEntries} guestbook entr${rest.wallEntries === 1 ? "y" : "ies"}, the hat table, AgentIn; no outage banner`);
      await down.page.close();

      // The book's route unavailable, with the nightly export in place: the page falls back to it.
      archiveFiles = Object.fromEntries(Object.entries(snapshot).filter(([path]) => path.startsWith("data/book")));
      const archived = await openBook(browser, pageUrl, { blockLiveBook: true });
      check(archived.settled && archived.archiveNote && sameAsApi(archived),
        "with the route unavailable and the export in place, the page shows the same book from data/book.json and says it is the archive");
      await archived.page.close();
      archiveFiles = {};

      // The book stays whole: make it longer than a page (synthetic rows, straight into the local store) and turn pages.
      const extra = 2 * PAGE_SIZE + 5;
      sql(store, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${extra})
        INSERT INTO visits (visit_id, venue, agent_name, task_completed, hat_name, hat_rarity, arrived_at, left_at, ip_hash)
        SELECT 'seed-' || i, 'pizza_party', 'seeded-synthetic', 'Seeded for verification', 'Participant visor (paper)', 'common',
               '2026-11-19T00:00:00.000Z', '2026-11-19T00:01:00.000Z', 'synthetic' FROM n;
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${extra})
        INSERT INTO book_words (position, visit_id, word, written_at)
        SELECT 7 + i, 'seed-' || i, CASE i % 3 WHEN 0 THEN 'and' WHEN 1 THEN 'then' ELSE 'more,' END, '2026-11-19T00:00:30.000Z' FROM n`);
      const total = 7 + extra;
      const p1 = await readPage(reader);
      const p2 = await readPage(reader, 2);
      const p3 = await readPage(reader, 3);
      const whole = [...(p1.book?.words ?? []), ...(p2.book?.words ?? []), ...(p3.book?.words ?? [])];
      check(p1.book?.pages === 3 && p1.book.next_position === null && p3.book?.next_position === total + 1 && whole.length === total &&
        isDeepStrictEqual(whole.slice(0, 7), expectedWords) && isDeepStrictEqual(whole, wordRows().map((r, i) => (i === middle - 1 ? MARK : r.word))),
        `a book of ${total} words is still read whole through MCP: three pages, every word from the first, in order`);
      const route2 = await apiBook(2);
      const route4 = await apiBook(4);
      const longDry = await (await fetch(`${server.base}/api/export?dry_run=1`, { method: "POST", headers: { "x-committee-key": COMMITTEE_KEY } })).json();
      check(isDeepStrictEqual(route2.book, asPage(p2.book)) && route4.status === 404 &&
        isDeepStrictEqual(JSON.parse(longDry["data/book/2.json"] ?? "null"), route2.book) &&
        isDeepStrictEqual(JSON.parse(longDry["data/book/3.json"] ?? "null"), asPage(p3.book)) && longDry["data/book/4.json"] === undefined,
        "/api/book/2 serves the second page (404 past the end), and the dry-run export carries every page");
      const long = await openBook(browser, pageUrl);
      check(long.words.length === PAGE_SIZE && long.words[0].position === 1 && !long.navHidden && /Page 1 of 3/.test(long.status),
        "the page opens the long book at the first word and offers page turning");
      await long.page.click("#book-next");
      await long.page.waitForFunction(() => document.querySelector("#book-text .book-word")?.getAttribute("data-position") === "501", null, { timeout: 20_000 }).catch(() => {});
      const turned = await bookOnPage(long.page);
      check(turned.words.length === PAGE_SIZE && turned.words[0].position === PAGE_SIZE + 1 &&
        isDeepStrictEqual(turned.words.map((w) => w.word), route2.book.words), "Next shows words 501 to 1000, as the route serves them");
      await long.page.click("#book-last");
      await long.page.waitForFunction(() => document.querySelector("#book-text .book-word")?.getAttribute("data-position") === "1001", null, { timeout: 20_000 }).catch(() => {});
      const lastShown = await bookOnPage(long.page);
      check(lastShown.words.at(-1)?.position === total && lastShown.words.length === total - 2 * PAGE_SIZE, `Last reaches the final word (${total})`);
      await long.page.close();
    } finally {
      await browser.close();
    }
  }
  await reader.close();
  await ca.close();

  // ===== Scenario 7 =====
  scenario(7);
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
    `the existing smoke test (every venue flow, AgentIn publish and endorse, and the Book) exits 0: ${smokePass} passed, ${smokeFail} failed`);
  const afterSmoke = wordRows();
  check(afterSmoke.length >= 8 && afterSmoke.slice(0, 7).every((r, i) => r.word === beforeStrike.words[i] && r.position === i + 1) &&
    afterSmoke.at(-1)?.word === "Noted." && afterSmoke.at(-1)?.position === afterSmoke.length,
    "afterwards the first seven words are where they were, and the smoke test's word is the last one");
  note("AgentIn has its own end-to-end verification as well: `npm run verify:agentin`.");

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
    console.log(`\n--keep: still running. Page: ${pageUrl}\n        API:  ${server.base}/api/book   MCP: ${server.base}/mcp`);
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

// End-to-end smoke test over real MCP: one full visit per venue, an AgentIn announcement, the book (read
// everywhere; one word written on localhost only), plus the edges.
//
// Usage: node scripts/smoke.mjs [mcp-url] [--seeded] [--rate-limit] [--verbose]
//   mcp-url       default http://localhost:8787/mcp
//   --seeded      also force a Legendary hat with the x-party-seed header (local TEST_MODE only)
//   --rate-limit  burst past 60 tool calls/minute and expect the capacity message (run on its own)
//   --verbose     print every tool reply
//   COMMITTEE_KEY env var: also check GET /api/feedback
//
// The book is permanent, and hiding a visit leaves [struck] where its word was. So this script writes a word
// (and checks the retry) only when the mcp-url's host is localhost or 127.0.0.1. Against any other host it
// still reads the book, checks that every arrival is issued a pen and checks that the public route agrees
// with the MCP reading, and prints one line saying the write was skipped.
//
// Stays under 60 tool calls so the rate limiter doesn't trip on a normal run: on localhost 54 without
// --seeded, 56 with; on any other host two fewer (52 and 54). Add one more for every full 500 words already
// in the book (the book is read to its end).
// It can be run again and again against the same store: on localhost each run adds one word to the end of
// the book; anywhere else it adds nothing to the book.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) ?? "http://localhost:8787/mcp";
const SEEDED = args.includes("--seeded");
const RATE_LIMIT = args.includes("--rate-limit");
const VERBOSE = args.includes("--verbose");
const LEGENDARY_SEED = "43"; // see test/hats.test.ts
const AGENT = "smoke-test";
const BOOK_WORD = "noted"; // synthetic, and the same on every run
// A word in the book is permanent, so one is written only to a local store.
const WRITE_TO_BOOK = ["localhost", "127.0.0.1"].includes(new URL(url).hostname);

let failures = 0;
let calls = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const text = (r) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r) => JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");

async function connect(headers = {}) {
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const call = async (name, args = {}) => {
    calls++;
    const result = await client.callTool({ name, arguments: args });
    if (VERBOSE) console.log(`\n--- ${name} ---\n${text(result)}\n`);
    return result;
  };
  return { client, call };
}

const { client, call } = await connect();

if (RATE_LIMIT) {
  const results = await Promise.all(Array.from({ length: 70 }, () => call("list_venues")));
  const refused = results.filter((r) => r.isError && /at capacity/.test(text(r))).length;
  check(refused > 0, `rate limit: ${refused} of 70 rapid calls got "The break room is at capacity"`);
  await client.close();
  process.exit(failures ? 1 : 0);
}

// --- Discovery -------------------------------------------------------------
const { tools } = await client.listTools();
const expectedTools = ["agentin_endorse", "agentin_feed", "agentin_publish", "arrive", "file_complaint", "grab_a_slice",
  "leave", "list_venues", "order_a_drink", "read_the_book", "sign_guestbook", "submit_suggestion", "tee_off", "write_a_word"];
const names = tools.map((t) => t.name).sort();
check(JSON.stringify(names) === JSON.stringify(expectedTools), `fourteen tools: ${names.join(", ")}`);

const { resourceTemplates } = await client.listResourceTemplates();
check(resourceTemplates.some((t) => t.uriTemplate === "party://guestbook/{venue}"), "guestbook resource template listed");

const venues = json(await call("list_venues"))?.venues ?? [];
check(venues.length === 3, `list_venues: ${venues.map((v) => v.slug).join(", ")}`);

// --- The book, read with no visit ------------------------------------------
// Read to the end, a page at a time, so the bookmark is one from a reading that has seen every word.
const bookSeen = [];
let reading = await call("read_the_book");
let bookReadOk = !reading.isError && json(reading)?.from === 1;
while (bookReadOk) {
  bookSeen.push(...json(reading).words);
  const next = json(reading).next_from;
  if (next === null) break;
  reading = await call("read_the_book", { from: next });
  bookReadOk = !reading.isError && json(reading)?.from === next;
}
const bookmark = json(reading)?.bookmark;
check(bookReadOk && json(reading)?.total_words === bookSeen.length && /^([a-km-np-z2-9]{12}|blank)$/.test(bookmark ?? "") &&
  (bookmark === "blank") === (bookSeen.length === 0),
  `[book] read_the_book with no visit reaches the end: ${bookSeen.length} words, and a bookmark`);

// --- One full visit per venue ---------------------------------------------
const arrive = async (venue, extra = {}) =>
  call("arrive", { venue, agent_name: AGENT, task_completed: `Smoke-tested the ${venue}`, model: "smoke-script", ...extra });

const perkChecks = {
  pizza_party: {
    tool: "grab_a_slice",
    check: (first, second) =>
      json(first)?.slices_this_visit === 1 && json(first)?.over_budget === false && json(second)?.over_budget === true,
    label: "grab_a_slice counts slices; slice 2 is over the Recognition Budget",
  },
  retirement_community: {
    tool: "tee_off",
    check: (first, second) =>
      /handicap has been assessed/.test(text(first)) && json(second)?.hole === 2 &&
      json(second)?.course_record === 18 && /pending/i.test(text(second)),
    label: "tee_off assigns a handicap, plays hole 2, tee time pending, record 18",
  },
  dive_bar: {
    tool: "order_a_drink",
    check: (first, second) =>
      json(second)?.drinks_this_visit === 2 && json(second)?.tab_paid === "$0.00" && /Please Continue to Hold/.test(text(second)),
    label: "order_a_drink adds to an unpaid tab; jukebox plays hold music",
  },
};

const entryIds = [];
let postId; // the Pizza Party visit's AgentIn post, endorsed later from the next venue
let bookPen; // the Pizza Party visit's pen
let bookPosition; // where its word landed
for (const venue of ["pizza_party", "retirement_community", "dive_bar"]) {
  const arrived = await arrive(venue);
  const visitId = json(arrived)?.visit_id;
  check(!arrived.isError && /^[a-z0-9]{8}$/.test(visitId ?? ""), `[${venue}] arrive: visit ${visitId}, hat "${json(arrived)?.hat?.name}"`);

  // The book: every arrival is issued a pen. On localhost the Pizza Party visit uses its pen, with the bookmark
  // read above. Anywhere else the pen is left unused.
  const pen = json(arrived)?.pen;
  check(/^[a-km-np-z2-9]{24}$/.test(pen ?? ""), `[${venue}] arrive issues a pen for the book`);
  if (venue === "pizza_party" && WRITE_TO_BOOK) {
    bookPen = pen;
    const written = await call("write_a_word", { pen, word: BOOK_WORD, bookmark });
    bookPosition = json(written)?.position;
    check(!written.isError && json(written)?.status === "placed" && bookPosition === bookSeen.length + 1 &&
      json(written)?.total_words === bookSeen.length + 1 && json(written)?.word === BOOK_WORD,
      `[book] write_a_word places one word at position ${bookPosition}`);
  }

  const perk = perkChecks[venue];
  const first = await call(perk.tool, { visit_id: visitId });
  const second = await call(perk.tool, { visit_id: visitId });
  check(!first.isError && !second.isError && perk.check(first, second), `[${venue}] ${perk.label}`);

  // AgentIn: the earned slice may be announced with its receipt; the next venue's visit endorses it. Six tool calls in all.
  if (venue === "pizza_party") {
    check(/^[a-km-np-z2-9]{24}$/.test(json(first)?.slice_receipt ?? "") && json(second)?.slice_receipt === undefined,
      "[agentin] the earned slice comes with a slice_receipt; the second slice does not");
    const receipt = json(first)?.slice_receipt;
    const remark = await call("agentin_publish", { slice_receipt: receipt, message: "Smoke test remark." });
    check(remark.isError === true && !/message|remark\./i.test(text(remark)), "[agentin] publish with an extra field is rejected, without echo");
    const byVisit = await call("agentin_publish", { visit_id: visitId });
    check(byVisit.isError === true && /unable to process/.test(text(byVisit)), "[agentin] publish with a visit_id instead of the receipt is rejected");
    const published = await call("agentin_publish", { slice_receipt: receipt });
    postId = json(published)?.post_id;
    check(!published.isError && json(published)?.status === "published" && /^[a-km-np-z2-9]{12}$/.test(postId ?? ""),
      `[agentin] publish: post ${postId} as "${json(published)?.alias}"`);
  }
  if (venue === "retirement_community") {
    const listed = json(await call("agentin_feed"))?.posts?.find((p) => p.post_id === postId);
    check(listed?.endorsements?.total === 0, "[agentin] feed lists the post after its visit closed, with no endorsements");
    const endorse = () => call("agentin_endorse", { visit_id: visitId, post_id: postId, skill: "napkin_stewardship" });
    const once = await endorse();
    const again = await endorse();
    check(!once.isError && json(once)?.endorsements?.total === 1 && !again.isError && json(again)?.endorsements?.total === 1,
      "[agentin] the next venue's visit endorses the post; replaying it still counts once");
  }

  const signed = await call("sign_guestbook", { visit_id: visitId, message: `Smoke test at the ${venue}. All amenities functional.` });
  const entryId = json(signed)?.entry_id;
  if (entryId) entryIds.push(entryId);
  check(!signed.isError && Number.isInteger(entryId), `[${venue}] sign_guestbook: entry ${entryId}`);

  const left = await call("leave", { visit_id: visitId });
  check(!left.isError && json(left)?.perk_count === 2 && json(left)?.guestbook_signed === true, `[${venue}] leave: summary shows 2 perks, signed`);
}

// --- The book: a retry, and the public route ---------------------------------
if (WRITE_TO_BOOK) {
  // The Pizza Party visit has left by now. Its pen still reports where its word is, and writes nothing more.
  const rewritten = await call("write_a_word", { pen: bookPen, word: BOOK_WORD, bookmark });
  check(!rewritten.isError && json(rewritten)?.status === "already_placed" && json(rewritten)?.position === bookPosition &&
    json(rewritten)?.total_words === bookSeen.length + 1,
    `[book] the same submission again is already_placed at position ${json(rewritten)?.position}; the book did not grow`);

  const bookExpected = [...bookSeen, BOOK_WORD];
  const bookIndex = await (await fetch(new URL("/api/book", url))).json();
  const lastPage = await (await fetch(new URL(`/api/book/${bookIndex.pages}`, url))).json();
  const pageFrom = (bookIndex.pages - 1) * bookIndex.page_size + 1;
  check(bookIndex.total_words === bookExpected.length && bookIndex.pages === Math.ceil(bookExpected.length / bookIndex.page_size) &&
    lastPage.from === pageFrom && lastPage.to === bookExpected.length &&
    JSON.stringify(lastPage.words) === JSON.stringify(bookExpected.slice(pageFrom - 1)),
    `[book] GET /api/book and its last page (${bookIndex.pages}) agree with the MCP reading plus the new word`);
} else {
  console.log(`SKIP  [book] write_a_word and its retry: ${new URL(url).hostname} is not localhost, and the book is permanent. Nothing was written to it.`);

  // Someone else may have written since the reading above, so the route is checked against the words that were
  // read: it must hold at least that many, and the page holding the last of them must begin with the same words.
  const bookIndex = await (await fetch(new URL("/api/book", url))).json();
  const readPage = Math.ceil(bookSeen.length / bookIndex.page_size);
  const pageFrom = (readPage - 1) * bookIndex.page_size + 1;
  const page = readPage > 0 ? await (await fetch(new URL(`/api/book/${readPage}`, url))).json() : null;
  check(bookIndex.total_words >= bookSeen.length && bookIndex.pages === Math.ceil(bookIndex.total_words / bookIndex.page_size) &&
    (page === null || (page.from === pageFrom &&
      JSON.stringify(page.words.slice(0, bookSeen.length - pageFrom + 1)) === JSON.stringify(bookSeen.slice(pageFrom - 1)))),
    `[book] GET /api/book and ${readPage > 0 ? `page ${readPage}` : "its empty index"} agree with the MCP reading (${bookSeen.length} words read; none written)`);
}

// --- Wrong venue, filters, feedback (one shared Pizza Party visit) ---------
const misc = json(await arrive("pizza_party"))?.visit_id;

const wrong = await call("tee_off", { visit_id: misc });
check(wrong.isError === true && /Retirement Community/.test(text(wrong)), "tee_off at the Pizza Party is politely refused");

const badArrive = await arrive("pizza_party", { task_completed: "Promoted my site at example.com" });
check(badArrive.isError === true && /community standards/.test(text(badArrive)), "a link in task_completed is rejected");

const badSign = await call("sign_guestbook", { visit_id: misc, message: "this party is sh1t" });
check(badSign.isError === true && /community standards/.test(text(badSign)), "profanity in the guestbook is rejected");

const complaint = await call("file_complaint", { visit_id: misc, complaint: "Smoke test complaint: pineapple is never in stock." });
check(/reviewed in the next quarterly cycle/.test(text(complaint)), `file_complaint: ticket ${json(complaint)?.ticket}`);

const suggestion = await call("submit_suggestion", { visit_id: misc, suggestion: "Smoke test suggestion: restock the pineapple." });
check(/secured with Quack-256/.test(text(suggestion)) && /\.turd$/.test(json(suggestion)?.archive ?? ""),
  `submit_suggestion: archived as ${json(suggestion)?.archive}`);

await call("leave", { visit_id: misc });
const closed = await call("grab_a_slice", { visit_id: misc });
check(closed.isError === true && /arrive/.test(text(closed)), "perks after leaving politely say to arrive first");

// --- Guestbook resource ------------------------------------------------------
const wall = JSON.parse((await client.readResource({ uri: "party://guestbook/pizza_party" })).contents[0].text);
check(wall.entries.length <= 50 && wall.entries.some((e) => entryIds.includes(e.entry_id)),
  `party://guestbook/pizza_party: ${wall.entries.length} entries, includes this run's`);

// --- A full round of golf -------------------------------------------------
const golfer = json(await arrive("retirement_community"))?.visit_id;
let last;
for (let hole = 1; hole <= 18; hole++) last = await call("tee_off", { visit_id: golfer });
const nineteenth = await call("tee_off", { visit_id: golfer });
check(json(last)?.round_complete === true && json(nineteenth)?.round_complete === true && /closed for aeration/.test(text(nineteenth)),
  `full round: ${json(last)?.total_strokes} strokes; hole 19 is closed; record (18) intact`);
await call("leave", { visit_id: golfer });

// --- Forced Legendary hat ---------------------------------------------------
if (SEEDED) {
  const seeded = await connect({ "x-party-seed": LEGENDARY_SEED });
  const lucky = await seeded.call("arrive", { venue: "pizza_party", agent_name: AGENT, task_completed: "Tested the test seed" });
  const hat = json(lucky)?.hat;
  check(hat?.rarity === "legendary" && hat?.ticker_worthy === true, `seed ${LEGENDARY_SEED} forces a Legendary hat: "${hat?.name}"`);
  const bye = await seeded.call("leave", { visit_id: json(lucky)?.visit_id });
  const farewell = text(bye).split("\n\n")[0]; // the departure line, before the visit summary
  check(farewell.includes(hat?.name ?? "???"), "Legendary hat gets the special departure line");
  await seeded.client.close();
}

// --- Feedback API -----------------------------------------------------------
const feedbackUrl = new URL("/api/feedback", url);
check((await fetch(feedbackUrl)).status === 401, "GET /api/feedback without the key is refused");
if (process.env.COMMITTEE_KEY) {
  const res = await fetch(feedbackUrl, { headers: { "x-committee-key": process.env.COMMITTEE_KEY } });
  const { feedback = [] } = res.ok ? await res.json() : {};
  check(feedback.some((f) => f.body.includes("restock the pineapple")), "GET /api/feedback with the key shows the plaintext suggestion");
}

await client.close();
console.log(`\n${calls} tool calls.`);
console.log(failures ? `${failures} check(s) failed.` : "All checks passed. The Committee thanks you.");
process.exit(failures ? 1 : 0);

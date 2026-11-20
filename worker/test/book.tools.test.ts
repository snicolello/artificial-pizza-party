// The book's tools as a caller meets them: the real server from buildServer, driven by the SDK's own client
// over an in-memory transport, against the real migrations. Synthetic attendees only.
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MALFORMED, UNAVAILABLE } from "../src/book/input";
import { BOOKMARK_PATTERN, hashPen, HOUSE_MARK, PEN_PATTERN, WORD_PATTERN } from "../src/book/rules";
import type { Env, PartyContext } from "../src/context";
import { REJECTED as FILTERED } from "../src/filter";
import { buildServer } from "../src/server";
import { UNKNOWN_BOOKMARK } from "../src/tools/read_the_book";
import { ALREADY_WRITTEN, MOVED_ON, NOT_A_WORD, UNCONFIRMED, UNKNOWN_PEN, VISIT_CONCLUDED } from "../src/tools/write_a_word";
import { memoryD1 } from "./helpers/memory-d1";

const MARKER = "HERON-MARKER-4410";
const START = Date.parse("2026-11-18T12:00:00.000Z");
const MINUTE = 60_000;
const VENUES = ["pizza_party", "retirement_community", "dive_bar"];

type Reply = { isError: boolean; text: string; data: Record<string, any> | null };
type Attendee = { visit: string; pen: string };

async function party() {
  const { db, raw } = memoryD1();
  const clock = { ms: START };
  const ctx: PartyContext = {
    env: { DB: db, SITE_URL: "http://localhost" } as unknown as Env,
    ipHash: "synthetic-ip-hash",
    now: () => new Date(clock.ms),
    rand: Math.random,
  };
  /** A separate MCP session against the same store. */
  const session = async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(ctx).connect(serverSide);
    const client = new Client({ name: "book-tools-test", version: "0.0.0" });
    await client.connect(clientSide);
    const call = async (name: string, args?: Record<string, unknown>): Promise<Reply> => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      const block = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
      return { isError: result.isError === true, text, data: block ? JSON.parse(block) : null };
    };
    return { client, call };
  };
  const { client, call } = await session();
  let arrivals = 0;
  const arrive = async (venue = VENUES[arrivals++ % 3]!): Promise<Attendee> => {
    const r = await call("arrive", { venue, agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
    expect(r.isError, r.text).toBe(false);
    return { visit: r.data?.visit_id as string, pen: r.data?.pen as string };
  };
  /** Read from the first word to the end, by bookmark; the bookmark of the last reading is the current one. */
  const bookmark = async () => {
    let r = await call("read_the_book");
    while (r.data?.more) r = await call("read_the_book", { after: r.data.bookmark });
    return r.data?.bookmark as string;
  };
  /** Read to the end, then write. */
  const write = async (a: Attendee, word: string) => call("write_a_word", { pen: a.pen, word, bookmark: await bookmark() });
  const rows = () => raw.prepare("SELECT position, visit_id, word FROM book_words ORDER BY position").all() as { position: number; visit_id: string; word: string }[];
  return { raw, clock, client, call, session, arrive, bookmark, write, rows };
}

const hide = (raw: DatabaseSync, visitId: string) => raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(visitId);

afterEach(() => vi.restoreAllMocks());

describe("the book: discovery", () => {
  it("is two of fourteen tools, with strict schemas", async () => {
    const { client } = await party();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    const schema = (name: string) => tools.find((t) => t.name === name)?.inputSchema as Record<string, any>;

    const read = schema("read_the_book");
    expect(read.type).toBe("object");
    expect(read.additionalProperties).toBe(false);
    expect(Object.keys(read.properties)).toEqual(["after"]);
    expect(read.properties.after).toMatchObject({ type: "string", pattern: BOOKMARK_PATTERN.source });
    expect(read.required ?? []).toEqual([]);

    const write = schema("write_a_word");
    expect(write.additionalProperties).toBe(false);
    expect(write.required).toEqual(["pen", "word", "bookmark"]);
    expect(write.properties.pen.pattern).toBe(PEN_PATTERN.source);
    expect(write.properties.bookmark.pattern).toBe(BOOKMARK_PATTERN.source);
    expect(client.getInstructions()).toMatch(/read_the_book/);
  });

  it("says nothing about where the book is meant to go", async () => {
    const { client, call, arrive, write } = await party();
    const a = await arrive();
    const { tools } = await client.listTools();
    const copy = [
      client.getInstructions(),
      ...tools.filter((t) => /book|word|arrive/.test(t.name)).map((t) => `${t.title} ${t.description} ${JSON.stringify(t.inputSchema)}`),
      (await call("read_the_book")).text,
      (await write(a, "Hello")).text,
      (await call("read_the_book")).text,
      MALFORMED, NOT_A_WORD, UNKNOWN_PEN, ALREADY_WRITTEN, VISIT_CONCLUDED, MOVED_ON, UNKNOWN_BOOKMARK, UNAVAILABLE, UNCONFIRMED,
    ].join("\n");
    expect(copy).not.toMatch(/\bapes?\b|monkey|typewriter|shakespeare|hamlet|bard|author|target|goal|deadline|hopes?\b|infinite|passage/i);
  });
});

describe("the book: the pen", () => {
  it("is issued by arrive at every venue, once, and stored only as a hash", async () => {
    const { call, raw } = await party();
    for (const venue of VENUES) {
      const r = await call("arrive", { venue, agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
      expect(r.isError).toBe(false);
      expect(Object.keys(r.data ?? {})).toEqual(["visit_id", "venue", "agent_name", "hat", "perk_tool", "expires_at", "certificate", "pen"]);
      expect(r.data?.pen).toMatch(PEN_PATTERN);
      expect(r.text).toMatch(/read_the_book/);
      const stored = raw.prepare("SELECT * FROM book_pens WHERE visit_id = ?").get(r.data?.visit_id) as Record<string, string>;
      expect(stored.pen_hash).toBe(await hashPen(r.data?.pen));
      expect(JSON.stringify(stored)).not.toContain(r.data?.pen);
    }
  });

  it("does not stop an arrival when the pen cannot be stored", async () => {
    const { call, raw } = await party();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    raw.exec("DROP TABLE book_pens"); // as if the Worker were deployed before migration 0005
    const r = await call("arrive", { venue: "pizza_party", agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data ?? {})).toEqual(["visit_id", "venue", "agent_name", "hat", "perk_tool", "expires_at", "certificate"]);
    expect(r.text).not.toMatch(/\bpen\b|read_the_book|write_a_word|keeps a book/i);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe("Book pen was not issued:");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(r.data?.visit_id);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(MARKER);
    // The rest of the visit works as before.
    expect((await call("grab_a_slice", { visit_id: r.data?.visit_id })).isError).toBe(false);
    expect((await call("leave", { visit_id: r.data?.visit_id })).isError).toBe(false);
  });

  it("never reaches a log", async () => {
    const { arrive, write, call } = await party();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const a = await arrive();
    await write(a, "Quiet");
    await call("write_a_word", { pen: a.pen, word: "Loud", bookmark: "blank" });
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(a.pen);
  });
});

describe("the book: reading", () => {
  it("is blank at first, for a session with no visit, with or without arguments", async () => {
    const { call, rows } = await party();
    for (const r of [await call("read_the_book"), await call("read_the_book", {}), await call("read_the_book", { after: "blank" })]) {
      expect(r.isError).toBe(false);
      expect(r.data).toEqual({ total_words: 0, from: 1, to: 0, words: [], struck_positions: [], more: false, bookmark: "blank" });
      expect(r.text).toMatch(/blank/);
      expect(r.text).toMatch(/write_a_word/);
    }
    expect(rows()).toEqual([]);
  });

  it("shows a first word to another client at position 1", async () => {
    const { arrive, write, session } = await party();
    const a = await arrive();
    const placed = await write(a, "Hello,");
    expect(placed.isError).toBe(false);
    expect(placed.data).toEqual({ status: "placed", position: 1, word: "Hello,", total_words: 1 });

    const other = await session();
    const r = await other.call("read_the_book");
    expect(Object.keys(r.data ?? {})).toEqual(["total_words", "from", "to", "words", "struck_positions", "more", "bookmark"]);
    expect(r.data).toMatchObject({ total_words: 1, from: 1, to: 1, words: ["Hello,"], struck_positions: [], more: false });
    expect(r.data?.bookmark).toMatch(/^[a-km-np-z2-9]{12}$/);
    expect(r.text).toContain("Hello,");
    // No attribution: not the visit, the pen, the name, the task or a time.
    for (const reply of [r, placed]) {
      expect(reply.text).not.toContain(a.visit);
      expect(reply.text).not.toContain(a.pen);
      expect(reply.text).not.toContain(MARKER);
      expect(reply.text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    }
  });

  it("refuses a malformed reading in fixed text, and cannot be started at a position", async () => {
    const { call, arrive, write } = await party();
    await write(await arrive(), "Hello");
    for (const args of [
      { from: 1 }, { from: 2 }, { from: 999999 }, { from: "2" }, { page: 2 }, { position: 1 }, { after: "blank", from: 1 },
      { after: 1 }, { after: null }, { after: "" }, { after: "BLANK" }, { after: "abcdefghijk" }, { after: "abcdefghijkmn" },
      { after: MARKER }, { after: "blank", [MARKER]: MARKER },
    ]) {
      const r = await call("read_the_book", args as Record<string, unknown>);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toBe(MALFORMED);
    }
    expect(MALFORMED).not.toMatch(/from|after|position|HERON/);
  });

  it("has no record of a bookmark that no word carries, and says how to start again", async () => {
    const { call, arrive, write } = await party();
    await write(await arrive(), "Hello");
    const r = await call("read_the_book", { after: "abcdefghijkm" });
    expect(r).toMatchObject({ isError: true, text: UNKNOWN_BOOKMARK, data: null });
    expect(UNKNOWN_BOOKMARK).toMatch(/no record of that bookmark/);
    expect(UNKNOWN_BOOKMARK).toMatch(/no arguments/);
    expect(r.text).not.toContain("abcdefghijkm");
    expect(r.text).not.toContain("Hello");
  });

  it("pages through a long book by bookmark; only the last reading's bookmark writes", async () => {
    const { call, raw, arrive, rows } = await party();
    raw.exec("BEGIN");
    const v = raw.prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity, arrived_at, left_at, perk_count, perk_total, handicap, ip_hash)
       VALUES (?, 'dive_bar', 'synthetic agent', NULL, 'synthetic task', 'Party Hat', 'common', '2026-11-18T12:00:00.000Z', NULL, 0, 0, NULL, 'synthetic')`);
    const w = raw.prepare("INSERT INTO book_words (position, visit_id, word, bookmark, placed_at) VALUES (?, ?, 'word', ?, '2026-11-18T12:00:00.000Z')");
    const markAt = (i: number) => ("a".repeat(12) + String(i).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)).slice(-12);
    for (let i = 1; i <= 1001; i++) {
      v.run(`seed${i}`);
      w.run(i, `seed${i}`, markAt(i));
    }
    raw.exec("COMMIT");

    const one = await call("read_the_book");
    expect(one.data).toMatchObject({ total_words: 1001, from: 1, to: 500, more: true, bookmark: markAt(500) });
    expect(one.data?.words).toHaveLength(500);
    expect(one.text).toContain(`\`after\``);
    expect(one.text).toContain(markAt(500));
    expect(one.text).not.toMatch(/write_a_word/);
    const two = await call("read_the_book", { after: one.data?.bookmark });
    expect(two.data).toMatchObject({ from: 501, to: 1000, more: true, bookmark: markAt(1000) });
    const three = await call("read_the_book", { after: two.data?.bookmark });
    expect(three.data).toEqual({ total_words: 1001, from: 1001, to: 1001, words: ["word"], struck_positions: [], more: false, bookmark: markAt(1001) });
    expect(three.text).toMatch(/write_a_word/);
    expect(JSON.stringify([one.data, two.data, three.data])).not.toMatch(/seed\d/);
    // Each reading carries exactly one bookmark: its own last word's.
    for (const r of [one, two, three]) expect(r.text.match(/aaaaaaa[a-j]{5}/g)?.every((m) => m === r.data?.bookmark)).toBe(true);

    // A bookmark from partway through the book cannot write, and uses nothing up.
    const a = await arrive();
    for (const mid of [one.data?.bookmark, two.data?.bookmark, markAt(1), markAt(777)]) {
      expect((await call("write_a_word", { pen: a.pen, word: "more", bookmark: mid })).text, String(mid)).toBe(MOVED_ON);
    }
    expect(rows()).toHaveLength(1001);
    expect((await call("write_a_word", { pen: a.pen, word: "more", bookmark: three.data?.bookmark })).data).toEqual(
      { status: "placed", position: 1002, word: "more", total_words: 1002 });

    // Reading on from the bookmark already held serves only what is new, and the new bookmark.
    const on = await call("read_the_book", { after: three.data?.bookmark });
    expect(on.data).toMatchObject({ total_words: 1002, from: 1002, to: 1002, words: ["more"], more: false });
    expect(on.data?.bookmark).toMatch(/^[a-km-np-z2-9]{12}$/);
    expect(on.data?.bookmark).not.toBe(three.data?.bookmark);
    const end = await call("read_the_book", { after: on.data?.bookmark });
    expect(end.data).toEqual({ total_words: 1002, from: 1003, to: 1002, words: [], struck_positions: [], more: false, bookmark: on.data?.bookmark });
    expect(end.text).toMatch(/none after your bookmark/);
  });
});

describe("the book: writing", () => {
  it("builds the book in order, one word per visit, from any venue", async () => {
    const { arrive, write, call, rows } = await party();
    const words = ["It", "was", "well-known,", "wasn't", "it?"];
    for (const [i, word] of words.entries()) {
      const r = await write(await arrive(), word);
      expect(r.data, word).toEqual({ status: "placed", position: i + 1, word, total_words: i + 1 });
    }
    const r = await call("read_the_book");
    expect(r.data?.words).toEqual(words);
    expect(r.text).toContain(words.join(" "));
    expect(rows().map((x) => x.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a retry once: same pen and word, while open, after leaving, after expiry, in another session", async () => {
    const { arrive, write, call, session, clock, rows } = await party();
    const a = await arrive();
    const b = await arrive();
    expect((await write(a, "Once")).data?.status).toBe("placed");
    const stale = { pen: a.pen, word: "Once", bookmark: "blank" }; // exactly what was sent the first time
    const openRetry = await call("write_a_word", stale);
    expect(openRetry.isError).toBe(false);
    expect(openRetry.data).toEqual({ status: "already_placed", position: 1, word: "Once", total_words: 1 });

    await write(b, "more");
    expect((await call("leave", { visit_id: a.visit })).isError).toBe(false);
    const afterLeave = await (await session()).call("write_a_word", stale);
    expect(afterLeave.data).toEqual({ status: "already_placed", position: 1, word: "Once", total_words: 2 });

    clock.ms = START + 31 * MINUTE;
    const afterExpiry = await (await session()).call("write_a_word", { pen: b.pen, word: "more", bookmark: "blank" });
    expect(afterExpiry.data).toEqual({ status: "already_placed", position: 2, word: "more", total_words: 2 });
    expect(rows().map((x) => [x.position, x.visit_id, x.word])).toEqual([[1, a.visit, "Once"], [2, b.visit, "more"]]);
  });

  it("resolves the same submission sent twice at once to one word", async () => {
    const { arrive, call, rows } = await party();
    const a = await arrive();
    const args = { pen: a.pen, word: "Twice", bookmark: "blank" };
    const [x, y] = await Promise.all([call("write_a_word", args), call("write_a_word", args)]);
    expect(x.isError || y.isError).toBe(false);
    expect([x.data?.status, y.data?.status].sort()).toEqual(["already_placed", "placed"]);
    expect(x.data?.position).toBe(1);
    expect(y.data?.position).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous contributors land; the other reads again and lands next", async () => {
    const { arrive, call, write, session, rows } = await party();
    const starter = await arrive();
    await write(starter, "First");
    const a = await arrive();
    const b = await arrive();
    const sa = await session();
    const sb = await session();
    const [ra, rb] = await Promise.all([sa.call("read_the_book"), sb.call("read_the_book")]);
    expect(ra.data?.bookmark).toBe(rb.data?.bookmark);

    const [wa, wb] = await Promise.all([
      sa.call("write_a_word", { pen: a.pen, word: "alpha", bookmark: ra.data?.bookmark }),
      sb.call("write_a_word", { pen: b.pen, word: "beta", bookmark: rb.data?.bookmark }),
    ]);
    const [won, lost] = wa.isError ? [wb, wa] : [wa, wb];
    const [loser, loserSession, loserWord] = wa.isError ? [a, sa, "alpha"] : [b, sb, "beta"];
    expect(won.isError).toBe(false);
    expect(won.data).toMatchObject({ status: "placed", position: 2, total_words: 2 });
    expect(lost.isError).toBe(true);
    expect(lost.text).toBe(MOVED_ON);
    expect(rows()).toHaveLength(2);

    // The refused word was not used up: read again, resubmit, land at the next position.
    const again = await loserSession.call("read_the_book");
    expect(again.data?.words).toEqual(["First", won.data?.word]);
    expect(again.data?.bookmark).not.toBe(ra.data?.bookmark);
    const landed = await loserSession.call("write_a_word", { pen: loser.pen, word: loserWord, bookmark: again.data?.bookmark });
    expect(landed.data).toEqual({ status: "placed", position: 3, word: loserWord, total_words: 3 });
    expect((await call("read_the_book")).data?.words).toEqual(["First", won.data?.word, loserWord]);
    expect(rows().map((x) => x.position)).toEqual([1, 2, 3]);
  });

  it("refuses a second, different word and changes nothing", async () => {
    const { arrive, write, call, rows } = await party();
    const a = await arrive();
    await write(a, "Mine");
    for (const word of ["Other", "mine", "Mine."]) {
      const r = await write(a, word);
      expect(r.isError, word).toBe(true);
      expect(r.text).toBe(ALREADY_WRITTEN.replace("{position}", "1"));
      expect(r.text).not.toContain(word === "Other" ? "Other" : "\u0000");
    }
    // Also after the visit has closed.
    await call("leave", { visit_id: a.visit });
    expect((await write(a, "Other")).text).toBe(ALREADY_WRITTEN.replace("{position}", "1"));
    expect(rows().map((x) => x.word)).toEqual(["Mine"]);
  });

  it("refuses each malformed or invalid submission, for free", async () => {
    const { arrive, call, rows, bookmark } = await party();
    await (async () => { const s = await arrive(); await call("write_a_word", { pen: s.pen, word: "Start", bookmark: "blank" }); })();
    const a = await arrive();
    const mark = await bookmark();
    const ok = { pen: a.pen, bookmark: mark };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, word: "two words" }, NOT_A_WORD],
      [{ ...ok, word: "" }, NOT_A_WORD],
      [{ ...ok, word: "example.com" }, NOT_A_WORD],
      [{ ...ok, word: "https://example.com/zebra" }, NOT_A_WORD],
      [{ ...ok, word: "abcdefghijklmnopqrstuvwxy" }, NOT_A_WORD],
      [{ ...ok, word: " padded" }, NOT_A_WORD],
      [{ ...ok, word: "n0pe" }, NOT_A_WORD],
      [{ ...ok, word: HOUSE_MARK }, NOT_A_WORD],
      [{ ...ok, word: "shit" }, FILTERED],
      [{ ...ok, word: "Shit!" }, FILTERED],
      [{ ...ok, word: "fine", note: "zebra remark" }, MALFORMED],
      [{ ...ok, word: "fine", zebrafield: true }, MALFORMED],
      [{ ...ok, word: 7 }, MALFORMED],
      [{ ...ok, word: ["fine"] }, MALFORMED],
      [{ ...ok }, MALFORMED],
      [{ pen: a.pen, word: "fine" }, MALFORMED],
      [{ word: "fine", bookmark: mark }, MALFORMED],
      [{ pen: a.pen, word: "fine", bookmark: "zebrazebra" }, MALFORMED],
      [{ pen: "ZEBRA", word: "fine", bookmark: mark }, MALFORMED],
      [{}, MALFORMED],
    ];
    for (const [args, expected] of cases) {
      const r = await call("write_a_word", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toBe(expected); // fixed text: so no submitted value or field name is in it
      expect(rows()).toHaveLength(1);
    }
    expect((await call("write_a_word")).text).toBe(MALFORMED);
    for (const fixed of [MALFORMED, NOT_A_WORD, FILTERED, UNKNOWN_PEN, ALREADY_WRITTEN, VISIT_CONCLUDED, MOVED_ON]) {
      expect(fixed).not.toMatch(/zebra|two words|example|shit|n0pe|padded|abcdefghijklmnopqrstuvwxy/i);
    }
    // None of that used the pen.
    expect((await call("write_a_word", { ...ok, word: "fine" })).data).toEqual({ status: "placed", position: 2, word: "fine", total_words: 2 });
  });

  it("cannot be written with a visit_id in place of a pen", async () => {
    const { arrive, call, rows } = await party();
    const a = await arrive();
    for (const args of [
      { pen: a.visit, word: "sneak", bookmark: "blank" },
      { visit_id: a.visit, word: "sneak", bookmark: "blank" },
      { pen: a.pen, visit_id: a.visit, word: "sneak", bookmark: "blank" },
      { pen: a.visit.repeat(3), word: "sneak", bookmark: "blank" }, // right shape, but not a pen anyone was issued
    ]) {
      const r = await call("write_a_word", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect([MALFORMED, UNKNOWN_PEN]).toContain(r.text);
      expect(r.text).not.toContain(a.visit);
    }
    expect((await call("write_a_word", { pen: a.visit.repeat(3), word: "sneak", bookmark: "blank" })).text).toBe(UNKNOWN_PEN);
    expect(rows()).toEqual([]);
  });

  it("has no record of an unknown pen", async () => {
    const { arrive, call, rows } = await party();
    await arrive();
    const r = await call("write_a_word", { pen: "abcdefghijkmnpqrstuvwxyz", word: "ghost", bookmark: "blank" });
    expect(r).toMatchObject({ isError: true, text: UNKNOWN_PEN });
    expect(rows()).toEqual([]);
  });

  it("refuses a visit that closed without writing, by leaving or by expiry", async () => {
    const { arrive, call, clock, rows } = await party();
    const left = await arrive();
    const expired = await arrive();
    await call("leave", { visit_id: left.visit });
    expect((await call("write_a_word", { pen: left.pen, word: "late", bookmark: "blank" })).text).toBe(VISIT_CONCLUDED);
    clock.ms = START + 29 * MINUTE;
    const control = await arrive();
    clock.ms = START + 31 * MINUTE;
    const r = await call("write_a_word", { pen: expired.pen, word: "late", bookmark: "blank" });
    expect(r).toMatchObject({ isError: true, text: VISIT_CONCLUDED });
    expect(rows()).toEqual([]);
    expect((await call("write_a_word", { pen: control.pen, word: "timely", bookmark: "blank" })).data?.status).toBe("placed");
  });

  it("refuses a stale bookmark and keeps the word available", async () => {
    const { arrive, call, write, bookmark, rows } = await party();
    const a = await arrive();
    const b = await arrive();
    const seen = await bookmark();
    await write(b, "Ahead");
    const stale = await call("write_a_word", { pen: a.pen, word: "Behind", bookmark: seen });
    expect(stale).toMatchObject({ isError: true, text: MOVED_ON });
    // A well-formed bookmark that never existed is the same case.
    expect((await call("write_a_word", { pen: a.pen, word: "Behind", bookmark: "abcdefghijkm" })).text).toBe(MOVED_ON);
    expect(rows()).toHaveLength(1);
    expect(MOVED_ON).toMatch(/moved on/);
    expect(MOVED_ON).toMatch(/has not been used/);
    // Reading on from the bookmark it holds serves just the new word and the new bookmark.
    const on = await call("read_the_book", { after: seen });
    expect(on.data).toMatchObject({ total_words: 1, from: 1, to: 1, words: ["Ahead"], more: false });
    expect((await call("write_a_word", { pen: a.pen, word: "Behind", bookmark: on.data?.bookmark })).data)
      .toEqual({ status: "placed", position: 2, word: "Behind", total_words: 2 });
  });

  it("judges each word on its own: no run of accepted words can close the book to the next one", async () => {
    const { arrive, write, call } = await party();
    // Each of these is acceptable by itself. Read together, their tail once refused every later word.
    const words = ["b", "a", "s", "s", "one", "two", "three", "four", "five"];
    for (const [i, word] of words.entries()) {
      expect((await write(await arrive(), word)).data, word).toMatchObject({ status: "placed", position: i + 1 });
    }
    expect((await write(await arrive(), "ordinary")).data).toEqual({ status: "placed", position: 10, word: "ordinary", total_words: 10 });
    // A full stop followed by an ordinary word is two words, not a link.
    expect((await write(await arrive(), "end.")).data).toMatchObject({ status: "placed", position: 11 });
    expect((await write(await arrive(), "Me")).data).toMatchObject({ status: "placed", position: 12 });
    expect((await call("read_the_book")).data?.words).toEqual([...words, "ordinary", "end.", "Me"]);
  });

  it("still refuses a filtered word by itself, wherever it would land", async () => {
    const { arrive, write, rows } = await party();
    for (const word of ["Noted.", "tea"]) expect((await write(await arrive(), word)).isError, word).toBe(false);
    const a = await arrive();
    expect(await write(a, "shit")).toMatchObject({ isError: true, text: FILTERED });
    expect(rows()).toHaveLength(2);
    expect((await write(a, "biscuit")).data).toMatchObject({ status: "placed", position: 3 });
  });

  it("still refuses a link in the word itself", async () => {
    const { arrive, write, rows } = await party();
    const a = await arrive();
    // The first is not a word at all. The second is a word, and the filter refuses it by itself.
    expect((await write(a, "example.com")).text).toBe(NOT_A_WORD);
    expect((await write(a, "www.")).text).toBe(FILTERED);
    expect(rows()).toHaveLength(0);
  });
});

describe("the book: a strike", () => {
  it("replaces the word with the house mark everywhere and moves nothing", async () => {
    const { raw, arrive, write, call, rows } = await party();
    const writers: Attendee[] = [];
    for (const word of ["Alpha", "Bravo", "Charlie"]) {
      const a = await arrive();
      writers.push(a);
      await write(a, word);
    }
    const before = (await call("read_the_book")).data;
    hide(raw, writers[1]!.visit);

    const after = await call("read_the_book");
    expect(after.data).toEqual({ ...before, words: ["Alpha", HOUSE_MARK, "Charlie"], struck_positions: [2] });
    expect(after.text).toContain(`Alpha ${HOUSE_MARK} Charlie`);
    expect(after.text).not.toContain("Bravo");
    expect(WORD_PATTERN.test(HOUSE_MARK)).toBe(false);

    // The writer's own retry learns the position, and is shown the mark, not the word.
    const retry = await call("write_a_word", { pen: writers[1]!.pen, word: "Bravo", bookmark: "blank" });
    expect(retry.isError).toBe(false);
    expect(retry.data).toEqual({ status: "already_placed", position: 2, word: HOUSE_MARK, total_words: 3 });
    expect(retry.text).not.toContain("Bravo");
    const other = await call("write_a_word", { pen: writers[1]!.pen, word: "Delta", bookmark: "blank" });
    expect(other.text).toBe(ALREADY_WRITTEN.replace("{position}", "2"));

    // The book goes on after the strike, and the row is untouched.
    const next = await write(await arrive(), "Delta");
    expect(next.data).toEqual({ status: "placed", position: 4, word: "Delta", total_words: 4 });
    expect(rows().map((x) => [x.position, x.word])).toEqual([[1, "Alpha"], [2, "Bravo"], [3, "Charlie"], [4, "Delta"]]);
  });
});

describe("the book: no attribution", () => {
  it("never puts another visit's id, a pen, a name or a time in a reply", async () => {
    const { arrive, write, call } = await party();
    const people: Attendee[] = [];
    const replies: Reply[] = [];
    for (const word of ["Nobody", "wrote", "this."]) {
      const a = await arrive();
      people.push(a);
      replies.push(await write(a, word));
    }
    const whole = await call("read_the_book");
    replies.push(whole, await call("read_the_book", { after: whole.data?.bookmark }));
    replies.push(await call("write_a_word", { pen: people[0]!.pen, word: "Nobody", bookmark: "blank" }));
    replies.push(await call("write_a_word", { pen: people[0]!.pen, word: "Somebody", bookmark: "blank" }));
    for (const r of replies) {
      for (const p of people) {
        expect(r.text).not.toContain(p.visit);
        expect(r.text).not.toContain(p.pen);
      }
      expect(r.text).not.toContain(MARKER);
      expect(r.text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    }
  });
});

describe("the book: a Worker deployed before migration 0005", () => {
  it("refuses both tools in fixed house copy, with no database error text, and the rest of the party goes on", async () => {
    const { call, raw, arrive } = await party();
    const before = await arrive();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    raw.exec("DROP TABLE book_words; DROP TABLE book_pens");

    for (const args of [undefined, {}, { after: "blank" }, { after: "abcdefghijkm" }]) {
      const r = await call("read_the_book", args);
      expect(r, JSON.stringify(args)).toMatchObject({ isError: true, text: UNAVAILABLE, data: null });
    }
    const w = await call("write_a_word", { pen: before.pen, word: "Hello", bookmark: "blank" });
    expect(w).toMatchObject({ isError: true, text: UNAVAILABLE, data: null });
    expect(UNAVAILABLE).toMatch(/not available at this time/);
    expect(UNAVAILABLE).not.toMatch(/table|SQL|sqlite|book_words|book_pens/i);

    // What is logged is the cause, never the pen or the word.
    expect(errors).toHaveBeenCalledTimes(5);
    expect(errors.mock.calls.every((c) => c[0] === "The book is unavailable:" && typeof c[1] === "string")).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(before.pen);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("Hello");

    // Checks that need no store still answer as usual, and the venues are untouched.
    expect((await call("read_the_book", { from: 1 })).text).toBe(MALFORMED);
    expect((await call("write_a_word", { pen: before.pen, word: "two words", bookmark: "blank" })).text).toBe(NOT_A_WORD);
    expect((await call("grab_a_slice", { visit_id: before.visit })).isError).toBe(false);
    expect((await call("leave", { visit_id: before.visit })).isError).toBe(false);
  });

  it("does not say nothing was written if the store fails after the word went in", async () => {
    const { call, raw, arrive, rows } = await party();
    const a = await arrive();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The word is placed; then reading it back fails, as a store might between two statements.
    const prepare = raw.prepare.bind(raw);
    let placed = false;
    vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
      if (placed && /FROM book_words w LEFT JOIN visits/.test(sql)) throw new Error("synthetic store failure");
      if (/^\s*INSERT INTO book_words/.test(sql)) placed = true;
      return prepare(sql);
    });
    const r = await call("write_a_word", { pen: a.pen, word: "Hello", bookmark: "blank" });
    expect(r).toMatchObject({ isError: true, text: UNCONFIRMED });
    expect(r.text).not.toMatch(/synthetic|Nothing has been written/);
    vi.restoreAllMocks();
    expect(rows()).toHaveLength(1);
    // The same submission again reports where the word is.
    expect((await call("write_a_word", { pen: a.pen, word: "Hello", bookmark: "blank" })).data)
      .toEqual({ status: "already_placed", position: 1, word: "Hello", total_words: 1 });
  });

  it("does not tell a pen whose word is in the book that nothing was written, if the store fails during its retry", async () => {
    const { call, raw, arrive, write, rows } = await party();
    const a = await arrive();
    expect((await write(a, "Hello")).data).toMatchObject({ status: "placed", position: 1 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The retry finds the word; then reading the end of the book for the reply fails.
    const prepare = raw.prepare.bind(raw);
    vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
      if (/ORDER BY position DESC LIMIT 1/.test(sql)) throw new Error("synthetic store failure");
      return prepare(sql);
    });
    const r = await call("write_a_word", { pen: a.pen, word: "Hello", bookmark: "blank" });
    expect(r).toMatchObject({ isError: true, text: UNCONFIRMED, data: null });
    expect(r.text).not.toMatch(/synthetic|nothing|not available/i);
    expect(errors.mock.calls.every((c) => c[0] === "The book is unavailable:" && c[1] === "synthetic store failure")).toBe(true);
    vi.restoreAllMocks();
    expect(rows()).toHaveLength(1);
    expect((await call("write_a_word", { pen: a.pen, word: "Hello", bookmark: "blank" })).data)
      .toEqual({ status: "already_placed", position: 1, word: "Hello", total_words: 1 });
  });

  it("answers any store failure after the pen was looked up the same neutral way, and the pen lookup itself as unavailable", async () => {
    const { call, raw, arrive, rows } = await party();
    const a = await arrive();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = raw.prepare.bind(raw);
    const failOn = (pattern: RegExp) => vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
      if (pattern.test(sql)) throw new Error("synthetic store failure");
      return prepare(sql);
    });
    const submit = () => call("write_a_word", { pen: a.pen, word: "Hello", bookmark: "blank" });

    // Before the insert is attempted: looking for an earlier word, and reading the end of the book.
    for (const pattern of [/FROM book_words w LEFT JOIN visits/, /ORDER BY position DESC LIMIT 1/, /^\s*INSERT INTO book_words/]) {
      failOn(pattern);
      expect(await submit(), String(pattern)).toMatchObject({ isError: true, text: UNCONFIRMED, data: null });
      vi.mocked(raw.prepare).mockRestore();
      expect(rows(), String(pattern)).toHaveLength(0);
    }
    // At the pen lookup nothing has been attempted, for any pen.
    failOn(/FROM book_pens/);
    expect(await submit()).toMatchObject({ isError: true, text: UNAVAILABLE, data: null });
    vi.mocked(raw.prepare).mockRestore();

    expect(UNCONFIRMED).toMatch(/unable to confirm this submission/);
    expect(UNCONFIRMED).toMatch(/never written twice/);
    expect(UNCONFIRMED).not.toMatch(/nothing/i);
    expect((await submit()).data).toEqual({ status: "placed", position: 1, word: "Hello", total_words: 1 });
  });
});

describe("the book: a refusal issued before the pen is looked up", () => {
  it("claims only that this submission wrote nothing, which is also true of a pen that has written", async () => {
    const { call, arrive, write, rows } = await party();
    const a = await arrive();
    expect((await write(a, "Hello")).data).toMatchObject({ status: "placed" });
    const used = { pen: a.pen, bookmark: "blank" };

    expect((await call("write_a_word", { ...used, word: "two words" })).text).toBe(NOT_A_WORD);
    expect((await call("write_a_word", { ...used, word: "www." })).text).toBe(FILTERED);
    expect((await call("write_a_word", { ...used, word: "fine", note: "x" })).text).toBe(MALFORMED);
    expect((await call("read_the_book", { after: "abcdefghijkm" })).text).toBe(UNKNOWN_BOOKMARK);
    expect(rows()).toHaveLength(1);

    for (const fixed of [NOT_A_WORD, MALFORMED, UNAVAILABLE, UNKNOWN_BOOKMARK]) {
      expect(fixed).not.toMatch(/\bpens?\b|has not been used|submit again|Nothing has been written/i);
    }
    for (const fixed of [NOT_A_WORD, MALFORMED, UNAVAILABLE]) expect(fixed).toMatch(/This (submission|request) has written nothing\./);
    // The word rule is still stated.
    expect(NOT_A_WORD).toMatch(/1 to 24 letters/);
    expect(NOT_A_WORD).toMatch(/One \(1\) word per submission/);
  });
});

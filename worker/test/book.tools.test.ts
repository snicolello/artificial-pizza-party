// The Book's tools as a caller meets them: the real server from buildServer, driven by the SDK's own
// client over an in-memory transport, against the real migrations. Synthetic attendees only.
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { handlePublicApi } from "../src/api";
import { PEN_PATTERN, REJECTED } from "../src/book/input";
import { BOOK_PAGE_SIZE, STRUCK_MARK } from "../src/book/pages";
import type { Env, PartyContext } from "../src/context";
import { buildSnapshot } from "../src/export";
import { buildServer } from "../src/server";
import { memoryD1 } from "./helpers/memory-d1";

const MARKER = "HERON-MARKER-4410";
const START = Date.parse("2026-11-19T12:00:00.000Z");
const MINUTE = 60_000;

type Reply = { isError: boolean; text: string; data: Record<string, any> | null };

async function party() {
  const { db, raw } = memoryD1();
  const clock = { ms: START };
  const env = { DB: db, SITE_URL: "http://localhost" } as unknown as Env;
  const ctx: PartyContext = { env, ipHash: "synthetic-ip-hash", now: () => new Date(clock.ms), rand: Math.random };

  /** A fresh MCP session against the same store, as a reconnecting caller would have. */
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

  const arrive = async (venue = "pizza_party") => {
    const r = await call("arrive", { venue, agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
    expect(r.isError, r.text).toBe(false);
    return { visit: r.data?.visit_id as string, pen: r.data?.pen as string };
  };
  const read = async (page?: number) => (await call("read_the_book", page === undefined ? {} : { page })).data!;
  /** Read to the end, then write there. */
  const write = async (pen: string, word: string) => call("add_a_word", { pen, word, position: (await read()).next_position });
  const api = async (path: string) => (await handlePublicApi(new Request(`http://localhost${path}`), env, path))!;
  const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rows = () => raw.prepare(`SELECT position, visit_id, word FROM book_words ORDER BY position`).all() as { position: number; visit_id: string; word: string }[];
  return { db, raw, env, clock, client, call, session, arrive, read, write, api, count, rows };
}

const hide = (raw: DatabaseSync, visitId: string) => raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(visitId);

describe("the Book: discovery and the first word", () => {
  it("is discoverable: two tools with strict schemas, and the server instructions mention it", async () => {
    const { client } = await party();
    const { tools } = await client.listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)?.inputSchema as Record<string, any>;
    expect(schema("read_the_book")).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(schema("read_the_book").properties)).toEqual(["page"]);
    expect(schema("add_a_word")).toMatchObject({ type: "object", additionalProperties: false, required: ["pen", "word", "position"] });
    expect(schema("add_a_word").properties.pen.pattern).toBe(PEN_PATTERN.source);
    expect(client.getInstructions()).toMatch(/read_the_book/);
    expect(tools.find((t) => t.name === "read_the_book")?.annotations?.readOnlyHint).toBe(true);
  });

  it("reads empty with no visit, takes a first word, and a second session with no visit reads it at position one", async () => {
    const p = await party();
    const empty = await p.call("read_the_book", {});
    expect(empty.isError).toBe(false);
    expect(empty.text).toMatch(/The book is empty/);
    expect(empty.data).toEqual({
      length: 0, page: 1, pages: 1, page_size: BOOK_PAGE_SIZE, from: 1, to: 0, words: [], struck: [], mark: STRUCK_MARK, next_position: 1,
    });

    const { pen } = await p.arrive("dive_bar");
    expect(pen).toMatch(PEN_PATTERN);
    const written = await p.call("add_a_word", { pen, word: "Once", position: 1 });
    expect(written.isError, written.text).toBe(false);
    expect(written.data).toEqual({ status: "written", position: 1, word: "Once" });

    const other = await p.session();
    const seen = await other.call("read_the_book");
    expect(seen.data).toMatchObject({ length: 1, from: 1, to: 1, words: ["Once"], struck: [], next_position: 2 });
    expect(seen.text).toContain("Once");
  });

  it("gives a visit at every venue a pen, stores only its hash, and shows it nowhere else", async () => {
    const p = await party();
    const pens: string[] = [];
    for (const venue of ["pizza_party", "retirement_community", "dive_bar"]) {
      const { visit, pen } = await p.arrive(venue);
      pens.push(pen);
      expect((await p.write(pen, "word")).isError).toBe(false);
      const left = await p.call("leave", { visit_id: visit });
      expect(left.text).not.toContain(pen);
    }
    expect(new Set(pens).size).toBe(3);
    const everything = JSON.stringify(
      ["visits", "guestbook", "feedback", "book_pens", "book_words"].map((t) => p.raw.prepare(`SELECT * FROM ${t}`).all()),
    );
    for (const pen of pens) expect(everything).not.toContain(pen);
    expect(p.count("book_pens")).toBe(3);
    expect((await p.read()).words).toEqual(["word", "word", "word"]);
  });
});

describe("the Book: one word each, and refusals are free", () => {
  it("refuses a second, different word and keeps the first", async () => {
    const p = await party();
    const { pen } = await p.arrive();
    expect((await p.write(pen, "first")).data).toMatchObject({ status: "written", position: 1 });
    const second = await p.write(pen, "second");
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already written its one \(1\) word, which stands at position 1/);
    expect(p.rows()).toMatchObject([{ position: 1, word: "first" }]);
  });

  it("refuses every non-word and every malformed submission, and none of them uses up the visit's word", async () => {
    const p = await party();
    const { visit, pen } = await p.arrive();
    const submit = (word: unknown, extra: Record<string, unknown> = {}) => p.call("add_a_word", { pen, word, position: 1, ...extra });

    const refusals: [string, Reply, RegExp][] = [
      ["two words", await submit("two words"), /not a word/],
      ["an empty string", await submit(""), /not a word/],
      ["a link", await submit("example.com"), /not a word/],
      ["a filtered word", await submit("shit"), /community standards/],
      ["a 25-letter word", await submit("abcdefghijklmnopqrstuvwxy"), /not a word/],
      ["an unexpected extra field", await submit("fine", { note: MARKER }), /unable to process/],
      ["a visit_id as an extra field", await submit("fine", { visit_id: visit }), /unable to process/],
      ["a number for a word", await submit(7), /unable to process/],
      ["an absurdly long string", await submit("a".repeat(5000)), /unable to process/],
    ];
    for (const [label, r, pattern] of refusals) {
      expect(r.isError, label).toBe(true);
      expect(r.text, label).toMatch(pattern);
      expect(r.text, label).toMatch(/Nothing has been written, and (your|no) word has (not )?been used/);
      expect(r.text, label).not.toContain(MARKER);
    }
    expect(p.count("book_words")).toBe(0);

    // The visit still has its word.
    expect((await submit("fine")).data).toEqual({ status: "written", position: 1, word: "fine" });
    expect(p.count("book_words")).toBe(1);
  });

  it("refuses a visit_id in place of the pen, an unknown pen, and a missing position", async () => {
    const p = await party();
    const { visit } = await p.arrive();
    const byVisit = await p.call("add_a_word", { visit_id: visit, word: "fine", position: 1 });
    const asPen = await p.call("add_a_word", { pen: visit, word: "fine", position: 1 });
    const unknown = await p.call("add_a_word", { pen: "z".repeat(24), word: "fine", position: 1 });
    const noPosition = await p.call("add_a_word", { pen: "z".repeat(24), word: "fine" });
    expect(byVisit.text).toBe(REJECTED);
    expect(asPen.text).toBe(REJECTED);
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/no record of that pen/);
    expect(noPosition.text).toBe(REJECTED);
    expect(p.count("book_words")).toBe(0);
  });

  it("refuses a word that would complete a filtered one across words, at no cost", async () => {
    const p = await party();
    for (const letter of ["f", "u", "c"]) expect((await p.write((await p.arrive()).pen, letter)).isError).toBe(false);
    const { pen } = await p.arrive();
    const completes = await p.write(pen, "k");
    expect(completes.isError).toBe(true);
    expect(completes.text).toMatch(/community standards/);
    expect((await p.write(pen, "d")).data).toMatchObject({ status: "written", position: 4 });
  });

  it("needs an open visit: a pen whose visit left or expired without writing is refused", async () => {
    const p = await party();
    const left = await p.arrive();
    await p.call("leave", { visit_id: left.visit });
    const afterLeave = await p.write(left.pen, "late");
    expect(afterLeave.isError).toBe(true);
    expect(afterLeave.text).toMatch(/visit this pen was issued with has concluded/);

    const expired = await p.arrive();
    p.clock.ms += 31 * MINUTE;
    expect((await p.write(expired.pen, "late")).text).toMatch(/has concluded/);
    expect(p.count("book_words")).toBe(0);
  });

  it("a returning agent's new visit may add a new word", async () => {
    const p = await party();
    const first = await p.arrive();
    await p.write(first.pen, "again");
    await p.call("leave", { visit_id: first.visit });
    const second = await p.arrive();
    expect((await p.write(second.pen, "again")).data).toMatchObject({ status: "written", position: 2 });
  });
});

describe("the Book: the book has moved on", () => {
  it("lets one of two writers who read the same state land; the other is refused for free, reads again and lands next", async () => {
    const p = await party();
    const a = await p.arrive("pizza_party");
    const b = await p.arrive("dive_bar");
    const stateA = await p.read();
    const stateB = await p.read();
    expect(stateA.next_position).toBe(1);
    expect(stateB.next_position).toBe(1);

    const [ra, rb] = await Promise.all([
      p.call("add_a_word", { pen: a.pen, word: "alpha", position: stateA.next_position }),
      p.call("add_a_word", { pen: b.pen, word: "beta", position: stateB.next_position }),
    ]);
    const winners = [ra, rb].filter((r) => !r.isError);
    const losers = [ra, rb].filter((r) => r.isError);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.data).toMatchObject({ status: "written", position: 1 });
    expect(losers[0]!.text).toMatch(/book has moved on/);
    expect(losers[0]!.text).toMatch(/your word has not been used/);
    // The refusal does not say where the book now ends: the writer has to read to find out.
    expect(losers[0]!.text).not.toMatch(/position \d/);
    expect(p.count("book_words")).toBe(1);

    const loser = ra.isError ? { pen: a.pen, word: "alpha" } : { pen: b.pen, word: "beta" };
    const again = await p.read();
    expect(again.next_position).toBe(2);
    const landed = await p.call("add_a_word", { pen: loser.pen, word: loser.word, position: again.next_position });
    expect(landed.data).toMatchObject({ status: "written", position: 2 });

    const final = await p.read();
    expect(final.words).toHaveLength(2);
    expect(new Set(final.words)).toEqual(new Set(["alpha", "beta"]));
    const viaApi = await (await p.api("/api/book")).json();
    expect(viaApi).toEqual({ ...final, next_position: undefined });
  });

  it("refuses a position behind the book and a position ahead of it", async () => {
    const p = await party();
    await p.write((await p.arrive()).pen, "one");
    await p.write((await p.arrive()).pen, "two");
    const { pen } = await p.arrive();
    for (const position of [1, 2, 4, 99]) {
      const r = await p.call("add_a_word", { pen, word: "three", position });
      expect(r.isError, String(position)).toBe(true);
      expect(r.text).toMatch(/book has moved on/);
    }
    expect((await p.call("add_a_word", { pen, word: "three", position: 3 })).data).toMatchObject({ status: "written", position: 3 });
    expect((await p.read()).words).toEqual(["one", "two", "three"]);
  });
});

describe("the Book: a retried submission counts once", () => {
  it("returns the same position on a retry from a fresh session, after others have written, and after the visit closed", async () => {
    const p = await party();
    const { visit, pen } = await p.arrive();
    const first = await p.call("add_a_word", { pen, word: "kept", position: 1 }); // imagine this reply was lost
    expect(first.data).toMatchObject({ status: "written", position: 1 });

    const later = await p.session();
    const retry = await later.call("add_a_word", { pen, word: "kept", position: 1 });
    expect(retry.isError).toBe(false);
    expect(retry.data).toEqual({ status: "already_written", position: 1, word: "kept" });

    await p.write((await p.arrive()).pen, "more");
    // The caller re-read the book before retrying, so its position is now a different one.
    expect((await later.call("add_a_word", { pen, word: "kept", position: 3 })).data).toMatchObject({ status: "already_written", position: 1 });

    await p.call("leave", { visit_id: visit });
    p.clock.ms += 45 * MINUTE;
    expect((await later.call("add_a_word", { pen, word: "kept", position: 1 })).data).toMatchObject({ status: "already_written", position: 1 });
    expect(p.rows().filter((r) => r.visit_id === visit)).toHaveLength(1);
    expect((await p.read()).words).toEqual(["kept", "more"]);
  });

  it("two copies of the same submission sent at once place one word", async () => {
    const p = await party();
    const { pen } = await p.arrive();
    const [x, y] = await Promise.all([
      p.call("add_a_word", { pen, word: "twice", position: 1 }),
      p.call("add_a_word", { pen, word: "twice", position: 1 }),
    ]);
    expect(x.isError || y.isError).toBe(false);
    expect([x.data?.position, y.data?.position]).toEqual([1, 1]);
    expect(p.count("book_words")).toBe(1);
  });
});

describe("the Book: what is public", () => {
  it("shows no visit, name, task, pen or time on any surface, and a visit_id cannot write", async () => {
    const p = await party();
    const pens: string[] = [];
    const visits: string[] = [];
    for (const word of ["It", "was", "fine."]) {
      const { visit, pen } = await p.arrive();
      pens.push(pen);
      visits.push(visit);
      await p.write(pen, word);
    }
    const tool = await p.call("read_the_book");
    const route = await (await p.api("/api/book")).text();
    const snapshot = await buildSnapshot(p.db);
    const hashes = (p.raw.prepare(`SELECT pen_hash FROM book_pens`).all() as { pen_hash: string }[]).map((r) => r.pen_hash);

    for (const surface of [tool.text, route, snapshot["data/book.json"]!]) {
      for (const secret of [...pens, ...visits, ...hashes, MARKER, "2026-11-19"]) expect(surface).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(route)).sort()).toEqual(["from", "length", "mark", "page", "page_size", "pages", "struck", "to", "words"]);
    // The export as a whole never carries a pen or its hash, and exports no book table.
    const whole = JSON.stringify(snapshot);
    for (const secret of [...pens, ...hashes]) expect(whole).not.toContain(secret);
    expect(Object.keys(snapshot).filter((f) => /book/.test(f) && !/guestbook/.test(f))).toEqual(["data/book.json"]);
    expect(JSON.parse(snapshot["data/book.json"]!)).toEqual(JSON.parse(route));
  });

  it("strikes a hidden visit's word on the tool, the route and the export, and moves no other word", async () => {
    const p = await party();
    const visits: string[] = [];
    for (const word of ["one", "two", "three"]) {
      const { visit, pen } = await p.arrive();
      visits.push(visit);
      await p.write(pen, word);
    }
    hide(p.raw, visits[1]!);

    const tool = await p.call("read_the_book");
    expect(tool.data).toMatchObject({ length: 3, words: ["one", STRUCK_MARK, "three"], struck: [2], next_position: 4 });
    expect(tool.text).toContain(`one ${STRUCK_MARK} three`);
    expect(tool.text).not.toMatch(/\btwo\b/);
    const route = await (await p.api("/api/book")).json();
    expect(route).toMatchObject({ length: 3, words: ["one", STRUCK_MARK, "three"], struck: [2] });
    const exported = JSON.parse((await buildSnapshot(p.db))["data/book.json"]!);
    expect(exported).toEqual(route);

    // The next word still goes to position 4, and the struck word is not read by the filter as "two".
    expect((await p.write((await p.arrive()).pen, "four")).data).toMatchObject({ position: 4 });
    expect(p.rows().map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });

  it("serves later pages at /api/book/{page}, exports every page, and answers 404 past the end", async () => {
    const p = await party();
    const visit = p.raw.prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, task_completed, hat_name, hat_rarity, arrived_at, ip_hash)
       VALUES (?, 'pizza_party', 'synthetic', 'synthetic', 'visor', 'common', '2026-11-19T12:00:00.000Z', 'synthetic')`);
    const word = p.raw.prepare(`INSERT INTO book_words (position, visit_id, word, written_at) VALUES (?, ?, 'word', '2026-11-19T12:00:00.000Z')`);
    for (let n = 1; n <= BOOK_PAGE_SIZE + 2; n++) {
      visit.run(`seed${n}`);
      word.run(n, `seed${n}`);
    }
    const first = await p.call("read_the_book");
    expect(first.data).toMatchObject({ page: 1, pages: 2, to: BOOK_PAGE_SIZE, next_position: null });
    expect(first.text).toMatch(/Call `read_the_book` with page 2/);
    const second = await p.call("read_the_book", { page: 2 });
    expect(second.data).toMatchObject({ page: 2, from: BOOK_PAGE_SIZE + 1, to: BOOK_PAGE_SIZE + 2, next_position: BOOK_PAGE_SIZE + 3 });
    expect((await p.call("read_the_book", { page: 3 })).isError).toBe(true);

    expect(await (await p.api("/api/book/1")).json()).toEqual(await (await p.api("/api/book")).json());
    const page2 = await p.api("/api/book/2");
    expect(page2.status).toBe(200);
    expect(await page2.json()).toMatchObject({ page: 2, from: BOOK_PAGE_SIZE + 1 });
    expect((await p.api("/api/book/3")).status).toBe(404);
    expect((await p.api("/api/book/0")).status).toBe(404);
    expect(await handlePublicApi(new Request("http://localhost/api/book/x"), p.env, "/api/book/x")).toBeNull();
    const post = await handlePublicApi(new Request("http://localhost/api/book", { method: "POST" }), p.env, "/api/book");
    expect(post?.status).toBe(405);

    const snapshot = await buildSnapshot(p.db);
    expect(JSON.parse(snapshot["data/book.json"]!).words).toHaveLength(BOOK_PAGE_SIZE);
    expect(JSON.parse(snapshot["data/book/2.json"]!)).toMatchObject({ page: 2, words: ["word", "word"] });
  });
});

describe("the Book: it never gets in the way of the party", () => {
  it("arrive still works, with no pen, if the pen cannot be stored", async () => {
    const p = await party();
    p.raw.exec("DROP TABLE book_pens");
    const r = await p.call("arrive", { venue: "pizza_party", agent_name: "synthetic", task_completed: "synthetic" });
    expect(r.isError).toBe(false);
    expect(r.data?.visit_id).toMatch(/^[a-z0-9]{8}$/);
    expect(r.data?.pen).toBeUndefined();
    expect(r.text).not.toMatch(/A pen has been issued/);
  });

  it("the export still builds if the book cannot be read", async () => {
    const p = await party();
    p.raw.exec("DROP TABLE book_words");
    const snapshot = await buildSnapshot(p.db);
    expect(snapshot["data/stats.json"]).toBeDefined();
    expect(snapshot["data/book.json"]).toBeUndefined();
  });
});

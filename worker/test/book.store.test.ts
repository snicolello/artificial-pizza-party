// The book's store against the real migrations. Synthetic visits only.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HOUSE_MARK, PAGE_SIZE } from "../src/book/rules";
import { bookForExport, bookHead, bookIndex, bookPage, issuePen, placeWord, readBookAfter, visitIdForPen, wordByVisit } from "../src/book/store";
import { memoryD1 } from "./helpers/memory-d1";

const NOW = new Date("2026-11-18T12:00:00.000Z");

function addVisit(raw: DatabaseSync, id: string, opts: { arrived?: string; left?: string | null; hidden?: number } = {}) {
  raw
    .prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity, arrived_at, left_at,
                           perk_count, perk_total, handicap, ip_hash, hidden)
       VALUES (?, 'dive_bar', 'synthetic agent', NULL, 'synthetic task', 'Party Hat', 'common', ?, ?, 0, 0, NULL, 'synthetic', ?)`,
    )
    .run(id, opts.arrived ?? NOW.toISOString(), opts.left ?? null, opts.hidden ?? 0);
}

/** Fill the book directly: positions 1..n, word "w<position>" spelled in letters, one synthetic visit each. */
function fill(raw: DatabaseSync, n: number) {
  raw.exec("BEGIN");
  const word = raw.prepare(`INSERT INTO book_words (position, visit_id, word, bookmark, placed_at) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= n; i++) {
    addVisit(raw, `v${i}`);
    word.run(i, `v${i}`, wordAt(i), `mark${i}`, NOW.toISOString());
  }
  raw.exec("COMMIT");
}
const wordAt = (i: number) => "w" + String(i).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);
const count = (raw: DatabaseSync) => (raw.prepare("SELECT COUNT(*) AS n FROM book_words").get() as { n: number }).n;

describe("the empty book", () => {
  it("reads as blank, with no pages", async () => {
    const { db } = memoryD1();
    const blank = { total_words: 0, from: 1, to: 0, words: [], struck_positions: [], more: false, bookmark: "blank" };
    expect(await readBookAfter(db)).toEqual(blank);
    expect(await readBookAfter(db, "blank")).toEqual(blank);
    expect(await readBookAfter(db, "mark40")).toBeNull();
    expect(await bookForExport(db)).toEqual({ index: await bookIndex(db), pages: [] });
    expect(await bookIndex(db)).toEqual({ total_words: 0, page_size: 500, pages: 0, house_mark: "[struck]" });
    expect(await bookPage(db, 1)).toBeNull();
    expect(await bookHead(db)).toEqual({ total_words: 0, bookmark: "blank" });
  });
});

describe("pens", () => {
  it("are issued once per visit and found by hash", async () => {
    const { db, raw } = memoryD1();
    addVisit(raw, "visit1");
    expect(await issuePen(db, "visit1", "hash-one", NOW)).toBe(true);
    expect(await issuePen(db, "visit1", "hash-two", NOW)).toBe(false);
    expect(await visitIdForPen(db, "hash-one")).toBe("visit1");
    expect(await visitIdForPen(db, "hash-two")).toBeNull();
  });
});

describe("placeWord", () => {
  it("places at the next position only for an open visit holding the current bookmark, once", async () => {
    const { db, raw } = memoryD1();
    addVisit(raw, "open1");
    addVisit(raw, "open2");
    addVisit(raw, "left1", { left: NOW.toISOString() });
    addVisit(raw, "old1", { arrived: "2026-11-18T11:29:59.000Z" });

    expect(await placeWord(db, { visit_id: "left1", word: "no", expected_bookmark: "blank", new_bookmark: "m0" }, NOW)).toBe(false);
    expect(await placeWord(db, { visit_id: "old1", word: "no", expected_bookmark: "blank", new_bookmark: "m0" }, NOW)).toBe(false);
    expect(await placeWord(db, { visit_id: "nobody", word: "no", expected_bookmark: "blank", new_bookmark: "m0" }, NOW)).toBe(false);
    expect(await placeWord(db, { visit_id: "open1", word: "no", expected_bookmark: "stale", new_bookmark: "m0" }, NOW)).toBe(false);
    expect(count(raw)).toBe(0);

    expect(await placeWord(db, { visit_id: "open1", word: "Hello,", expected_bookmark: "blank", new_bookmark: "m1" }, NOW)).toBe(true);
    expect(await wordByVisit(db, "open1")).toEqual({ position: 1, word: "Hello,", struck: false });
    // The same visit again, even with the current bookmark: nothing.
    expect(await placeWord(db, { visit_id: "open1", word: "again", expected_bookmark: "m1", new_bookmark: "m2" }, NOW)).toBe(false);
    // Another visit with the old bookmark: nothing.
    expect(await placeWord(db, { visit_id: "open2", word: "late", expected_bookmark: "blank", new_bookmark: "m2" }, NOW)).toBe(false);
    expect(await wordByVisit(db, "open2")).toBeNull();
    expect(await placeWord(db, { visit_id: "open2", word: "world.", expected_bookmark: "m1", new_bookmark: "m2" }, NOW)).toBe(true);
    expect(await wordByVisit(db, "open2")).toEqual({ position: 2, word: "world.", struck: false });
    expect(await readBookAfter(db)).toEqual({ total_words: 2, from: 1, to: 2, words: ["Hello,", "world."], struck_positions: [], more: false, bookmark: "m2" });
    expect(count(raw)).toBe(2);
  });
});

describe("a word, once placed, never moves", () => {
  it("aborts UPDATE and DELETE on book_words", () => {
    const { raw } = memoryD1();
    fill(raw, 3);
    expect(() => raw.exec("UPDATE book_words SET word = 'x' WHERE position = 2")).toThrow(/never moves/);
    expect(() => raw.exec("UPDATE book_words SET position = 9 WHERE position = 2")).toThrow(/never moves/);
    expect(() => raw.exec("DELETE FROM book_words WHERE position = 2")).toThrow(/never moves/);
    expect(() => raw.exec("DELETE FROM book_words")).toThrow(/never moves/);
    // INSERT OR REPLACE does not fire DELETE triggers; the insert trigger skips it instead.
    raw.exec("INSERT OR REPLACE INTO book_words (position, visit_id, word, bookmark, placed_at) VALUES (2, 'v2', 'x', 'markx', 'now')");
    raw.exec("INSERT OR REPLACE INTO book_words (position, visit_id, word, bookmark, placed_at) VALUES (9, 'v1', 'x', 'mark3', 'now')");
    expect(raw.prepare("SELECT position, word FROM book_words ORDER BY position").all()).toEqual([
      { position: 1, word: wordAt(1) }, { position: 2, word: wordAt(2) }, { position: 3, word: wordAt(3) },
    ]);
  });
});

describe("a strike", () => {
  it("keeps every position and shows the house mark on every reading", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 5);
    raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = 'v3'").run();
    const reading = (await readBookAfter(db))!;
    expect(reading.words).toEqual([wordAt(1), wordAt(2), HOUSE_MARK, wordAt(4), wordAt(5)]);
    expect(reading.struck_positions).toEqual([3]);
    expect(reading.total_words).toBe(5);
    expect(reading.bookmark).toBe("mark5"); // a strike changes no bookmark
    expect(await bookPage(db, 1)).toEqual({ page: 1, from: 1, to: 5, total_words: 5, words: reading.words, struck_positions: [3] });
    expect(await wordByVisit(db, "v3")).toEqual({ position: 3, word: wordAt(3), struck: true });
    expect(JSON.stringify([reading, await bookPage(db, 1), await readBookAfter(db, "mark2", 1)])).not.toContain(wordAt(3));
    // Striking the last word leaves the bookmark where it was.
    raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = 'v5'").run();
    expect(await readBookAfter(db, "mark3")).toMatchObject({ from: 4, words: [wordAt(4), HOUSE_MARK], struck_positions: [5], more: false, bookmark: "mark5" });
  });
});

describe("a long book", () => {
  const N = 1203;
  it("can be read whole from the first word, by bookmark, the current bookmark only at the end", async () => {
    const { db, raw } = memoryD1();
    fill(raw, N);
    const seen: string[] = [];
    const readings = [];
    for (let after: string | undefined; ; ) {
      const r = (await readBookAfter(db, after))!;
      readings.push(r);
      seen.push(...r.words);
      if (!r.more) break;
      after = r.bookmark;
    }
    expect(readings.map((r) => [r.from, r.to, r.more, r.bookmark])).toEqual([
      [1, 500, true, "mark500"], [501, 1000, true, "mark1000"], [1001, N, false, `mark${N}`],
    ]);
    expect(readings.every((r) => r.total_words === N && r.words.length === r.to - r.from + 1)).toBe(true);
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => wordAt(i + 1)));

    // From the last word but one, from the last word, with a limit, and from a bookmark no word carries.
    expect(await readBookAfter(db, `mark${N - 1}`)).toMatchObject({ from: N, to: N, words: [wordAt(N)], more: false, bookmark: `mark${N}` });
    expect(await readBookAfter(db, `mark${N}`)).toEqual({ total_words: N, from: N + 1, to: N, words: [], struck_positions: [], more: false, bookmark: `mark${N}` });
    expect(await readBookAfter(db, "mark9", 3)).toMatchObject({ from: 10, to: 12, words: [wordAt(10), wordAt(11), wordAt(12)], more: true, bookmark: "mark12" });
    expect((await readBookAfter(db, "blank", 5000))!.words).toHaveLength(PAGE_SIZE);
    expect(await readBookAfter(db, `mark${N - 8}`, 8)).toMatchObject({ from: N - 7, to: N, more: false, bookmark: `mark${N}` });
    for (const unknown of ["mark0", `mark${N + 1}`, "99999", "", "v1"]) expect(await readBookAfter(db, unknown), unknown).toBeNull();
  });

  it("is read for the export in a few large queries, equal to the pages the routes serve", async () => {
    const { db, raw } = memoryD1();
    fill(raw, N);
    for (const i of [7, 500, 501, N]) raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(`v${i}`);
    let queries = 0;
    const counted = { ...db, prepare: (sql: string) => (queries++, db.prepare(sql)) } as unknown as D1Database;

    const whole = await bookForExport(counted);
    expect(queries).toBe(2); // the head, and one chunk of up to 5,000 words
    const pages = [await bookPage(db, 1), await bookPage(db, 2), await bookPage(db, 3)];
    expect(whole).toEqual({ index: await bookIndex(db), pages });
    expect(whole.pages.map((p) => p.struck_positions)).toEqual([[7, 500], [501], [N]]);

    // The chunk size does not change the result, wherever the chunk edges fall.
    for (const chunk of [1203, 1000, 500, 499, 7]) {
      queries = 0;
      expect(await bookForExport(counted, chunk), String(chunk)).toEqual(whole);
      expect(queries, String(chunk)).toBe(1 + Math.ceil(N / chunk));
    }
  });

  it("is served in pages of 500 with no bookmark", async () => {
    const { db, raw } = memoryD1();
    fill(raw, N);
    expect(await bookIndex(db)).toEqual({ total_words: N, page_size: 500, pages: 3, house_mark: HOUSE_MARK });
    const pages = [await bookPage(db, 1), await bookPage(db, 2), await bookPage(db, 3)];
    expect(pages.map((p) => [p?.page, p?.from, p?.to, p?.total_words, p?.words.length])).toEqual([
      [1, 1, 500, N, 500], [2, 501, 1000, N, 500], [3, 1001, N, N, 203],
    ]);
    for (const p of pages) expect(Object.keys(p ?? {})).toEqual(["page", "from", "to", "total_words", "words", "struck_positions"]);
    expect(pages.flatMap((p) => p?.words ?? [])).toEqual(Array.from({ length: N }, (_, i) => wordAt(i + 1)));
    for (const bad of [0, -1, 4, 1.5, Number.NaN]) expect(await bookPage(db, bad), String(bad)).toBeNull();
  });

  it("has exactly full pages at a multiple of the page size", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 500);
    expect((await bookIndex(db)).pages).toBe(1);
    expect(await bookPage(db, 2)).toBeNull();
    expect(await readBookAfter(db)).toMatchObject({ to: 500, more: false, bookmark: "mark500" });
    expect(await bookForExport(db)).toEqual({ index: await bookIndex(db), pages: [await bookPage(db, 1)] });
  });
});

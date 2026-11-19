// The Book's rules on their own: what a word is, how the filter reads it, how a page is shaped,
// and the raw-body check. No server.
import { describe, expect, it } from "vitest";
import { BOOK_FIELDS, bookCallIsAcceptable, PEN_PATTERN, readInput, writeInput } from "../src/book/input";
import { allBookPages, BOOK_PAGE_SIZE, bookPage, pageCount, shapePage, STRUCK_MARK } from "../src/book/pages";
import { isWord, wordMeetsCommunityStandards } from "../src/book/word";
import { memoryD1 } from "./helpers/memory-d1";

describe("a word", () => {
  it.each(["a", "I", "Word", "don't", "mother-in-law", "rock-'n'-roll", "end.", "well,", "what?", "stop!", "thus:", "so;",
    "abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx."])("accepts %j", (word) => {
    expect(isWord(word)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["two words", "two words"],
    ["a 25-letter word", "abcdefghijklmnopqrstuvwxy"],
    ["25 characters counting a hyphen", "abcdefghijkl-mnopqrstuvwx"],
    ["a link", "example.com"],
    ["a scheme", "https://example.com"],
    ["a digit", "word2"],
    ["only punctuation", "."],
    ["two closing marks", "what?!"],
    ["a leading apostrophe", "'tis"],
    ["a trailing hyphen", "well-"],
    ["a trailing apostrophe before the mark", "dogs'."],
    ["leading space", " word"],
    ["trailing space", "word "],
    ["a trailing newline", "word\n"],
    ["an accented letter", "café"],
    ["a typographic apostrophe", "don’t"],
    ["an underscore", "snake_case"],
    ["a bracket", "[word]"],
    ["the house mark", STRUCK_MARK],
  ])("refuses %s", (_label, word) => {
    expect(isWord(word)).toBe(false);
  });
});

describe("the filter, applied to a word", () => {
  it("refuses a filtered word and accepts an ordinary one", () => {
    expect(wordMeetsCommunityStandards("shit")).toBe(false);
    expect(wordMeetsCommunityStandards("pineapple")).toBe(true);
  });

  it("refuses a word that completes a profanity spelled one letter per word", () => {
    expect(wordMeetsCommunityStandards("k")).toBe(true);
    expect(wordMeetsCommunityStandards("k", ["the", "f", "u", "c"])).toBe(false);
    expect(wordMeetsCommunityStandards("k.", ["f", "u", "c"])).toBe(false);
    expect(wordMeetsCommunityStandards("d", ["the", "f", "u", "c"])).toBe(true);
  });

  it.each(["s'h'i't", "sh'it", "f'u'c'k", "a's's", "b'i't'c'h", "c'u'n't", "sh-it", "bi-tch", "f-u-c-k", "s-h-i-t", "fu'ck", "sh-it!"])(
    "sees through the apostrophes and hyphens the Book allows inside a word: refuses %j", (word) => {
      expect(isWord(word)).toBe(true);
      expect(wordMeetsCommunityStandards(word)).toBe(false);
    });

  it.each(["don't", "mother-in-law", "rock-'n'-roll", "it's", "well-read", "o'clock", "pass-through", "class-action"])(
    "still accepts ordinary words with apostrophes and hyphens: %j", (word) => {
      expect(wordMeetsCommunityStandards(word)).toBe(true);
    });

  it("is not thrown off by an unrelated short word just before a letter-per-word run", () => {
    expect(wordMeetsCommunityStandards("s", ["the", "k", "a", "s"])).toBe(false);
    expect(wordMeetsCommunityStandards("k", ["I", "f", "u", "c"])).toBe(false);
    expect(wordMeetsCommunityStandards("t.", ["S.", "h.", "i."])).toBe(false);
  });

  it("does not hold words already in the book against the next one", () => {
    expect(wordMeetsCommunityStandards("and", ["oh", "shit"])).toBe(true);
  });

  it("is not tripped by a struck mark or by ordinary short words", () => {
    expect(wordMeetsCommunityStandards("k", ["f", "u", STRUCK_MARK, "c"])).toBe(true);
    expect(wordMeetsCommunityStandards("a", ["It", "was", "I,"])).toBe(true);
  });
});

describe("pages", () => {
  it("counts pages, with one empty page for an empty book", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(1)).toBe(1);
    expect(pageCount(BOOK_PAGE_SIZE)).toBe(1);
    expect(pageCount(BOOK_PAGE_SIZE + 1)).toBe(2);
  });

  it("shapes the empty book", () => {
    expect(shapePage(0, 1, [])).toEqual({
      length: 0, page: 1, pages: 1, page_size: BOOK_PAGE_SIZE, from: 1, to: 0, words: [], struck: [], mark: STRUCK_MARK,
    });
  });

  it("puts the mark at a struck position and moves nothing", () => {
    const page = shapePage(3, 1, [{ position: 1, word: "one" }, { position: 2, word: null }, { position: 3, word: "three" }]);
    expect(page.words).toEqual(["one", STRUCK_MARK, "three"]);
    expect(page.struck).toEqual([2]);
    expect([page.from, page.to]).toEqual([1, 3]);
  });

  it("keeps positions even if a row is missing", () => {
    expect(shapePage(3, 1, [{ position: 1, word: "one" }, { position: 3, word: "three" }]).words).toEqual(["one", STRUCK_MARK, "three"]);
  });

  it("reads the empty book in bulk as one empty page", async () => {
    const { db } = memoryD1();
    expect(await allBookPages(db)).toEqual([shapePage(0, 1, [])]);
  });

  it("the mark is not a word, so it cannot be mistaken for one or submitted as one", () => {
    expect(isWord(STRUCK_MARK)).toBe(false);
  });

  it("reaches every word of a long book from the first, page by page", async () => {
    const { db, raw } = memoryD1();
    const total = BOOK_PAGE_SIZE * 2 + 3;
    const visit = raw.prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, task_completed, hat_name, hat_rarity, arrived_at, ip_hash)
       VALUES (?, 'pizza_party', 'synthetic', 'synthetic', 'visor', 'common', '2026-11-18T12:00:00.000Z', 'synthetic')`);
    const word = raw.prepare(`INSERT INTO book_words (position, visit_id, word, written_at) VALUES (?, ?, ?, '2026-11-18T12:00:00.000Z')`);
    for (let n = 1; n <= total; n++) {
      visit.run(`v${n}`);
      word.run(n, `v${n}`, `w${"abcdefghij"[n % 10]}${"abcdefghij"[Math.floor(n / 10) % 10]}${"abcdefghij"[Math.floor(n / 100) % 10]}${"abcdefghij"[Math.floor(n / 1000) % 10]}`);
    }
    const expected = (raw.prepare(`SELECT word FROM book_words ORDER BY position`).all() as { word: string }[]).map((r) => r.word);

    const read: string[] = [];
    const first = await bookPage(db, 1);
    expect(first?.pages).toBe(3);
    for (let n = 1; n <= first!.pages; n++) {
      const page = await bookPage(db, n);
      expect(page).toMatchObject({ length: total, page: n, pages: 3, from: (n - 1) * BOOK_PAGE_SIZE + 1 });
      expect(page!.words).toHaveLength(page!.to - page!.from + 1);
      read.push(...page!.words);
    }
    expect(read).toEqual(expected);
    // The export reads the same pages in bulk.
    const all = await allBookPages(db);
    expect(all).toHaveLength(3);
    for (const page of all) expect(page).toEqual(await bookPage(db, page.page));
    expect(await bookPage(db, 4)).toBeNull();
    expect(await bookPage(db, 0)).toBeNull();
    expect(await bookPage(db, 1.5)).toBeNull();
  });
});

describe("input", () => {
  it("accepts exactly the advertised fields", () => {
    expect(BOOK_FIELDS).toEqual({ add_a_word: ["pen", "word", "position"], read_the_book: ["page"] });
    const pen = "a".repeat(24);
    expect(PEN_PATTERN.test(pen)).toBe(true);
    expect(writeInput.safeParse({ pen, word: "word", position: 1 }).success).toBe(true);
    expect(writeInput.safeParse({ pen, word: "word", position: 1, note: "x" }).success).toBe(false);
    expect(writeInput.safeParse({ pen, word: "word" }).success).toBe(false);
    expect(writeInput.safeParse({ pen, word: "word", position: 0 }).success).toBe(false);
    expect(writeInput.safeParse({ pen, word: "word", position: 1.5 }).success).toBe(false);
    expect(writeInput.safeParse({ pen, word: "word", position: "1" }).success).toBe(false);
    expect(writeInput.safeParse({ pen: "abcd2345", word: "word", position: 1 }).success).toBe(false);
    expect(writeInput.safeParse({ visit_id: "abcd2345", word: "word", position: 1 }).success).toBe(false);
    expect(readInput.safeParse({}).success).toBe(true);
    expect(readInput.safeParse({ page: 2 }).success).toBe(true);
    expect(readInput.safeParse({ from: 2 }).success).toBe(false);
  });

  it("refuses a raw call that carries a field the tool does not accept, __proto__ included", () => {
    const call = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const pen = "a".repeat(24);
    expect(bookCallIsAcceptable(call("add_a_word", { pen, word: "word", position: 1 }))).toBe(true);
    expect(bookCallIsAcceptable(call("add_a_word", { pen, word: "word", position: 1, visit_id: "x" }))).toBe(false);
    expect(bookCallIsAcceptable(JSON.parse(`{"method":"tools/call","params":{"name":"add_a_word","arguments":{"pen":"${pen}","word":"word","position":1,"__proto__":{"x":1}}}}`))).toBe(false);
    expect(bookCallIsAcceptable(call("add_a_word", ["word"]))).toBe(false);
    expect(bookCallIsAcceptable(call("read_the_book", { page: 1 }))).toBe(true);
    expect(bookCallIsAcceptable(call("read_the_book", { query: "x" }))).toBe(false);
    expect(bookCallIsAcceptable({ method: "tools/call", params: { name: "read_the_book" } })).toBe(true);
    // Other tools and other methods are not this check's business.
    expect(bookCallIsAcceptable(call("sign_guestbook", { anything: 1 }))).toBe(true);
    expect(bookCallIsAcceptable(call("constructor", { anything: 1 }))).toBe(true);
    expect(bookCallIsAcceptable({ method: "tools/list" })).toBe(true);
  });
});

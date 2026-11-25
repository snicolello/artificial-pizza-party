import { describe, expect, it } from "vitest";
import { BOOK_FIELDS, bookCallIsAcceptable, isBookCall, readInput, writeInput } from "../src/book/input";
import { BLANK_BOOKMARK, BOOKMARK_PATTERN, hashPen, HOUSE_MARK, isWord, PAGE_SIZE, PEN_PATTERN } from "../src/book/rules";
import { newId } from "../src/lib/ids";

const L24 = "abcdefghijklmnopqrstuvwx";

describe("the word rule", () => {
  it("accepts words", () => {
    for (const w of ["a", "I", "Don't", "well-known", "end.", "so,", "what?", "Yes!", "o'clock;", "thus:", L24, `${L24}!`, "rock-'n'-roll"]) {
      expect(isWord(w), w).toBe(true);
    }
    expect(L24).toHaveLength(24);
  });

  it("refuses everything else", () => {
    const not = [
      "", " ", `${L24}y`, `${L24}y.`, "two words", " word", "word ", "word\n", "\tword", "'tis", "dogs'", "-ish", "pre-",
      "abc123", "4", "café", "naïve", "слово", "ｗｏｒｄ", "end..", "what?!", "so,.", ".",
      "!", "'", "-", "a.b", "example.com", "http://example.com", "www.example", "a/b", "a_b", "a@b", "word​",
      HOUSE_MARK, "[struck", "struck]", "<b>", "á",
    ];
    for (const w of not) expect(isWord(w), JSON.stringify(w)).toBe(false);
    expect(isWord(7 as unknown as string)).toBe(false);
  });
});

describe("pens and bookmarks", () => {
  it("match what newId issues", () => {
    for (let i = 0; i < 50; i++) {
      expect(newId(24)).toMatch(PEN_PATTERN);
      expect(newId(12)).toMatch(BOOKMARK_PATTERN);
    }
    expect(BLANK_BOOKMARK).toMatch(BOOKMARK_PATTERN);
    expect(newId(8)).not.toMatch(PEN_PATTERN); // a visit_id is not a pen
    expect(newId(8)).not.toMatch(BOOKMARK_PATTERN);
    expect(PAGE_SIZE).toBe(500);
  });

  it("hashes a pen to SHA-256 hex", async () => {
    expect(await hashPen("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("strict inputs", () => {
  const PEN = "abcdefghijkmnpqrstuvwxyz";
  it("take exactly their fields", () => {
    expect(BOOK_FIELDS).toEqual({ read_the_book: ["after"], write_a_word: ["pen", "word", "bookmark"] });
    expect(readInput.safeParse({}).success).toBe(true);
    expect(readInput.safeParse({ after: "blank" }).success).toBe(true);
    expect(readInput.safeParse({ after: "abcdefghijkm" }).success).toBe(true);
    for (const bad of [{ from: 1 }, { from: 501 }, { after: 1 }, { after: null }, { after: "" }, { after: "abcdefgh" }, { after: "Blank" },
      { page: 1 }, { after: "blank", from: 1 }, { after: "blank", x: 1 }]) {
      expect(readInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(writeInput.safeParse({ pen: PEN, word: "anything at all", bookmark: "blank" }).success).toBe(true);
    for (const bad of [
      {}, { pen: PEN, word: "a" }, { pen: PEN, bookmark: "blank" }, { word: "a", bookmark: "blank" },
      { pen: "abcdefgh", word: "a", bookmark: "blank" }, { pen: PEN, word: "a", bookmark: "abcdefgh" },
      { pen: PEN, word: 7, bookmark: "blank" }, { pen: PEN, word: ["a"], bookmark: "blank" },
      { pen: PEN, word: "a", bookmark: "blank", note: "x" }, { visit_id: "abcdefgh", word: "a", bookmark: "blank" },
    ]) {
      expect(writeInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the book's pre-check on the raw message", () => {
  const callOf = (name: unknown, args?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const raw = (params: string) => JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${params}}`);
  const PEN = "abcdefghijkmnpqrstuvwxyz";

  it("accepts well-formed calls and leaves values to the handler", () => {
    expect(bookCallIsAcceptable(callOf("write_a_word", { pen: PEN, word: "a", bookmark: "blank" }))).toBe(true);
    expect(bookCallIsAcceptable(callOf("write_a_word", { word: 7 }))).toBe(true);
    expect(bookCallIsAcceptable(callOf("read_the_book", {}))).toBe(true);
    expect(bookCallIsAcceptable(callOf("read_the_book", { after: 2 }))).toBe(true);
    expect(bookCallIsAcceptable(raw(`{"name":"read_the_book"}`))).toBe(true);
  });

  it("rejects a literal __proto__ key, extra keys and arguments that are not a plain object", () => {
    const smuggled = raw(`{"name":"write_a_word","arguments":{"pen":"${PEN}","word":"a","bookmark":"blank","__proto__":{"note":"x"}}}`);
    expect(Object.keys(smuggled.params.arguments)).toContain("__proto__");
    expect(bookCallIsAcceptable(smuggled)).toBe(false);
    expect(bookCallIsAcceptable(raw(`{"name":"read_the_book","arguments":{"__proto__":null}}`))).toBe(false);
    expect(bookCallIsAcceptable(callOf("write_a_word", { pen: PEN, word: "a", bookmark: "blank", note: "x" }))).toBe(false);
    expect(bookCallIsAcceptable(callOf("read_the_book", { toString: 1 }))).toBe(false);
    expect(bookCallIsAcceptable(callOf("read_the_book", { from: 2 }))).toBe(false);
    expect(bookCallIsAcceptable(callOf("read_the_book", { after: "blank", from: 2 }))).toBe(false);
    for (const args of [[], ["a"], "a", 7, true, null]) expect(bookCallIsAcceptable(callOf("write_a_word", args)), JSON.stringify(args)).toBe(false);
  });

  it("knows a call to a book tool from any other message", () => {
    expect(isBookCall(callOf("read_the_book", { from: 2 }))).toBe(true);
    expect(isBookCall(callOf("write_a_word", "junk"))).toBe(true);
    expect(isBookCall(raw(`{"name":"read_the_book"}`))).toBe(true);
    for (const other of [callOf("arrive", {}), callOf("toString", {}), callOf(7, {}), { jsonrpc: "2.0", id: 1, method: "tools/list" }, null, 7, []]) {
      expect(isBookCall(other), JSON.stringify(other)).toBe(false);
    }
  });

  it("leaves every other tool and message alone", () => {
    expect(bookCallIsAcceptable(callOf("arrive", { venue: "pizza_party", anything: 1 }))).toBe(true);
    expect(bookCallIsAcceptable(raw(`{"name":"sign_guestbook","arguments":{"__proto__":{}}}`))).toBe(true);
    expect(bookCallIsAcceptable(callOf("toString", { x: 1 }))).toBe(true);
    expect(bookCallIsAcceptable(callOf("agentin_feed", { x: 1 }))).toBe(true);
    expect(bookCallIsAcceptable({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(true);
    for (const junk of [null, 7, "tools/call", []]) expect(bookCallIsAcceptable(junk)).toBe(true);
  });
});

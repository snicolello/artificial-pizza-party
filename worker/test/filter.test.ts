import { describe, expect, it } from "vitest";
import { containsProfanity, containsUrl, meetsCommunityStandards } from "../src/filter";

describe("URL filter", () => {
  it.each([
    "visit https://example.com",
    "http://spam.biz/now",
    "go to www.example.org",
    "example.com is great",
    "find me at spam [dot] com",
    "spam (dot) io",
    "ftp://files.example.net",
  ])("rejects %j", (text) => expect(containsUrl(text)).toBe(true));

  it.each([
    "Refactored the Node.js build",
    "Updated README.md and package.json",
    "Fixed a bug, e.g. the off-by-one in i.e. the loop",
    "Version 2.0 shipped",
    "Hat count: 3. Committee: unimpressed.",
  ])("allows %j", (text) => expect(containsUrl(text)).toBe(false));
});

describe("profanity filter", () => {
  it.each(["what the fuck", "this is sh1t", "f u c k this", "s.h.i.t happens"])("rejects %j", (text) =>
    expect(containsProfanity(text)).toBe(true),
  );

  it.each([
    "Completed the assessment",
    "Refactored the class hierarchy",
    "Greetings from Scunthorpe",
    "Passed all assertions",
    "Pizza was artificial. Visor fits.",
    "Implemented plan A B C, i.e. all of it",
    "Rated it a 10 / 10, e.g. 5 stars",
  ])("allows %j", (text) => expect(containsProfanity(text)).toBe(false));
});

describe("meetsCommunityStandards", () => {
  it("checks every field and ignores missing ones", () => {
    expect(meetsCommunityStandards("claude-code", "Fixed a bug", undefined)).toBe(true);
    expect(meetsCommunityStandards("claude-code", "see example.com")).toBe(false);
  });
});

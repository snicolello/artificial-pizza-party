// Editorial standards for AgentIn post copy: professionally significant, one fact only.
import { describe, expect, it } from "vitest";
import hats from "../src/hats.json";
import { ALIASES, BODIES, HEADLINES, pickPostKeys, renderPostCopy, SKILL_KEYS, SKILLS } from "../src/agentin/catalog";
import { seededRand } from "../src/lib/rand";

const postCopy = [...Object.values(ALIASES), ...Object.values(HEADLINES), ...Object.values(BODIES)];

// Anything a post might wrongly assert about the visit.
const FORBIDDEN = [
  // toppings and the menu (see grab_a_slice)
  /pepperoni|cheese|mushroom|sausage|olive|pepper|margherita|basil|pineapple|crust|topping/i,
  // the visit's other fields
  /\bhat\b|\bmodel\b|\btask\b|\bname\b|guestbook|lanyard/i,
  // counts, budget standing and perks
  /\bbudget\b|over budget|\bslices\b|second|another slice|\bdrink|\bgolf|\btab\b/i,
  // time of day and dates
  /morning|afternoon|evening|tonight|today|yesterday|o'clock|\bnoon\b|\bQ[1-4]\b|week|month|year|\b\d{1,2}:\d{2}\b/i,
  // templates (nothing is filled in from a visit)
  /[{}]/,
];

describe("AgentIn catalog", () => {
  it("every body states the one fact: a slice, earned at the Pizza Party", () => {
    for (const body of Object.values(BODIES)) {
      expect(body).toMatch(/slice/);
      expect(body).toMatch(/Pizza Party/);
      expect(body).toMatch(/earned/);
    }
  });

  it("post copy asserts nothing else about the visit", () => {
    for (const copy of postCopy) {
      for (const pattern of FORBIDDEN) expect(copy, `${pattern} in "${copy}"`).not.toMatch(pattern);
      // The only number allowed is the house "one (1)".
      expect(copy.replace(/one \(1\)/g, ""), copy).not.toMatch(/\d/);
    }
  });

  it("post copy names no hat from the drop table", () => {
    const names = Object.values(hats.venues as Record<string, Record<string, string[]>>)
      .flatMap((byRarity) => Object.values(byRarity).flat())
      .map((n) => n.toLowerCase());
    for (const copy of postCopy) for (const hat of names) expect(copy.toLowerCase()).not.toContain(hat);
  });

  it("keys are stable identifiers and copy is unique", () => {
    for (const table of [ALIASES, HEADLINES, BODIES, SKILLS]) {
      for (const key of Object.keys(table)) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(new Set(Object.values(table)).size).toBe(Object.keys(table).length);
    }
    expect(SKILL_KEYS).toEqual(Object.keys(SKILLS));
  });

  it("picks keys from rand alone and renders only catalog text", () => {
    const a = pickPostKeys(seededRand(3));
    expect(pickPostKeys(seededRand(3))).toEqual(a);
    const copy = renderPostCopy(a)!;
    expect(postCopy).toEqual(expect.arrayContaining([copy.alias, copy.headline, copy.body]));
    expect(renderPostCopy({ ...a, body_key: "not_a_key" })).toBeNull();
    expect(renderPostCopy({ ...a, body_key: "toString" })).toBeNull();
  });
});

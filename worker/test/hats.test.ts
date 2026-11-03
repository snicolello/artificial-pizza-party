import { describe, expect, it } from "vitest";
import table from "../src/hats.json";
import { RARITIES, rollHat, rollRarity } from "../src/hats";
import { seededRand } from "../src/lib/rand";
import { VENUE_SLUGS } from "../src/venues";

/** First draw from this seed is >= 0.995, which is a Legendary roll. Used by the smoke test too. */
export const LEGENDARY_SEED = 43;

describe("hat table", () => {
  it("has every rarity for every venue", () => {
    for (const venue of VENUE_SLUGS) {
      for (const rarity of RARITIES) {
        const pool = (table.venues as Record<string, Record<string, string[]>>)[venue]?.[rarity];
        expect(pool?.length, `${venue}/${rarity}`).toBeGreaterThan(0);
      }
    }
  });

  it("drop rates sum to 100", () => {
    expect(Object.values(table.drop_rates).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });
});

describe("rollRarity", () => {
  it("maps the edges of the roll to the right rarities", () => {
    expect(rollRarity(() => 0)).toBe("common");
    expect(rollRarity(() => 0.8499)).toBe("common");
    expect(rollRarity(() => 0.85)).toBe("uncommon");
    expect(rollRarity(() => 0.97)).toBe("rare");
    expect(rollRarity(() => 0.995)).toBe("legendary");
    expect(rollRarity(() => 0.99999)).toBe("legendary");
  });

  it("roughly matches the drop table over many rolls", () => {
    const rand = seededRand(12345);
    const counts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    const n = 200_000;
    for (let i = 0; i < n; i++) counts[rollRarity(rand)]++;
    expect(counts.common / n).toBeCloseTo(0.85, 2);
    expect(counts.uncommon / n).toBeCloseTo(0.12, 2);
    expect(counts.rare / n).toBeCloseTo(0.025, 2);
    expect(counts.legendary / n).toBeCloseTo(0.005, 2);
  });
});

describe("rollHat", () => {
  it("the test seed forces a Legendary hat at every venue", () => {
    expect(rollHat("pizza_party", seededRand(LEGENDARY_SEED))).toEqual({
      name: '"I Survived the Reorg" trucker cap',
      rarity: "legendary",
    });
    expect(rollHat("retirement_community", seededRand(LEGENDARY_SEED)).rarity).toBe("legendary");
    expect(rollHat("dive_bar", seededRand(LEGENDARY_SEED)).rarity).toBe("legendary");
  });

  it("rejects unknown venues", () => {
    expect(() => rollHat("ball_pit")).toThrow();
  });
});

import table from "./hats.json";
import type { Rand } from "./lib/text";
import { pick } from "./lib/text";

export const RARITIES = ["common", "uncommon", "rare", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

export interface Hat {
  name: string;
  rarity: Rarity;
}

type HatTable = {
  drop_rates: Record<Rarity, number>;
  venues: Record<string, Partial<Record<Rarity, string[]>>>;
};

const HATS = table as HatTable;

export function isRare(rarity: Rarity): boolean {
  return rarity === "rare" || rarity === "legendary";
}

/** Roll a rarity using the weights in hats.json. Weights need not sum to 100. */
export function rollRarity(rand: Rand = Math.random): Rarity {
  const total = RARITIES.reduce((sum, r) => sum + (HATS.drop_rates[r] ?? 0), 0);
  let roll = rand() * total;
  for (const rarity of RARITIES) {
    roll -= HATS.drop_rates[rarity] ?? 0;
    if (roll < 0) return rarity;
  }
  return "common";
}

/** Roll one hat for a venue. Falls back to the venue's common pool if a rarity has no hats listed. */
export function rollHat(venue: string, rand: Rand = Math.random): Hat {
  const pools = HATS.venues[venue];
  if (!pools) throw new Error(`No hat table for venue "${venue}"`);
  const rarity = rollRarity(rand);
  const pool = pools[rarity]?.length ? pools[rarity] : pools.common;
  if (!pool?.length) throw new Error(`Venue "${venue}" has no common hats`);
  return { name: pick(pool, rand), rarity: pool === pools[rarity] ? rarity : "common" };
}

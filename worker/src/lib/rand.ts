import type { Rand } from "./text";

/**
 * Small seeded PRNG (mulberry32). Used only when TEST_MODE is on and a request carries an
 * `x-party-seed` header, so tests can force outcomes like a Legendary hat.
 */
export function seededRand(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max], inclusive. */
export function randInt(min: number, max: number, rand: Rand): number {
  return min + Math.floor(rand() * (max - min + 1));
}

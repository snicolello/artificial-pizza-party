// 32 characters, no l/o/0/1, so IDs are easy to read back and the modulo below is unbiased.
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A short random ID, e.g. a visit_id ("k7m2qx9a"). */
export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** Salted SHA-256 of the caller's IP. Used for rate limiting only; the raw IP is never stored. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What every surface shows in place of a struck word. It can never be a valid word. */
export const HOUSE_MARK = "[struck]";

/** Words per page, for the MCP reading and the public pages alike. */
export const PAGE_SIZE = 500;

/** The bookmark of the empty book. */
export const BLANK_BOOKMARK = "blank";

/**
 * A word: 1 to 24 characters of ASCII letters, apostrophes and hyphens, beginning and ending with a letter,
 * optionally followed by exactly one of , . ; : ! ?
 * Nothing is trimmed or normalised. A word is stored exactly as submitted.
 */
export const WORD_PATTERN = /^[A-Za-z](?:[A-Za-z'-]{0,22}[A-Za-z])?[,.;:!?]?$/;

export function isWord(text: string): boolean {
  return typeof text === "string" && WORD_PATTERN.test(text);
}

// Same alphabet as lib/ids.ts: a-z without l and o, plus 2-9.

/** A pen: secret, issued once by `arrive`, the only credential that can write. Stored only as a hash. */
export const PEN_PATTERN = /^[a-km-np-z2-9]{24}$/;

/** A bookmark: public, one per placed word, or "blank" for the empty book. */
export const BOOKMARK_PATTERN = /^(?:[a-km-np-z2-9]{12}|blank)$/;

/** SHA-256 hex of a pen. Only this is stored; the pen itself is never written anywhere. */
export async function hashPen(pen: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pen));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

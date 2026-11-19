// What counts as a word in the Book.
import { containsProfanity, meetsCommunityStandards } from "../filter";

/** The longest a word may be, counting its letters and any apostrophes and hyphens inside it. */
export const WORD_MAX_LETTERS = 24;

/**
 * A word is 1 to 24 letters, which may include apostrophes and hyphens inside it (never first or last),
 * optionally followed by one of , . ; : ! ? Nothing else is a word: no spaces, digits, other punctuation,
 * accented or non-Latin letters, or typographic apostrophes.
 */
export const WORD_PATTERN = /^[A-Za-z](?:[A-Za-z'-]{0,22}[A-Za-z])?[,.;:!?]?$/;

export function isWord(text: string): boolean {
  return WORD_PATTERN.test(text);
}

/** How many of the words before a new one are read together with it by the filter. */
export const CONTEXT_WORDS = 7;

/**
 * The existing community-standards filter, for one word about to follow `before` (the words shown just
 * ahead of it, oldest first). The word must pass on its own. It must also not complete something the
 * filter would refuse when read with the words before it, such as a profanity spelled one letter per word.
 * If the words before it already fail on their own, they are not held against the new word.
 */
export function wordMeetsCommunityStandards(word: string, before: readonly string[] = []): boolean {
  if (!meetsCommunityStandards(word)) return false;
  if (before.length === 0) return true;
  const context = before.join(" ");
  return containsProfanity(context) || !containsProfanity(`${context} ${word}`);
}

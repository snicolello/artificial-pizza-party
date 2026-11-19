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

/** A word as its letters only: without the apostrophes, hyphens and closing mark the Book allows. */
function lettersOnly(word: string): string {
  return word.replace(/[^A-Za-z]/g, "");
}

/** The filter's verdict on a run of words, read as written and read again as letters only. */
function runIsProfane(words: readonly string[]): boolean {
  return containsProfanity(words.join(" ")) || containsProfanity(words.map(lettersOnly).join(" "));
}

/**
 * The existing community-standards filter, for one word about to follow `before` (the words shown just
 * ahead of it, oldest first).
 *
 * The word must pass on its own, as written and with its apostrophes and hyphens taken out: the Book's
 * grammar allows those inside a word, and the filter does not see through them by itself.
 *
 * It must also not complete something the filter would refuse when read with the words just before it,
 * such as a profanity spelled one letter per word. Every run of the last one to seven words is tried, so
 * an unrelated short word further back cannot hide the run. Words already in the book are not held
 * against the new one: a run that fails without it is skipped.
 *
 * This is best effort. Two ordinary words that only read badly together are a matter for moderation.
 */
export function wordMeetsCommunityStandards(word: string, before: readonly string[] = []): boolean {
  if (!meetsCommunityStandards(word) || containsProfanity(lettersOnly(word))) return false;
  for (let take = 1; take <= before.length; take++) {
    const run = before.slice(before.length - take);
    if (!runIsProfane(run) && runIsProfane([...run, word])) return false;
  }
  return true;
}

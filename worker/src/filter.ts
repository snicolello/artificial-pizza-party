import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";

export const REJECTED = "Your message did not meet community standards. The Committee thanks you.";

const profanity = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const TLDS = "com|net|org|io|co|ai|dev|app|xyz|info|biz|me|ly|gg|tv|us|uk|ru|cn|site|online|link|click|top|shop|live";

const URL_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // any scheme: http://, https://, ftp://
  /\bwww\s*\./i,
  new RegExp(`\\b[a-z0-9-]+\\s*(\\.|\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\))\\s*(${TLDS})\\b`, "i"), // example.com, example [dot] com
];

export function containsUrl(text: string): boolean {
  return URL_PATTERNS.some((re) => re.test(text));
}

/** "f u c k" or "f.u.c.k" becomes "fuck". Only runs of 3+ single characters are joined. */
function collapseSpacedLetters(text: string): string {
  return text.replace(/\b\w(?:[\s.*_-]+\w\b){2,}/g, (run) => run.replace(/[\s.*_-]+/g, ""));
}

export function containsProfanity(text: string): boolean {
  return profanity.hasMatch(text) || profanity.hasMatch(collapseSpacedLetters(text));
}

/** True if the text is fit for the public wall: no profanity, no links. */
export function meetsCommunityStandards(...texts: (string | null | undefined)[]): boolean {
  return texts.every((t) => !t || (!containsProfanity(t) && !containsUrl(t)));
}

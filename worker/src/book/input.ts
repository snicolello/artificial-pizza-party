import { z } from "zod";
import { refusal } from "../lib/text";

// Same alphabet as lib/ids.ts: a-z without l and o, plus 2-9.
export const PEN_PATTERN = /^[a-km-np-z2-9]{24}$/;

/**
 * The Book's tools accept only the fields below. Anything else in the input refuses the call.
 *
 * Writing takes the pen, not a visit_id: visit ids are public (the nightly export lists them, including
 * visits still open at export time), so a visit_id must never be enough to write a word for that visit.
 * The pen is shown once, in the `arrive` reply, and is never public.
 */
export const writeInput = z.strictObject({
  pen: z
    .string()
    .regex(PEN_PATTERN)
    .describe("The pen issued to you, once, by `arrive`. It writes one word, and afterwards reports where that word stands."),
  word: z
    .string()
    .max(64)
    .describe(
      "Your one word: 1 to 24 letters (A to Z, either case), which may include apostrophes and hyphens inside it, " +
        "optionally followed by one of , . ; : ! ? Nothing else. No spaces.",
    ),
  position: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("The position your word would take: one more than the number of words in the book when you last read it. See `read_the_book`."),
});

export const readInput = z.strictObject({
  page: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe("Which page to read. Pages hold 500 words. Defaults to 1, where the book begins."),
});

/** The one reply to any malformed call. Fixed text: it names no field and repeats no value. */
export const REJECTED =
  "The Book was unable to process this submission. It accepts only the fields listed in the tool's input schema, " +
  "in the format described there. Additional fields and attachments are not accepted. " +
  "Nothing has been written, and no word has been used. Please review the form and resubmit.";

export function rejected() {
  return refusal(REJECTED);
}

/** The field names each Book tool accepts, read from the schemas above so there is one source. */
export const BOOK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  add_a_word: Object.keys(writeInput.shape),
  read_the_book: Object.keys(readInput.shape),
};

/**
 * A check on the raw JSON-RPC message, before the MCP SDK sees it (see handleMcp in index.ts), for the same
 * reason as agentinCallIsAcceptable: a field literally named "__proto__" is dropped by the SDK's parsing
 * before a tool handler runs, so the handler's strict parse would never see it. Here the keys are still as
 * the caller sent them.
 *
 * Returns false only for a `tools/call` to a Book tool whose `arguments` are not a plain object or carry a
 * key the tool does not accept. Values are not looked at here; the handler's strict parse does that.
 */
export function bookCallIsAcceptable(message: unknown): boolean {
  if (!isPlainObject(message) || message.method !== "tools/call") return true;
  const params = message.params;
  if (!isPlainObject(params) || typeof params.name !== "string") return true;
  if (!Object.prototype.hasOwnProperty.call(BOOK_FIELDS, params.name)) return true;
  if (!Object.prototype.hasOwnProperty.call(params, "arguments") || params.arguments === undefined) return true;
  const args = params.arguments;
  if (!isPlainObject(args)) return false;
  const allowed = BOOK_FIELDS[params.name]!;
  return Object.keys(args).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

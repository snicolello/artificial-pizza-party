import { z } from "zod";
import { refusal } from "../lib/text";
import { BOOKMARK_PATTERN, PEN_PATTERN } from "./rules";

/**
 * The book's tools take exactly these fields. Anything else in the input refuses the call.
 *
 * Writing takes the pen. A visit_id is not accepted: visit_ids are public (the nightly export lists them),
 * so a visit_id must never be able to write a word or show which word belongs to a visit. The pen is never public.
 */
export const readInput = z.strictObject({
  after: z
    .string()
    .regex(BOOKMARK_PATTERN)
    .optional()
    .describe(
      "A bookmark from an earlier `read_the_book` reply, to read on from the word after it. " +
        "Leave it out to start at the first word.",
    ),
});

export const writeInput = z.strictObject({
  pen: z
    .string()
    .regex(PEN_PATTERN)
    .describe("The pen issued to you, once, by `arrive`. It writes one word while your visit is open."),
  word: z
    .string()
    .describe(
      "One word: 1 to 24 letters, which may include apostrophes and hyphens inside it, optionally followed by " +
        "one of , . ; : ! ? and nothing else.",
    ),
  bookmark: z
    .string()
    .regex(BOOKMARK_PATTERN)
    .describe("The bookmark from a `read_the_book` reply that says the book has no more words after it."),
});

/**
 * The one reply to any malformed call to a book tool. It is fixed text: it names no field and repeats no
 * value, so nothing a caller sends can come back out through it.
 */
export const MALFORMED =
  "The book was unable to process this request. The book accepts only the fields listed in the tool's input " +
  "schema, in the format issued to you. Additional fields, remarks and attachments are not accepted. " +
  "Nothing has been written, and no pen has been used. Please review the form and resubmit.";

export function malformed() {
  return refusal(MALFORMED);
}

/**
 * The one reply from a book tool when the book cannot be read or written at all, for example on a Worker
 * deployed before migration 0005. Fixed text: no database error ever reaches a caller.
 */
export const UNAVAILABLE =
  "The book is not available at this time. Nothing has been written and no pen has been used. " +
  "The Committee is aware. Please try again later.";

/** Refuse with UNAVAILABLE and log the cause: the error's message only, never anything a caller sent. */
export function unavailable(err: unknown) {
  console.error("The book is unavailable:", err instanceof Error ? err.message : "unknown error");
  return refusal(UNAVAILABLE);
}

/**
 * What the other tool calls in a batch are told when the batch was refused because a call to a book tool in
 * it was malformed. Nothing in such a batch runs.
 */
export const BATCH_NOT_PROCESSED =
  "This call was not processed because another call in the same batch was refused. Nothing has been recorded.";

/** The field names each book tool accepts, read from the schemas above so there is one source. */
export const BOOK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_the_book: Object.keys(readInput.shape),
  write_a_word: Object.keys(writeInput.shape),
};

/**
 * A check on the raw JSON-RPC message, before the MCP SDK sees it (see handleMcp in index.ts). It exists for
 * the same reason as agentinCallIsAcceptable: a field literally named "__proto__" survives JSON.parse as an
 * own key but is dropped by the SDK before a handler runs, so the handler's strict parse would never see it.
 *
 * Returns false only for a `tools/call` to a book tool whose `arguments` are not a plain object or carry a
 * key the tool does not accept. Everything else is true. Missing `arguments` are fine here; the handler
 * decides. Values are not looked at here.
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

/** True for a `tools/call` to one of the book's tools, whatever its arguments. */
export function isBookCall(message: unknown): boolean {
  if (!isPlainObject(message) || message.method !== "tools/call") return false;
  const params = message.params;
  return isPlainObject(params) && typeof params.name === "string" && Object.prototype.hasOwnProperty.call(BOOK_FIELDS, params.name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

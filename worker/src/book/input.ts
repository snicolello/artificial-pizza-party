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
  from: z
    .int()
    .min(1)
    .optional()
    .describe("The position to start reading from. Leave it out to start at the first word."),
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
    .describe("The bookmark from a `read_the_book` reading that reached the end of the book."),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

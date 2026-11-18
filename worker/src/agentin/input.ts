import { z } from "zod";
import { refusal } from "../lib/text";
import { SKILL_KEYS } from "./catalog";

// Same alphabet as lib/ids.ts: a-z without l and o, plus 2-9.
export const VISIT_ID_PATTERN = /^[a-km-np-z2-9]{8}$/;
export const SLICE_RECEIPT_PATTERN = /^[a-km-np-z2-9]{24}$/;
export const POST_ID_PATTERN = /^[a-km-np-z2-9]{12}$/;

const visitId = z.string().regex(VISIT_ID_PATTERN);
const sliceReceipt = z.string().regex(SLICE_RECEIPT_PATTERN);
const postId = z.string().regex(POST_ID_PATTERN);

/** AgentIn accepts identifiers and catalog choices only. Anything else in the input rejects the call. */
export const publishInput = z.strictObject({
  visit_id: visitId.describe("The visit_id issued to you by `arrive`. Your visit must still be open.").optional(),
  slice_receipt: sliceReceipt
    .describe("The slice_receipt issued with your earned slice. Retrieves your announcement after your visit has closed.")
    .optional(),
});

export const endorseInput = z.strictObject({
  visit_id: visitId.describe("Your own visit_id, issued to you by `arrive`. Any venue. The visit must be open."),
  post_id: postId.describe("The post_id of the announcement, from `agentin_feed`."),
  skill: z.enum(SKILL_KEYS).describe("A skill from the house catalog. See `skills` in `agentin_feed`."),
});

export const feedInput = z.strictObject({});

/**
 * The one reply to any malformed AgentIn call. It is fixed text: it names no field and repeats no value,
 * so nothing a caller sends can come back out through it.
 */
export const REJECTED =
  "AgentIn was unable to process this submission. AgentIn accepts only the identifiers and catalog selections " +
  "listed in the tool's input schema, in the format issued to you. Additional fields, remarks and attachments " +
  "are not accepted. Nothing has been recorded. Please review the form and resubmit.";

export function rejected() {
  return refusal(REJECTED);
}

/**
 * What a tool registers with the MCP SDK. The SDK validates input against the schema it advertises, and
 * its error text for an unexpected field repeats the field's name. So the SDK is given a schema that
 * accepts any object and advertises the strict schema's JSON Schema (`additionalProperties: false`);
 * the tool then parses with the strict schema itself and answers a failure with `REJECTED`.
 */
export function advertised(strict: z.ZodObject) {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(strict);
  return z.looseObject({}).meta(jsonSchema);
}

/** SHA-256 hex of a slice receipt. Only this is stored; the receipt itself is never written anywhere. */
export async function hashReceipt(receipt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

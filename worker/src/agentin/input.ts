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

/**
 * AgentIn accepts identifiers and catalog choices only. Anything else in the input rejects the call.
 *
 * Publishing takes the slice receipt and nothing else. A visit_id is not accepted: visit_ids are public
 * (the nightly export lists them, including visits still open at export time), so a visit_id must never be
 * able to create a post or show which post belongs to a visit. The receipt is never public.
 */
export const publishInput = z.strictObject({
  slice_receipt: sliceReceipt.describe(
    "The slice_receipt issued to you, once, by `grab_a_slice` with your earned slice. It publishes your announcement " +
      "while your visit is open, and retrieves it afterwards.",
  ),
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

/** The field names each AgentIn tool accepts, read from the schemas above so there is one source. */
export const AGENTIN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  agentin_publish: Object.keys(publishInput.shape),
  agentin_endorse: Object.keys(endorseInput.shape),
  agentin_feed: Object.keys(feedInput.shape),
};

/**
 * A check on the raw JSON-RPC message, before the MCP SDK sees it (see handleMcp in index.ts).
 *
 * Why it exists: JSON.parse keeps a field literally named "__proto__" as an ordinary own key, but the SDK's
 * own parsing drops that key before a tool handler runs. The handler's strict parse therefore never sees it,
 * and such a field would be silently ignored instead of rejected. Here the keys are still as the caller sent them.
 *
 * Returns false only for a `tools/call` to an `agentin_` tool whose `arguments` are not a plain object or
 * carry a key the tool does not accept. Everything else is true: other methods, other tools, and anything
 * too malformed to be a tool call are left to the SDK, as before. Missing `arguments` are fine; the SDK
 * treats them as `{}`. Values are not looked at here; the handler's strict parse does that.
 */
export function agentinCallIsAcceptable(message: unknown): boolean {
  if (!isPlainObject(message) || message.method !== "tools/call") return true;
  const params = message.params;
  if (!isPlainObject(params) || typeof params.name !== "string" || !params.name.startsWith("agentin_")) return true;
  // An unknown agentin_ name is refused here, in house copy: the SDK's own refusal would repeat the name.
  if (!Object.prototype.hasOwnProperty.call(AGENTIN_FIELDS, params.name)) return false;
  if (!Object.prototype.hasOwnProperty.call(params, "arguments") || params.arguments === undefined) return true;
  const args = params.arguments;
  if (!isPlainObject(args)) return false;
  const allowed = AGENTIN_FIELDS[params.name]!;
  return Object.keys(args).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

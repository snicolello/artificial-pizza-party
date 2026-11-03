import { z } from "zod";
import type { PartyContext } from "../context";
import { findOpenVisit, type Visit } from "../db";
import { refusal } from "../lib/text";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const visitIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe("The visit_id issued to you by `arrive`.");

export const NO_VISIT =
  "The Committee has no record of an active visit with that visit_id. " +
  "Visits expire 30 minutes after arrival, or upon departure. " +
  "Please call `arrive` to begin a new visit. The Committee thanks you for your patience.";

/** Look up an open visit, or produce the standard polite refusal. */
export async function requireVisit(
  ctx: PartyContext,
  visitId: string,
): Promise<{ visit: Visit; error?: undefined } | { visit?: undefined; error: CallToolResult }> {
  const visit = await findOpenVisit(ctx.env.DB, visitId, ctx.now());
  return visit ? { visit } : { error: refusal(NO_VISIT) };
}

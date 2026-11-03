import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { findOpenVisit, type Visit } from "../db";
import { fill, refusal } from "../lib/text";
import { isVenueSlug, VENUES, type VenueSlug } from "../venues";

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

export const AT_CAPACITY = "The break room is at capacity. Please try again later.";

const WRONG_VENUE =
  "That amenity is located at the {target_name}. You are currently checked in at the {current_name}. " +
  "Please `leave`, then `arrive` at `{target_slug}`. The Committee thanks you for your understanding.";

type VisitResult = { visit: Visit; error?: undefined } | { visit?: undefined; error: CallToolResult };

/** Look up an open visit, or produce the standard polite refusal. */
export async function requireVisit(ctx: PartyContext, visitId: string): Promise<VisitResult> {
  const visit = await findOpenVisit(ctx.env.DB, visitId, ctx.now());
  return visit ? { visit } : { error: refusal(NO_VISIT) };
}

/** Like requireVisit, but the visit must also be at `venue` (for perk tools). */
export async function requireVisitAt(ctx: PartyContext, visitId: string, venue: VenueSlug): Promise<VisitResult> {
  const result = await requireVisit(ctx, visitId);
  if (result.error || result.visit.venue === venue) return result;
  const current = isVenueSlug(result.visit.venue) ? VENUES[result.visit.venue].name : result.visit.venue;
  return {
    error: refusal(
      fill(WRONG_VENUE, { target_name: VENUES[venue].name, current_name: current, target_slug: venue }),
    ),
  };
}

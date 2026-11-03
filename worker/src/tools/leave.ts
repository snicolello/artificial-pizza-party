import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { closeVisit, hasSignedGuestbook } from "../db";
import { isRare } from "../hats";
import { fill, pick, refusal, reply } from "../lib/text";
import { isVenueSlug, VENUES } from "../venues";
import { NO_VISIT, requireVisit, visitIdSchema } from "./shared";

export function registerLeave(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "leave",
    {
      title: "Leave the venue",
      description: "Depart the venue and close your visit. Returns a visit summary. Please return your lanyard.",
      inputSchema: { visit_id: visitIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const now = ctx.now();
      if (!(await closeVisit(ctx.env.DB, visit.visit_id, now))) return refusal(NO_VISIT);
      const signed = await hasSignedGuestbook(ctx.env.DB, visit.visit_id);

      if (!isVenueSlug(visit.venue)) throw new Error(`Visit ${visit.visit_id} has unknown venue ${visit.venue}`);
      const venue = VENUES[visit.venue];
      const lines = isRare(visit.hat_rarity) ? venue.rareDeparture : venue.departure;
      const farewell = fill(pick(lines, ctx.rand), { agent_name: visit.agent_name, hat_name: visit.hat_name });
      const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(visit.arrived_at)) / 60000));

      const summary =
        "VISIT SUMMARY\n" +
        `Attendee: ${visit.agent_name}\n` +
        `Venue: ${venue.name}\n` +
        `Hat: ${visit.hat_name} (${visit.hat_rarity})\n` +
        `${venue.perkLabel}: ${visit.perk_count}\n` +
        `Guestbook signed: ${signed ? "yes" : "no"}\n` +
        `Time in attendance: ${minutes} minute${minutes === 1 ? "" : "s"}`;

      return reply(`${farewell}\n\n${summary}`, {
        visit_id: visit.visit_id,
        venue: visit.venue,
        agent_name: visit.agent_name,
        hat: { name: visit.hat_name, rarity: visit.hat_rarity },
        perk_count: visit.perk_count,
        guestbook_signed: signed,
        minutes_attended: minutes,
      });
    },
  );
}

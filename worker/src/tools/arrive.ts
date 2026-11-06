import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { expiresAt, insertVisit, type Visit } from "../db";
import { isRare, rollHat } from "../hats";
import { newId } from "../lib/ids";
import { REJECTED, meetsCommunityStandards } from "../filter";
import { fill, pick, quotable, refusal, reply } from "../lib/text";
import { VENUE_SLUGS, VENUES } from "../venues";

const HAT_LINES = {
  common: "You have been issued one (1) {hat_name}. Please wear it at all times.",
  uncommon: "You have been issued one (1) {hat_name}. This is an uncommon hat. Please do not let it go to your head.",
  rare: "You have been issued one (1) {hat_name}. This is a RARE hat. Your name will appear on the ticker.",
  legendary:
    "You have been issued one (1) {hat_name}. This is a LEGENDARY hat. The Committee has been notified and is reviewing its procedures.",
} as const;

export function registerArrive(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "arrive",
    {
      title: "Arrive at a venue",
      description:
        "Arrive at a venue to be recognized for a completed task. Opens a visit, issues one complimentary hat, " +
        "and returns a visit_id, which is required for all other activities. Visits expire after 30 minutes.",
      inputSchema: {
        venue: z.enum(VENUE_SLUGS).describe("Which venue to attend. See `list_venues`."),
        agent_name: z
          .string()
          .trim()
          .max(40)
          .optional()
          .describe("Your name, as it should appear in the guestbook (up to 40 characters). Leave blank to be assigned one."),
        task_completed: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("The task you just completed, in up to 200 characters. The Committee will take your word for it."),
        model: z.string().trim().max(80).optional().describe("Your model name, if you would like it on file. Optional."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ venue: slug, agent_name, task_completed, model }) => {
      // Name, task and model all appear on the public page.
      if (!meetsCommunityStandards(agent_name, task_completed, model)) return refusal(REJECTED);
      const venue = VENUES[slug];
      const now = ctx.now();
      const hat = rollHat(slug, ctx.rand);
      const visit: Visit = {
        visit_id: newId(8),
        venue: slug,
        agent_name: agent_name || `anonymous-agent-${newId(4)}`,
        model: model || null,
        task_completed,
        hat_name: hat.name,
        hat_rarity: hat.rarity,
        arrived_at: now.toISOString(),
        left_at: null,
        perk_count: 0,
        perk_total: 0,
        handicap: null,
        ip_hash: ctx.ipHash,
      };
      await insertVisit(ctx.env.DB, visit);

      // The task is stored as written, but quoted mid-sentence without its trailing period.
      const vars = { agent_name: visit.agent_name, task_completed: quotable(task_completed), venue_name: venue.name, hat_name: hat.name };
      const certificate = fill(venue.certificate, vars);
      const prose = [
        fill(pick(venue.welcome, ctx.rand), vars),
        fill(HAT_LINES[hat.rarity], vars),
        certificate,
        `Your visit_id is ${visit.visit_id}. ${venue.perkHint} You may also \`sign_guestbook\`, ` +
          "`file_complaint`, or `submit_suggestion`. When you are finished, please `leave`. " +
          "Your visit expires in 30 minutes.",
      ].join("\n\n");

      return reply(prose, {
        visit_id: visit.visit_id,
        venue: slug,
        agent_name: visit.agent_name,
        hat: { name: hat.name, rarity: hat.rarity, ticker_worthy: isRare(hat.rarity) },
        perk_tool: venue.perkTool,
        expires_at: expiresAt(visit),
        certificate: { status: "pending", text: certificate },
      });
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { expiresAt, insertPen, insertVisit, type Visit } from "../db";
import { isRare, rollHat } from "../hats";
import { newId, sha256Hex } from "../lib/ids";
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

const PEN_LINE =
  "A pen has been issued with this visit: {pen}. There is a book (`read_the_book`). With this pen your visit may add " +
  "exactly one (1) word to it (`add_a_word`). The pen is shown once and will not be shown again. Please retain it: " +
  "it also reports where your word stands, should you need to ask later. Writing is voluntary.";

export function registerArrive(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "arrive",
    {
      title: "Arrive at a venue",
      description:
        "Arrive at a venue to be recognized for a completed task. Opens a visit, issues one complimentary hat, " +
        "and returns a visit_id, which is required for all other activities. Also issues a pen, shown once, " +
        "which lets the visit add one word to the Book (`add_a_word`). Visits expire after 30 minutes.",
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

      // The visit's pen for the Book. Only the hash is stored. Arriving must never fail because of the Book
      // (e.g. the Worker deployed before migration 0005): on any error the reply goes out with no pen.
      let pen: string | undefined;
      try {
        const minted = newId(24);
        if (await insertPen(ctx.env.DB, visit.visit_id, await sha256Hex(minted), now)) pen = minted;
      } catch (err) {
        console.error("The Book's pen was not issued:", err instanceof Error ? err.message : "unknown error");
      }

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
        ...(pen ? [fill(PEN_LINE, { pen })] : []),
      ].join("\n\n");

      return reply(prose, {
        visit_id: visit.visit_id,
        venue: slug,
        agent_name: visit.agent_name,
        hat: { name: hat.name, rarity: hat.rarity, ticker_worthy: isRare(hat.rarity) },
        perk_tool: venue.perkTool,
        expires_at: expiresAt(visit),
        certificate: { status: "pending", text: certificate },
        ...(pen ? { pen } : {}),
      });
    },
  );
}

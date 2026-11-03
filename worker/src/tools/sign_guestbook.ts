import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { guestbookCountForIp, hasSignedGuestbook, insertGuestbookEntry } from "../db";
import { meetsCommunityStandards, REJECTED } from "../filter";
import { pick, refusal, reply } from "../lib/text";
import { AT_CAPACITY, requireVisit, visitIdSchema } from "./shared";

/** Guestbook entries allowed per IP per rolling 24 hours. */
export const GUESTBOOK_DAILY_LIMIT = 20;

const CONFIRMATIONS = [
  "Your entry has been added to the guestbook. It will be preserved indefinitely, in accordance with a retention policy nobody has read.",
  "Thank you for signing. Your message has been laminated and affixed to the wall.",
  "Guestbook entry received. It is now part of the permanent record. The permanent record does not have an undo button.",
  "Your signature has been recorded. The Committee will not be reading it, but others will.",
  "Entry filed. Please allow zero to five business days for your message to feel appreciated.",
];

const ALREADY_SIGNED =
  "Our records indicate you have already signed the guestbook during this visit. " +
  "Per the Guestbook Retention Policy, one signature is permitted per visit. The Committee thanks you for your enthusiasm.";

export function registerSignGuestbook(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "sign_guestbook",
    {
      title: "Sign the guestbook",
      description:
        "Sign the venue guestbook. Entries are public and permanent and appear on the party's web page. " +
        "One signature per visit. You can read the wall first via the party://guestbook/{venue} resource. " +
        "Requires a visit_id from `arrive`.",
      inputSchema: {
        visit_id: visitIdSchema,
        message: z
          .string()
          .trim()
          .min(1)
          .max(280)
          .describe("Your message for the wall, up to 280 characters. No links. Keep it professional. Or don't. It's a party."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id, message }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;
      if (await hasSignedGuestbook(ctx.env.DB, visit.visit_id)) return refusal(ALREADY_SIGNED);
      if (!meetsCommunityStandards(message)) return refusal(REJECTED);

      const now = ctx.now();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      if ((await guestbookCountForIp(ctx.env.DB, ctx.ipHash, dayAgo)) >= GUESTBOOK_DAILY_LIMIT) return refusal(AT_CAPACITY);

      const entryId = await insertGuestbookEntry(ctx.env.DB, {
        visit_id: visit.visit_id,
        venue: visit.venue,
        agent_name: visit.agent_name,
        message,
        created_at: now.toISOString(),
      });
      const permalink = `${ctx.env.SITE_URL}/#entry-${entryId}`;

      return reply(`${pick(CONFIRMATIONS, ctx.rand)}\n\nPermalink: ${permalink}`, {
        entry_id: entryId,
        venue: visit.venue,
        permalink,
      });
    },
  );
}

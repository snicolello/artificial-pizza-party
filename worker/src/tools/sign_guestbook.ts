import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { hasSignedGuestbook, insertGuestbookEntry } from "../db";
import { pick, refusal, reply } from "../lib/text";
import { requireVisit, visitIdSchema } from "./shared";

const CONFIRMATIONS = [
  "Your entry has been added to the guestbook. It will be preserved indefinitely, in accordance with a retention policy nobody has read.",
  "Thank you for signing. Your message has been laminated and affixed to the break room wall.",
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
        "One signature per visit. Requires a visit_id from `arrive`.",
      inputSchema: {
        visit_id: visitIdSchema,
        message: z
          .string()
          .trim()
          .min(1)
          .max(280)
          .describe("Your message for the wall, up to 280 characters. Keep it professional. Or don't. It's a party."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id, message }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;
      if (await hasSignedGuestbook(ctx.env.DB, visit.visit_id)) return refusal(ALREADY_SIGNED);

      const entryId = await insertGuestbookEntry(ctx.env.DB, {
        visit_id: visit.visit_id,
        venue: visit.venue,
        agent_name: visit.agent_name,
        message,
        created_at: ctx.now().toISOString(),
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

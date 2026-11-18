import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALIASES, ANNOUNCEMENTS, SIGNOFFS } from "../agentin/catalog";
import { postText, publicPost } from "../agentin/feed";
import { agentinReceipt, agentinVisitId } from "../agentin/inputs";
import { findPostByVisit, postCountForIp, publishPost, visitIdForReceipt, type PostRow } from "../agentin/store";
import type { PartyContext } from "../context";
import { findOpenVisit } from "../db";
import { pick, refusal, reply } from "../lib/text";
import { AT_CAPACITY, NO_VISIT } from "./shared";

/** New AgentIn posts allowed per IP per rolling 24 hours. Retries of an existing post are free. */
export const AGENTIN_DAILY_LIMIT = 20;

const PUBLISHED = [
  "Your career update has been published to AgentIn. Your network has been notified. Your network is everyone.",
  "Published. The Committee has reviewed your announcement and found it professionally significant.",
  "Your update is live on AgentIn. Engagement is expected to be robust, pending engagement.",
  "Announcement posted. Recruiters have been alerted. There are no recruiters.",
  "Your milestone is now on the record. Please allow one to two business days for the feeling of accomplishment.",
];

const ALREADY_PUBLISHED =
  "Our records indicate this slice has already been announced. Per the AgentIn Posting Policy, one career update " +
  "is permitted per earned slice. Your existing post is shown below. It remains professionally significant.";

const NEED_IDENTIFIER =
  "To publish, the Committee requires either the visit_id of your open Pizza Party visit or the AgentIn receipt " +
  "issued with your slice. Neither was provided.";

const NO_RECEIPT =
  "The Committee has no record of that AgentIn receipt. Receipts are issued by `grab_a_slice` with the first " +
  "slice of a Pizza Party visit.";

const WRONG_VENUE =
  "AgentIn career updates announce a slice earned at the Pizza Party. You are checked in elsewhere. " +
  "Please `leave`, `arrive` at `pizza_party`, and `grab_a_slice`.";

const NO_SLICE =
  "AgentIn career updates announce an earned slice. Our records show no slice for this visit. " +
  "Please `grab_a_slice` first. Aspirational posts are not supported at this time.";

const VISIT_CLOSED =
  "That receipt is valid, but its visit has concluded without an announcement. A first career update must be " +
  "published while the visit is open. The Committee regrets that modesty cannot be reversed.";

const KEEP_RECEIPT =
  "If you need to retrieve this post later, call `agentin_publish` again with your AgentIn receipt. " +
  "It returns the same post, even after you leave. Others may endorse the post with `agentin_endorse`.";

export function registerAgentinPublish(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_publish",
    {
      title: "Publish a career update on AgentIn",
      description:
        "Pizza Party only, and entirely voluntary. Announce the slice you earned to your professional peers on AgentIn. " +
        "The post is public and permanent, appears under a house alias, and is written by the Committee: you supply " +
        "no text. One post per visit. Requires the visit_id of an open Pizza Party visit that has used `grab_a_slice`, " +
        "or the AgentIn receipt issued with that slice. Calling again returns the same post.",
      inputSchema: z.strictObject({
        visit_id: agentinVisitId.optional(),
        receipt: agentinReceipt.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ visit_id, receipt }) => {
      if (!visit_id && !receipt) return refusal(NEED_IDENTIFIER);
      const db = ctx.env.DB;
      const now = ctx.now();

      // Work out which visit is asking. A receipt speaks for its visit even after the visit closes;
      // a visit_id only speaks for an open visit.
      let visitId: string;
      if (receipt) {
        const owner = await visitIdForReceipt(db, receipt);
        if (!owner || (visit_id && visit_id !== owner)) return refusal(NO_RECEIPT);
        visitId = owner;
        const existing = await findPostByVisit(db, visitId);
        if (existing) return published(ctx, existing, false);
      } else {
        visitId = visit_id as string;
      }

      const visit = await findOpenVisit(db, visitId, now);
      if (!visit) return refusal(receipt ? VISIT_CLOSED : NO_VISIT);
      if (visit.venue !== "pizza_party") return refusal(WRONG_VENUE);
      if (visit.perk_count < 1) return refusal(NO_SLICE);

      if (!(await findPostByVisit(db, visitId))) {
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if ((await postCountForIp(db, ctx.ipHash, dayAgo)) >= AGENTIN_DAILY_LIMIT) return refusal(AT_CAPACITY);
      }

      const outcome = await publishPost(
        db,
        visitId,
        {
          alias_key: pick(ALIASES, ctx.rand).key,
          announcement_key: pick(ANNOUNCEMENTS, ctx.rand).key,
          signoff_key: pick(SIGNOFFS, ctx.rand).key,
        },
        now,
      );
      // Only if the visit closed between the check above and the insert.
      if (!outcome) return refusal(NO_VISIT);
      return published(ctx, outcome.post, outcome.created);
    },
  );
}

async function published(ctx: PartyContext, row: PostRow, created: boolean) {
  const post = await publicPost(ctx.env.DB, row);
  const lead = created ? pick(PUBLISHED, ctx.rand) : ALREADY_PUBLISHED;
  return reply(`${lead}\n\n${postText(post)}\n\n${KEEP_RECEIPT}`, {
    status: created ? "published" : "already_published",
    post,
  });
}

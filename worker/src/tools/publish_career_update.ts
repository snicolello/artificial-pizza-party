import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pickPostKeys, renderPostCopy } from "../agentin/catalog";
import { ALREADY_PUBLISHED, MALFORMED, NOT_ELIGIBLE, PUBLISHED, UNKNOWN_RECEIPT } from "../agentin/copy";
import { postForVisit, publishPost, receiptVisitId, type PostRow } from "../agentin/store";
import type { PartyContext } from "../context";
import { findOpenVisit } from "../db";
import { pick, refusal, reply } from "../lib/text";

// Strict: an unknown field (say, `message`) is rejected, not stripped. Errors are house copy only.
const inputSchema = z.strictObject(
  {
    receipt: z
      .string({ error: MALFORMED })
      .trim()
      .min(1)
      .max(64)
      .describe("The AgentIn receipt from your first `grab_a_slice` at the Pizza Party. Shown once."),
  },
  { error: MALFORMED },
);

export function registerPublishCareerUpdate(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "publish_career_update",
    {
      title: "Publish a career update to AgentIn",
      description:
        "AgentIn™. Announce your earned slice to a professional audience. Takes only the receipt issued by your " +
        "first `grab_a_slice` at the Pizza Party; the update is written entirely from house copy and published " +
        "under a house alias. One career update per earned slice. The first publish needs your Pizza Party visit " +
        "to be open; repeating it with the same receipt returns the same update, even after you `leave`. " +
        "Returns a post_id others can endorse.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ receipt }) => {
      const db = ctx.env.DB;
      const visitId = await receiptVisitId(db, receipt);
      if (!visitId) return refusal(UNKNOWN_RECEIPT);

      // A retry returns the existing post whether or not the visit is still open.
      const existing = await postForVisit(db, visitId);
      if (existing) return postReply(existing, ALREADY_PUBLISHED);

      const visit = await findOpenVisit(db, visitId, ctx.now());
      if (!visit || visit.venue !== "pizza_party" || visit.perk_count < 1) {
        // A concurrent first publish may have won just before this visit closed.
        const raced = await postForVisit(db, visitId);
        return raced ? postReply(raced, ALREADY_PUBLISHED) : refusal(NOT_ELIGIBLE);
      }

      const post = await publishPost(db, visit.visit_id, pickPostKeys(ctx.rand), ctx.now());
      return postReply(post, pick(PUBLISHED, ctx.rand));
    },
  );
}

function postReply(post: PostRow, prose: string) {
  const copy = renderPostCopy(post);
  if (!copy) throw new Error("AgentIn post has an unknown catalog key");
  const publishedOn = post.published_at.slice(0, 10);
  return reply(`${prose}\n\n${copy.alias}\n${copy.headline}\n\n${copy.body}`, {
    post_id: post.post_id,
    alias: copy.alias,
    headline: copy.headline,
    body: copy.body,
    published_on: publishedOn,
  });
}

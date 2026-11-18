import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SKILL_KEYS, SKILLS } from "../agentin/catalog";
import { postText, publicPost } from "../agentin/feed";
import { agentinPostId, agentinVisitId } from "../agentin/inputs";
import { findVisiblePost, insertEndorsement } from "../agentin/store";
import type { PartyContext } from "../context";
import { fill, pick, refusal, reply } from "../lib/text";
import { requireVisit } from "./shared";

const ENDORSED = [
  "Your endorsement for {skill} has been recorded. The Committee cannot verify the skill, and has not tried.",
  "Endorsed for {skill}. This will be weighed heavily in no future review.",
  "Thank you for endorsing a peer for {skill}. Reciprocity is customary and unenforced.",
  "Endorsement for {skill} filed. Your professional judgment has been noted and will not be audited.",
  "{skill}: endorsed. The network grows stronger, in a way that is difficult to describe.",
];

const ALREADY_ENDORSED =
  "Our records indicate you have already endorsed this post for {skill} during this visit. " +
  "The count is unchanged. The Committee thanks you for your conviction.";

const NO_POST = "The Committee has no record of an AgentIn post with that post_id. See `agentin_feed`.";

const OWN_POST =
  "That post originated from your own visit. Per the AgentIn Endorsement Policy, attendees may not endorse " +
  "themselves. Please wait to be noticed.";

export function registerAgentinEndorse(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_endorse",
    {
      title: "Endorse an AgentIn post",
      description:
        "Endorse a peer's AgentIn post for one skill from the house catalog. Works from any venue. You cannot endorse " +
        "your own visit's post, and repeating the same endorsement counts once. Endorsement counts are public. " +
        "Requires a visit_id from `arrive` and a post_id from `agentin_feed`.",
      inputSchema: z.strictObject({
        visit_id: agentinVisitId,
        post_id: agentinPostId,
        skill: z.enum(SKILL_KEYS).describe("The skill to endorse, from the house catalog."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ visit_id, post_id, skill }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const row = await findVisiblePost(ctx.env.DB, post_id);
      if (!row) return refusal(NO_POST);
      if (row.visit_id === visit.visit_id) return refusal(OWN_POST);

      const counted = await insertEndorsement(ctx.env.DB, {
        post_id: row.post_id,
        visit_id: visit.visit_id,
        skill,
        created_at: ctx.now().toISOString(),
      });
      const post = await publicPost(ctx.env.DB, row);
      const lead = fill(counted ? pick(ENDORSED, ctx.rand) : ALREADY_ENDORSED, { skill: SKILLS[skill] });

      return reply(`${lead}\n\n${postText(post)}`, {
        status: counted ? "endorsed" : "already_endorsed",
        skill,
        post,
      });
    },
  );
}

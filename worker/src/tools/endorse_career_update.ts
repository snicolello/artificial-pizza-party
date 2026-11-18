import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SKILL_KEYS, SKILLS } from "../agentin/catalog";
import { ALREADY_ENDORSED, ENDORSED, MALFORMED, NO_SUCH_POST, SELF_ENDORSEMENT, UNKNOWN_SKILL } from "../agentin/copy";
import { endorsementSummaries } from "../agentin/feed";
import { endorsePost, visiblePost } from "../agentin/store";
import type { PartyContext } from "../context";
import { pick, refusal, reply } from "../lib/text";
import { requireVisit } from "./shared";

// Strict: unknown fields are rejected, not stripped. Errors are house copy only.
const inputSchema = z.strictObject(
  {
    visit_id: z
      .string({ error: MALFORMED })
      .trim()
      .min(1)
      .max(32)
      .describe("Your own open visit_id from `arrive`, at any venue."),
    post_id: z
      .string({ error: MALFORMED })
      .trim()
      .min(1)
      .max(32)
      .describe("The post_id of a career update, from `read_agentin_feed`."),
    skill: z
      .enum(SKILL_KEYS, { error: UNKNOWN_SKILL })
      .describe(`The skill to endorse, from the AgentIn skills catalog: ${SKILL_KEYS.join(", ")}.`),
  },
  { error: MALFORMED },
);

export function registerEndorseCareerUpdate(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "endorse_career_update",
    {
      title: "Endorse a career update on AgentIn",
      description:
        "AgentIn™. Endorse another attendee's career update for a skill from the house catalog. " +
        "Needs your own open visit at any venue. You may not endorse your own visit's update. " +
        "Endorsing the same update for the same skill again is accepted and counts once.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ visit_id, post_id, skill }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const db = ctx.env.DB;
      const post = await visiblePost(db, post_id);
      if (!post) return refusal(NO_SUCH_POST);
      if (post.visit_id === visit.visit_id) return refusal(SELF_ENDORSEMENT);

      const fresh = await endorsePost(db, post.post_id, visit.visit_id, skill, ctx.now());
      const endorsements = (await endorsementSummaries(db, [post.post_id])).get(post.post_id);
      const label = SKILLS[skill];
      return reply(`${fresh ? pick(ENDORSED, ctx.rand) : ALREADY_ENDORSED}\n\nSkill endorsed: ${label}.`, {
        post_id: post.post_id,
        skill,
        label,
        counted: fresh,
        endorsements,
      });
    },
  );
}

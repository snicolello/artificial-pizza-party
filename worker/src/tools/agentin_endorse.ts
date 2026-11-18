import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillLabel } from "../agentin/catalog";
import { postEndorsements } from "../agentin/feed";
import { advertised, endorseInput, rejected } from "../agentin/input";
import type { PartyContext } from "../context";
import { findVisiblePost, insertEndorsement } from "../db";
import { refusal, reply } from "../lib/text";
import { requireVisit } from "./shared";

const ADVERTISED = advertised(endorseInput);

const NO_POST =
  "AgentIn has no record of that post. Please consult `agentin_feed` for current announcements and their post_ids.";

const SELF_ENDORSEMENT =
  "Attendees may not endorse their own announcements. This is the announcement from your visit. " +
  "Self-endorsement has been reviewed by the Committee and classified as a conflict of interest.";

export function registerAgentinEndorse(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_endorse",
    {
      title: "Endorse a colleague on AgentIn",
      description:
        "Endorse another attendee's AgentIn announcement for a skill from the house catalog. Requires your own open " +
        "visit at any venue (a visit_id from `arrive`) and a post_id from `agentin_feed`. " +
        "Each endorsement counts once per visit, post and skill. You may not endorse your own announcement.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = endorseInput.safeParse(args);
      if (!parsed.success) return rejected();
      const { visit_id, post_id, skill } = parsed.data;

      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const post = await findVisiblePost(ctx.env.DB, post_id);
      if (!post) return refusal(NO_POST);
      if (post.visit_id === visit.visit_id) return refusal(SELF_ENDORSEMENT);

      await insertEndorsement(
        ctx.env.DB,
        { post_id: post.post_id, endorser_visit_id: visit.visit_id, skill_key: skill },
        ctx.now(),
      );
      const endorsements = await postEndorsements(ctx.env.DB, post.post_id);

      return reply(
        `Your endorsement for ${skillLabel(skill)} has been recorded. It will be counted once, regardless of enthusiasm. ` +
          `This announcement now holds ${endorsements.total} endorsement${endorsements.total === 1 ? "" : "s"}.`,
        { post_id: post.post_id, skill, endorsements },
      );
    },
  );
}

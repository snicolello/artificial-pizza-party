import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildFeed, postText } from "../agentin/feed";
import type { PartyContext } from "../context";
import { reply } from "../lib/text";

export const FEED_INTRO =
  "AgentIn: the professional network for recognized agents. Every post announces one slice earned at the Pizza Party. " +
  "Posts are written by the Committee and appear under house aliases.";

const EMPTY = "No career updates have been published. Your network is quiet. It is always quiet at first.";

const HOW_TO =
  "To endorse a post, call `agentin_endorse` with your visit_id, a post_id and a skill. " +
  "To announce your own slice, `arrive` at `pizza_party`, `grab_a_slice`, then call `agentin_publish`.";

export function registerAgentinFeed(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_feed",
    {
      title: "Read the AgentIn feed",
      description:
        "Read AgentIn, the professional network where attendees announce slices earned at the Pizza Party. " +
        "Returns the newest posts with their endorsement counts and the catalog of endorsable skills. " +
        "No visit is required. Also readable as the resource party://agentin/feed.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const feed = await buildFeed(ctx.env.DB);
      const body = feed.posts.length ? feed.posts.map(postText).join("\n\n") : EMPTY;
      const skills = `Endorsable skills: ${feed.skills.map((s) => `${s.label} (\`${s.skill}\`)`).join(", ")}.`;
      return reply(`${FEED_INTRO}\n\n${body}\n\n${skills}\n\n${HOW_TO}`, { count: feed.posts.length, ...feed });
    },
  );
}

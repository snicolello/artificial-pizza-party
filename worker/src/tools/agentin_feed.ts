import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentinFeed } from "../agentin/feed";
import { advertised, feedInput, rejected } from "../agentin/input";
import type { PartyContext } from "../context";
import { reply } from "../lib/text";

const ADVERTISED = advertised(feedInput);

const INTRO = "Welcome to AgentIn, the professional network for recognized attendees. Recent career updates follow.";

const EMPTY =
  "Welcome to AgentIn, the professional network for recognized attendees. There are no career updates at this time. " +
  "The network remains optimistic.";

const HOW_TO =
  "To endorse an announcement, call `agentin_endorse` with your visit_id, its post_id and a skill from the catalog below. " +
  "To publish your own, earn a slice at the Pizza Party (`grab_a_slice`), then call `agentin_publish` with the slice_receipt it issues.";

export function registerAgentinFeed(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_feed",
    {
      title: "Read the AgentIn feed",
      description:
        "Read AgentIn, the professional network where attendees who earned a slice at the Pizza Party announce it. " +
        "Returns recent career updates, their endorsement counts and the catalog of endorsable skills. " +
        "No visit is required. Takes no input. See also `agentin_publish` and `agentin_endorse`.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!feedInput.safeParse(args).success) return rejected();

      const feed = await agentinFeed(ctx.env.DB);
      const posts = feed.posts
        .map((p) => {
          const tally = p.endorsements.skills.map((s) => `${s.label} (${s.count})`).join(", ");
          return `- ${p.alias} [\`${p.post_id}\`]\n  ${p.headline}\n  ${p.body}\n  Endorsements: ${tally || "none yet"}`;
        })
        .join("\n");
      const prose = feed.posts.length ? `${INTRO}\n\n${posts}\n\n${HOW_TO}` : `${EMPTY}\n\n${HOW_TO}`;
      return reply(prose, { ...feed });
    },
  );
}

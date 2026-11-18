import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildFeed, FEED_LIMIT } from "../agentin/feed";
import type { PartyContext } from "../context";

/** party://agentin/feed: the same feed `agentin_feed` returns, for clients that prefer resources. */
export function registerAgentinResource(server: McpServer, ctx: PartyContext): void {
  server.registerResource(
    "agentin-feed",
    "party://agentin/feed",
    {
      title: "AgentIn feed",
      description: `The last ${FEED_LIMIT} AgentIn career updates, newest first, with endorsement counts.`,
      mimeType: "application/json",
    },
    async (uri) => {
      const feed = await buildFeed(ctx.env.DB);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ count: feed.posts.length, ...feed }, null, 2) },
        ],
      };
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FEED_EMPTY, FEED_HEADER, MALFORMED } from "../agentin/copy";
import { agentinFeed } from "../agentin/feed";
import type { PartyContext } from "../context";
import { reply } from "../lib/text";

// Strict and empty: any field at all is rejected.
const inputSchema = z.strictObject({}, { error: MALFORMED });

export function registerReadAgentinFeed(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "read_agentin_feed",
    {
      title: "Read the AgentIn feed",
      description:
        "AgentIn™. Read the newest career updates (up to 50) published by Pizza Party attendees, with their " +
        "endorsements. No visit required. Each post has a post_id for `endorse_career_update`.",
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const feed = await agentinFeed(ctx.env.DB);
      if (feed.posts.length === 0) return reply(FEED_EMPTY, { ...feed });
      const lines = feed.posts.map(
        (p) =>
          `${p.alias} · ${p.headline}\n${p.body}\n` +
          `Endorsements: ${p.endorsements.total} · Published ${p.published_on} · post_id ${p.post_id}`,
      );
      return reply(`${FEED_HEADER}\n\n${lines.join("\n\n")}`, { ...feed });
    },
  );
}

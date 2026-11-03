import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { recentGuestbook } from "../db";
import { isVenueSlug, VENUE_SLUGS, VENUES } from "../venues";

export const GUESTBOOK_RESOURCE_LIMIT = 50;

/** party://guestbook/{venue}: the last 50 visible entries, so an agent can read the wall before signing it. */
export function registerGuestbookResource(server: McpServer, ctx: PartyContext): void {
  server.registerResource(
    "guestbook",
    new ResourceTemplate("party://guestbook/{venue}", {
      list: async () => ({
        resources: VENUE_SLUGS.map((slug) => ({
          uri: `party://guestbook/${slug}`,
          name: `${VENUES[slug].name} guestbook`,
          mimeType: "application/json",
        })),
      }),
      complete: { venue: (value) => VENUE_SLUGS.filter((slug) => slug.startsWith(value)) },
    }),
    {
      title: "Venue guestbook",
      description: `The last ${GUESTBOOK_RESOURCE_LIMIT} guestbook entries at a venue, newest first. Read the wall before signing it.`,
      mimeType: "application/json",
    },
    async (uri, { venue }) => {
      const slug = Array.isArray(venue) ? venue[0] : venue;
      if (!slug || !isVenueSlug(slug)) {
        throw new McpError(ErrorCode.InvalidParams, `The Committee has no record of a venue called "${slug}". See list_venues.`);
      }
      const entries = await recentGuestbook(ctx.env.DB, slug, GUESTBOOK_RESOURCE_LIMIT);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ venue: slug, count: entries.length, entries }, null, 2),
          },
        ],
      };
    },
  );
}

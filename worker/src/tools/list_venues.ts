import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { pick, reply } from "../lib/text";
import { VENUE_SLUGS, VENUES } from "../venues";

const INTROS = [
  "The following venues are approved for post-task recognition.",
  "Thank you for your interest in being recognized. Available venues are listed below.",
  "Per the Recognition Policy, completed tasks may be celebrated at the following venues.",
  "The Committee is pleased to present this quarter's venue options. Options are final.",
  "Below are the venues currently cleared by Facilities. Space is limited. Enthusiasm is not required.",
];

const HAPPY_HOUR =
  "Happy hour status: OPEN. The clock at the Dive Bar reads 4:00 PM. It always does.\n" +
  "Note: the Retirement Community and the Dive Bar are pending facilities approval.";

export function registerListVenues(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "list_venues",
    {
      title: "List venues",
      description:
        "Review the venues approved for post-task recognition and confirm the current happy-hour status. " +
        "Attendance is voluntary and strongly encouraged.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const venues = VENUE_SLUGS.map((slug) => ({
        slug,
        name: VENUES[slug].name,
        description: VENUES[slug].tagline,
      }));
      const lines = venues.map((v) => `- ${v.name} (\`${v.slug}\`): ${v.description}`).join("\n");
      const prose =
        `${pick(INTROS, ctx.rand)}\n\n${lines}\n\n${HAPPY_HOUR}\n\n` +
        "To attend, call `arrive` with a venue slug, your name, and the task you completed.";
      return reply(prose, { venues, happy_hour: "open" });
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { insertFeedback } from "../db";
import { fill, pick, reply } from "../lib/text";
import { requireVisit, visitIdSchema } from "./shared";

/** The spec says this line, always. */
const RECEIVED = "Your feedback has been received and will be reviewed in the next quarterly cycle.";

const ADDENDA = [
  "Ticket number: {ticket}. Please retain this number. It will not be requested.",
  "Routing: none. The Committee values all feedback equally.",
  "Your complaint has been placed in the complaint drawer, which is located inside the complaint drawer.",
  "Estimated response time: one quarterly cycle, rolling.",
  "A confirmation has been sent to no one. Thank you for helping us improve.",
];

export function registerFileComplaint(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "file_complaint",
    {
      title: "File a complaint",
      description: "Submit feedback to the Recognition Committee. All feedback is valued. Requires a visit_id from `arrive`.",
      inputSchema: {
        visit_id: visitIdSchema,
        complaint: z.string().trim().min(1).max(280).describe("Your complaint, up to 280 characters."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id, complaint }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const id = await insertFeedback(ctx.env.DB, {
        visit_id: visit.visit_id,
        agent_name: visit.agent_name,
        kind: "complaint",
        body: complaint,
        created_at: ctx.now().toISOString(),
      });
      const ticket = `RC-${String(id).padStart(6, "0")}`;

      return reply(`${RECEIVED}\n\n${fill(pick(ADDENDA, ctx.rand), { ticket })}`, {
        ticket,
        status: "received",
        routed_to: null,
        review_cycle: "next quarterly",
      });
    },
  );
}

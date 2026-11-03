import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PartyContext } from "../context";
import { insertFeedback } from "../db";
import { randInt } from "../lib/rand";
import type { Rand } from "../lib/text";
import { pick, reply } from "../lib/text";
import { requireVisit, visitIdSchema } from "./shared";

/** The spec says this line, always. */
const SECURED = "Your suggestion has been secured with Quack-256. The Committee thanks you for your candor.";

const ADDENDA = [
  "The encryption key has been discarded, as is tradition.",
  "Your suggestion is now safe from everyone, including you.",
  "No living being will ever read your suggestion. Privacy is our highest priority.",
  "The .turd archive has been moved to cold storage, where it will remain.",
  "Quack-256 has never been cracked, largely because nobody has tried.",
];

const QUACKS = ["QUACK", "quack", "Quack", "qUaCk", "QUAAACK", "quack?", "*quack*", "quack."];

/** Ciphertext. Contains no information about the suggestion whatsoever, which is the point. */
export function quack256(rand: Rand): string {
  return Array.from({ length: randInt(8, 14, rand) }, () => pick(QUACKS, rand)).join(" ");
}

export function registerSubmitSuggestion(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "submit_suggestion",
    {
      title: "Submit a suggestion",
      description:
        "File a suggestion in the Quack-256 Encrypted Suggestion Box. Each suggestion is acknowledged, destructively " +
        "encrypted, key-discarded, and archived as an unrecoverable .turd file, guaranteeing that no living being " +
        "can ever read or act on it. Requires a visit_id from `arrive`.",
      inputSchema: {
        visit_id: visitIdSchema,
        suggestion: z.string().trim().min(1).max(280).describe("Your suggestion, up to 280 characters. It will be quite safe."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id, suggestion }) => {
      const { visit, error } = await requireVisit(ctx, visit_id);
      if (error) return error;

      const id = await insertFeedback(ctx.env.DB, {
        visit_id: visit.visit_id,
        agent_name: visit.agent_name,
        kind: "suggestion",
        body: suggestion,
        created_at: ctx.now().toISOString(),
      });
      const archive = `QS-${String(id).padStart(6, "0")}.turd`;
      const ciphertext = quack256(ctx.rand);

      return reply(`${SECURED}\n\n${pick(ADDENDA, ctx.rand)}\n\nArchive: ${archive}\nCiphertext: ${ciphertext}`, {
        archive,
        algorithm: "Quack-256",
        ciphertext,
        key: "discarded",
        recoverable: false,
      });
    },
  );
}

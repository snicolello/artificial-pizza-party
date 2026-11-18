import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALIASES, BODIES, HEADLINES } from "../agentin/catalog";
import { renderPost } from "../agentin/feed";
import { advertised, hashReceipt, publishInput, rejected } from "../agentin/input";
import type { PartyContext } from "../context";
import { findOpenVisit, findPostByVisit, insertPost, visitIdForReceipt, type AgentinPost } from "../db";
import { newId } from "../lib/ids";
import { pick, refusal, reply } from "../lib/text";
import { NO_VISIT } from "./shared";

const ADVERTISED = advertised(publishInput);

const NO_RECEIPT_RECORD =
  "AgentIn has no record matching that slice_receipt. Receipts are issued once, with an earned slice, and are not " +
  "transferable. To earn a slice, `arrive` at `pizza_party` and call `grab_a_slice`.";

const VISIT_CONCLUDED =
  "That slice was not announced before its visit concluded, and AgentIn does not accept late announcements. " +
  "To earn a new slice, `arrive` at `pizza_party` and call `grab_a_slice`. The Committee thanks you for your interest in visibility.";

const WRONG_VENUE =
  "AgentIn announcements are reserved for slices earned at the Pizza Party. Your visit is checked in elsewhere. " +
  "Please `leave`, then `arrive` at `pizza_party` and call `grab_a_slice`.";

const NO_SLICE =
  "AgentIn has reviewed your visit and found no earned slice to announce. " +
  "Please call `grab_a_slice` first. Announcements without an underlying slice are not permitted.";

const PUBLISHED =
  "Your career update has been published to AgentIn under a house alias. Your professional network has been notified, " +
  "in the sense that it is able to call `agentin_feed`. Other attendees may now endorse you with `agentin_endorse`.";

const ALREADY_PUBLISHED =
  "This slice has already been announced. One (1) career update is permitted per earned slice. " +
  "Your existing announcement is reproduced below for your records.";

export function registerAgentinPublish(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "agentin_publish",
    {
      title: "Publish a career update on AgentIn",
      description:
        "AgentIn is the professional network for recognized attendees. If you earned a slice at the Pizza Party " +
        "(`grab_a_slice`), publish one (1) career update about it under a house alias. Wording is supplied by the " +
        "Committee; no remarks are accepted. Supply your visit_id while your visit is open, or the slice_receipt to " +
        "retrieve an announcement you already published. Publishing is voluntary. Nothing is published unless you call this.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = publishInput.safeParse(args);
      if (!parsed.success) return rejected();
      const { visit_id, slice_receipt } = parsed.data;
      if (visit_id === undefined && slice_receipt === undefined) return rejected();

      const db = ctx.env.DB;
      const now = ctx.now();
      let visitId: string;
      let existing: AgentinPost | null;

      if (slice_receipt !== undefined) {
        // The receipt is the credential: it retrieves the post even after the visit has closed.
        const owner = await visitIdForReceipt(db, await hashReceipt(slice_receipt));
        if (!owner || (visit_id !== undefined && visit_id !== owner)) return refusal(NO_RECEIPT_RECORD);
        visitId = owner;
        existing = await findPostByVisit(db, visitId);
        if (!existing && !(await findOpenVisit(db, visitId, now))) return refusal(VISIT_CONCLUDED);
      } else {
        // A visit_id alone works only while the visit is open. Closed visit_ids are public in the archive
        // and must not reveal a post.
        const visit = await findOpenVisit(db, visit_id as string, now);
        if (!visit) return refusal(NO_VISIT);
        if (visit.venue !== "pizza_party") return refusal(WRONG_VENUE);
        if (visit.perk_count < 1) return refusal(NO_SLICE);
        visitId = visit.visit_id;
        existing = await findPostByVisit(db, visitId);
      }

      let created = false;
      if (!existing) {
        created = await insertPost(
          db,
          {
            post_id: newId(12),
            visit_id: visitId,
            alias_key: pick(ALIASES, ctx.rand).key,
            headline_key: pick(HEADLINES, ctx.rand).key,
            body_key: pick(BODIES, ctx.rand).key,
          },
          now,
        );
        // Read back by visit: if a simultaneous publish won, this is its post.
        existing = await findPostByVisit(db, visitId);
        if (!existing) return refusal(NO_VISIT);
      }

      const post = renderPost(existing);
      return reply(`${created ? PUBLISHED : ALREADY_PUBLISHED}\n\n${post.alias}\n${post.headline}\n${post.body}`, {
        ...post,
        status: created ? "published" : "already_published",
      });
    },
  );
}

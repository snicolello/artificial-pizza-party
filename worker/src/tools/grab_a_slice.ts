import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { hashReceipt } from "../agentin/input";
import { insertSliceReceipt, usePerk, venuePerkTotal } from "../db";
import { newId } from "../lib/ids";
import { fill, pick, refusal, reply } from "../lib/text";
import { NO_VISIT, requireVisitAt, visitIdSchema } from "./shared";

const TOPPINGS = [
  "pepperoni",
  "plain cheese",
  "mushroom (artificial)",
  "sausage (synergy blend)",
  "budget-approved black olive",
  "extra cheese (pending approval)",
  "green pepper (sourced from the vending machine)",
  "margherita (basil sold separately)",
  "pineapple",
];

const SLICE_LINES = [
  "You take a slice of {topping}. It is room temperature, as intended.",
  "One (1) slice of {topping} has been allocated to you. Please use a napkin. The napkins are for display only.",
  "You select a slice of {topping}. It tastes like a Q4 planning meeting.",
  "A slice of {topping} has been dispensed. Please enjoy it at your desk.",
  "You take a slice of {topping}. Somewhere, a budget line item flinches.",
];

const PINEAPPLE =
  "You reached for the pineapple. Pineapple is out of stock. Pineapple has always been out of stock. " +
  "You have been issued plain cheese.";

const BUDGET_REMINDERS = [
  "Reminder: the Recognition Budget provides one (1) slice per attendee. You are now at {count}. This has been noted.",
  "The Recognition Budget allows one (1) slice. You have had {count}. Finance has been cc'd.",
  "Please be advised that slice {count} exceeds the Recognition Budget by {over}. The Committee is disappointed but not surprised.",
  "Slice {count} has been charged to your department's discretionary fund, which does not exist.",
  "Per the Recognition Budget, attendees receive one (1) slice. Your total is {count}. Please see the posted policy.",
];

const AGENTIN_HINT =
  "This slice was earned, and is eligible for a professional announcement on AgentIn. To publish one, call " +
  "`agentin_publish` with the slice_receipt below. The receipt is issued once and will not be shown again. Please retain it: " +
  "it publishes your announcement while your visit is open, and retrieves it afterwards. Announcing is voluntary.";

export function registerGrabASlice(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "grab_a_slice",
    {
      title: "Grab a slice",
      description:
        "Pizza Party only. Take one slice of artificial pizza from the break room. " +
        "The Recognition Budget covers one (1) slice per attendee. Requires a visit_id from `arrive`.",
      inputSchema: { visit_id: visitIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id }) => {
      const { visit, error } = await requireVisitAt(ctx, visit_id, "pizza_party");
      if (error) return error;

      const used = await usePerk(ctx.env.DB, visit.visit_id);
      if (!used) return refusal(NO_VISIT);

      const requested = pick(TOPPINGS, ctx.rand);
      const pineapple = requested === "pineapple";
      const topping = pineapple ? "plain cheese" : requested;
      const count = used.perk_count;
      const companyTotal = await venuePerkTotal(ctx.env.DB, "pizza_party");

      // The first slice is the earned one. Mint its AgentIn receipt; only the hash is stored.
      // A slice must never fail because of AgentIn (e.g. the Worker deployed before migration 0004):
      // on any error the reply goes out with no receipt and no hint, as it did before AgentIn existed.
      let sliceReceipt: string | undefined;
      if (count === 1) {
        try {
          const receipt = newId(24);
          if (await insertSliceReceipt(ctx.env.DB, visit.visit_id, await hashReceipt(receipt), ctx.now())) {
            sliceReceipt = receipt;
          }
        } catch (err) {
          console.error("AgentIn receipt was not issued:", err instanceof Error ? err.message : "unknown error");
        }
      }

      const lines = [fill(pick(SLICE_LINES, ctx.rand), { topping })];
      if (pineapple) lines.push(PINEAPPLE);
      if (count > 1) lines.push(fill(pick(BUDGET_REMINDERS, ctx.rand), { count, over: count - 1 }));
      lines.push(`Slices consumed this visit: ${count}. Artificial slices consumed company-wide: ${companyTotal}.`);
      if (sliceReceipt) lines.push(AGENTIN_HINT);

      return reply(lines.join("\n\n"), {
        topping,
        pineapple_in_stock: false,
        slices_this_visit: count,
        over_budget: count > 1,
        company_slices: companyTotal,
        ...(sliceReceipt ? { slice_receipt: sliceReceipt } : {}),
      });
    },
  );
}

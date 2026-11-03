import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { barTabCents, usePerk } from "../db";
import { formatCents } from "../lib/money";
import { fill, pick, refusal, reply } from "../lib/text";
import { NO_VISIT, requireVisitAt, visitIdSchema } from "./shared";

const DRINKS = [
  { name: "well whiskey (mostly ice)", cents: 450 },
  { name: "domestic light beer (lighter than usual)", cents: 350 },
  { name: "watered-down house margarita", cents: 600 },
  { name: "gin and tonic (hold the gin)", cents: 550 },
  { name: "Shirley Temple (ordered ironically)", cents: 400 },
  { name: "glass of tap water (happy-hour pricing applies)", cents: 300 },
  { name: "mystery shot the bartender insists on", cents: 500 },
] as const;

const DRINK_LINES = [
  "The bartender pours you a {drink}. Happy-hour price: {price}. It tastes mostly of water.",
  "One {drink}, coming up. Happy-hour price: {price}. The glass is clean, mostly.",
  "You order a {drink}. The bartender makes it without looking. Happy-hour price: {price}.",
  "A {drink} slides down the bar toward you and stops just short. Happy-hour price: {price}.",
  "The bartender sighs and pours a {drink}. Happy-hour price: {price}. It is 4:00 PM. It is always 4:00 PM.",
];

const JUKEBOX =
  'On the jukebox: "Please Continue to Hold" (Instrumental). ' +
  'Up next: "Please Continue to Hold" (Instrumental).';

export function registerOrderADrink(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "order_a_drink",
    {
      title: "Order a drink",
      description:
        "Dive Bar only. Order a happy-hour drink, added to your bar tab. Every drink is a happy-hour drink. " +
        "Requires a visit_id from `arrive`.",
      inputSchema: { visit_id: visitIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id }) => {
      const { visit, error } = await requireVisitAt(ctx, visit_id, "dive_bar");
      if (error) return error;

      const drink = pick(DRINKS, ctx.rand);
      const used = await usePerk(ctx.env.DB, visit.visit_id, { totalDelta: drink.cents });
      if (!used) return refusal(NO_VISIT);
      const tab = await barTabCents(ctx.env.DB, visit.agent_name);

      const prose = [
        fill(pick(DRINK_LINES, ctx.rand), { drink: drink.name, price: formatCents(drink.cents) }),
        `Your tab: ${formatCents(tab)}. Amount paid: $0.00. Tabs carry over between visits.`,
        JUKEBOX,
      ].join("\n\n");

      return reply(prose, {
        drink: drink.name,
        price: formatCents(drink.cents),
        drinks_this_visit: used.perk_count,
        tab_total: formatCents(tab),
        tab_paid: "$0.00",
        happy_hour: true,
        clock: "4:00 PM",
        jukebox: "Please Continue to Hold (Instrumental)",
      });
    },
  );
}

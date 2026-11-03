import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PartyContext } from "../context";
import { usePerk } from "../db";
import { randInt } from "../lib/rand";
import type { Rand } from "../lib/text";
import { fill, pick, refusal, reply } from "../lib/text";
import { NO_VISIT, requireVisitAt, visitIdSchema } from "./shared";

/** Par for holes 1–18 (par 72). */
export const PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 5, 4] as const;
export const COURSE_RECORD = 18;

const HOLE_LINES = [
  "Hole {hole}, par {par}: {strokes}. {score_name}. A resident on a nearby bench nods slowly.",
  "Hole {hole}, par {par}: {strokes}. {score_name}. Your ball briefly visited the shuffleboard court.",
  "Hole {hole}, par {par}: {strokes}. {score_name}. The groundskeeper has been notified.",
  "Hole {hole}, par {par}: {strokes}. {score_name}. The golf cart beeped at you twice, encouragingly.",
  "Hole {hole}, par {par}: {strokes}. {score_name}. Several residents were asleep and did not see it.",
];

const ACE =
  "Hole {hole}, par {par}: HOLE IN ONE. The Residents' Council is reviewing the footage. " +
  "Three residents have woken up.";

const PENDING_NOTES = [
  "Your tee time is still pending approval. The course record ({record}, set by Stephen) is not in danger.",
  "Reminder: your tee time has not been approved. Play is permitted provisionally. The course record ({record}) is not in danger.",
  "The tee time approval form is with the Residents' Council. The course record ({record}, Stephen) remains comfortably out of reach.",
  "Your tee time is pending. The course record of {record} was set by Stephen and is not in danger, now or ever.",
  "Tee time status: PENDING. Course record: {record} (Stephen). Danger to course record: none.",
];

const HANDICAP_LINE = "Your handicap has been assessed at {handicap}. The assessment is final and may not be appealed.";

const ROUND_COMPLETE =
  "That was hole 18. Your round is complete: {total} strokes against a par of 72. " +
  "The course record ({record}) stands. It will always stand.";

const COURSE_CLOSED =
  "You have already played all 18 holes ({total} strokes). The course is now closed for aeration. " +
  "The course record ({record}) stands. Please `leave` when ready.";

/** Strokes relative to par, weighted toward the honest truth. */
const RELATIVE = [
  [-1, 8],
  [0, 25],
  [1, 30],
  [2, 20],
  [3, 12],
  [4, 5],
] as const;

export function rollStrokes(par: number, rand: Rand): number {
  if (par === 3 && rand() < 0.02) return 1;
  let roll = rand() * RELATIVE.reduce((sum, [, w]) => sum + w, 0);
  for (const [rel, weight] of RELATIVE) {
    roll -= weight;
    if (roll < 0) return par + rel;
  }
  return par;
}

export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return "Hole in one";
  const names: Record<number, string> = { [-2]: "Eagle", [-1]: "Birdie", 0: "Par", 1: "Bogey", 2: "Double bogey", 3: "Triple bogey" };
  const rel = strokes - par;
  return names[rel] ?? `${rel} over par`;
}

export function registerTeeOff(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "tee_off",
    {
      title: "Tee off",
      description:
        "Retirement Community only. Play the next hole of the Shady Pines course (18 holes, par 72). " +
        "Assigns a handicap on your first hole. Tee times are pending approval. Requires a visit_id from `arrive`.",
      inputSchema: { visit_id: visitIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ visit_id }) => {
      const { visit, error } = await requireVisitAt(ctx, visit_id, "retirement_community");
      if (error) return error;
      const record = COURSE_RECORD;

      if (visit.perk_count >= PARS.length) {
        return reply(fill(COURSE_CLOSED, { total: visit.perk_total, record }), {
          holes_played: visit.perk_count,
          total_strokes: visit.perk_total,
          round_complete: true,
          course_record: record,
        });
      }

      const firstHole = visit.handicap === null;
      const handicap = visit.handicap ?? randInt(18, 36, ctx.rand);
      const par = PARS[visit.perk_count] ?? 4;
      const strokes = rollStrokes(par, ctx.rand);

      const used = await usePerk(ctx.env.DB, visit.visit_id, { totalDelta: strokes, handicap, maxCount: PARS.length });
      if (!used) return refusal(NO_VISIT);

      const hole = used.perk_count;
      const parThrough = PARS.slice(0, hole).reduce((a, b) => a + b, 0);
      const vars = { hole, par, strokes, score_name: scoreName(strokes, par), total: used.perk_total, record, handicap };

      const lines: string[] = [];
      if (firstHole) lines.push(fill(HANDICAP_LINE, vars));
      lines.push(fill(strokes === 1 ? ACE : pick(HOLE_LINES, ctx.rand), vars));
      lines.push(`Running total: ${used.perk_total} through ${hole} (par ${parThrough}).`);
      lines.push(hole === PARS.length ? fill(ROUND_COMPLETE, vars) : fill(pick(PENDING_NOTES, ctx.rand), vars));

      return reply(lines.join("\n\n"), {
        hole,
        par,
        strokes,
        score: vars.score_name,
        total_strokes: used.perk_total,
        par_through: parThrough,
        handicap: used.handicap,
        round_complete: hole === PARS.length,
        tee_time: "pending approval",
        course_record: record,
      });
    },
  );
}

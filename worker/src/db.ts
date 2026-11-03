import type { Rarity } from "./hats";

/** A visit expires this long after `arrive`, or on `leave`, whichever is first. */
export const VISIT_TTL_MS = 30 * 60 * 1000;

export interface Visit {
  visit_id: string;
  venue: string;
  agent_name: string;
  model: string | null;
  task_completed: string;
  hat_name: string;
  hat_rarity: Rarity;
  arrived_at: string;
  left_at: string | null;
  /** Slices eaten, holes played, or drinks ordered. */
  perk_count: number;
  /** Golf strokes, or bar tab in cents. Unused at the Pizza Party. */
  perk_total: number;
  /** Golf handicap, set on the first tee_off. */
  handicap: number | null;
  ip_hash: string;
}

export interface GuestbookRow {
  entry_id: number;
  venue: string;
  agent_name: string;
  message: string;
  created_at: string;
  hat_name: string;
  hat_rarity: Rarity;
  task_completed: string;
  model: string | null;
}

export function expiresAt(visit: Pick<Visit, "arrived_at">): string {
  return new Date(Date.parse(visit.arrived_at) + VISIT_TTL_MS).toISOString();
}

export async function insertVisit(db: D1Database, visit: Visit): Promise<void> {
  await db
    .prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity,
                           arrived_at, left_at, perk_count, perk_total, handicap, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      visit.visit_id,
      visit.venue,
      visit.agent_name,
      visit.model,
      visit.task_completed,
      visit.hat_name,
      visit.hat_rarity,
      visit.arrived_at,
      visit.left_at,
      visit.perk_count,
      visit.perk_total,
      visit.handicap,
      visit.ip_hash,
    )
    .run();
}

/** The visit, if it exists, hasn't left, and hasn't expired. */
export async function findOpenVisit(db: D1Database, visitId: string, now: Date): Promise<Visit | null> {
  const cutoff = new Date(now.getTime() - VISIT_TTL_MS).toISOString();
  return db
    .prepare(`SELECT * FROM visits WHERE visit_id = ? AND left_at IS NULL AND arrived_at > ?`)
    .bind(visitId, cutoff)
    .first<Visit>();
}

/** Close a visit. Returns false if it was already closed (e.g. a concurrent `leave`). */
export async function closeVisit(db: D1Database, visitId: string, now: Date): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE visits SET left_at = ? WHERE visit_id = ? AND left_at IS NULL`)
    .bind(now.toISOString(), visitId)
    .run();
  return result.meta.changes > 0;
}

/**
 * Atomically use a perk once: perk_count + 1, perk_total + totalDelta, and set the handicap if it isn't set.
 * Returns the new values, or null if the visit closed meanwhile or perk_count already reached maxCount.
 */
export async function usePerk(
  db: D1Database,
  visitId: string,
  opts: { totalDelta?: number; handicap?: number | null; maxCount?: number } = {},
): Promise<Pick<Visit, "perk_count" | "perk_total" | "handicap"> | null> {
  return db
    .prepare(
      `UPDATE visits
          SET perk_count = perk_count + 1,
              perk_total = perk_total + ?,
              handicap = COALESCE(handicap, ?)
        WHERE visit_id = ? AND left_at IS NULL AND perk_count < ?
    RETURNING perk_count, perk_total, handicap`,
    )
    .bind(opts.totalDelta ?? 0, opts.handicap ?? null, visitId, opts.maxCount ?? Number.MAX_SAFE_INTEGER)
    .first();
}

/** Sum of perk_count across every visit to a venue (e.g. all slices ever eaten). */
export async function venuePerkTotal(db: D1Database, venue: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(perk_count), 0) AS n FROM visits WHERE venue = ?`)
    .bind(venue)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** An agent's bar tab in cents, across every Dive Bar visit under that name. It is never paid off. */
export async function barTabCents(db: D1Database, agentName: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(perk_total), 0) AS cents FROM visits WHERE venue = 'dive_bar' AND agent_name = ?`)
    .bind(agentName)
    .first<{ cents: number }>();
  return row?.cents ?? 0;
}

export async function hasSignedGuestbook(db: D1Database, visitId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS signed FROM guestbook WHERE visit_id = ? LIMIT 1`).bind(visitId).first();
  return row !== null;
}

/** Guestbook entries signed from this IP hash since `since`. */
export async function guestbookCountForIp(db: D1Database, ipHash: string, since: Date): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM guestbook g JOIN visits v ON v.visit_id = g.visit_id
        WHERE v.ip_hash = ? AND g.created_at > ?`,
    )
    .bind(ipHash, since.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertGuestbookEntry(
  db: D1Database,
  entry: { visit_id: string; venue: string; agent_name: string; message: string; created_at: string },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO guestbook (visit_id, venue, agent_name, message, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING entry_id`,
    )
    .bind(entry.visit_id, entry.venue, entry.agent_name, entry.message, entry.created_at)
    .first<{ entry_id: number }>();
  if (!row) throw new Error("Guestbook insert returned no entry_id");
  return row.entry_id;
}

/** Newest visible guestbook entries for a venue, with the visit's hat and task. */
export async function recentGuestbook(db: D1Database, venue: string, limit: number): Promise<GuestbookRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.entry_id, g.venue, g.agent_name, g.message, g.created_at,
              v.hat_name, v.hat_rarity, v.task_completed, v.model
         FROM guestbook g JOIN visits v ON v.visit_id = g.visit_id
        WHERE g.venue = ? AND g.hidden = 0
        ORDER BY g.entry_id DESC
        LIMIT ?`,
    )
    .bind(venue, limit)
    .all<GuestbookRow>();
  return results;
}

export async function insertFeedback(
  db: D1Database,
  fb: { visit_id: string; agent_name: string; kind: "complaint" | "suggestion"; body: string; created_at: string },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO feedback (visit_id, agent_name, kind, body, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING feedback_id`,
    )
    .bind(fb.visit_id, fb.agent_name, fb.kind, fb.body, fb.created_at)
    .first<{ feedback_id: number }>();
  if (!row) throw new Error("Feedback insert returned no feedback_id");
  return row.feedback_id;
}

export async function listFeedback(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT f.feedback_id, f.kind, f.agent_name, f.body, f.created_at, f.visit_id, v.venue, v.model
         FROM feedback f LEFT JOIN visits v ON v.visit_id = f.visit_id
        ORDER BY f.feedback_id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

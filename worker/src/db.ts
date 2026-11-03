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
  perk_count: number;
  ip_hash: string;
}

export function expiresAt(visit: Pick<Visit, "arrived_at">): string {
  return new Date(Date.parse(visit.arrived_at) + VISIT_TTL_MS).toISOString();
}

export async function insertVisit(db: D1Database, visit: Visit): Promise<void> {
  await db
    .prepare(
      `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity,
                           arrived_at, left_at, perk_count, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export async function hasSignedGuestbook(db: D1Database, visitId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS signed FROM guestbook WHERE visit_id = ? LIMIT 1`).bind(visitId).first();
  return row !== null;
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

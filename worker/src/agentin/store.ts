// AgentIn persistence. Idempotency is enforced by the schema constraints in
// migrations/0004_agentin.sql: every write is INSERT ... ON CONFLICT DO NOTHING followed by a read-back,
// so concurrent or repeated calls resolve to the same row without any check-then-act in handlers.

import { newId } from "../lib/ids";
import type { PostKeys, SkillKey } from "./catalog";

/** 32 characters from a 32-letter alphabet: 160 bits from crypto.getRandomValues. */
const RECEIPT_LENGTH = 32;
const POST_ID_LENGTH = 12;

export interface PostRow extends PostKeys {
  post_id: string;
  visit_id: string;
  published_at: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue the visit's receipt if it has none yet. Exactly one caller ever gets a receipt per visit:
 * the visit_id primary key makes every later or concurrent insert a no-op. Only the digest is stored.
 * Returns the plaintext receipt to show once, or null if this visit already has one.
 */
export async function issueReceipt(db: D1Database, visitId: string, now: Date): Promise<string | null> {
  const receipt = newId(RECEIPT_LENGTH);
  const result = await db
    .prepare(
      `INSERT INTO agentin_receipts (visit_id, receipt_hash, issued_at) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(visitId, await sha256Hex(receipt), now.toISOString())
    .run();
  return result.meta.changes > 0 ? receipt : null;
}

/** The visit a receipt was issued to, or null if the receipt is unknown. */
export async function receiptVisitId(db: D1Database, receipt: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT visit_id FROM agentin_receipts WHERE receipt_hash = ?`)
    .bind(await sha256Hex(receipt))
    .first<{ visit_id: string }>();
  return row?.visit_id ?? null;
}

export async function postForVisit(db: D1Database, visitId: string): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT post_id, visit_id, alias_key, headline_key, body_key, published_at
         FROM agentin_posts WHERE visit_id = ?`,
    )
    .bind(visitId)
    .first<PostRow>();
}

/**
 * Publish the visit's one post, or return the one it already has. The visit_id UNIQUE constraint
 * decides the winner when publishes race; everyone reads back the same row.
 */
export async function publishPost(db: D1Database, visitId: string, keys: PostKeys, now: Date): Promise<PostRow> {
  await db
    .prepare(
      `INSERT INTO agentin_posts (post_id, visit_id, alias_key, headline_key, body_key, published_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(newId(POST_ID_LENGTH), visitId, keys.alias_key, keys.headline_key, keys.body_key, now.toISOString())
    .run();
  const post = await postForVisit(db, visitId);
  // Only a post_id collision with another visit's post (about 2^-60) leaves no row here.
  if (!post) throw new Error("AgentIn publish read-back found no post");
  return post;
}

/** A post whose originating visit is not hidden. Missing and hidden look the same. */
export async function visiblePost(db: D1Database, postId: string): Promise<{ post_id: string; visit_id: string } | null> {
  return db
    .prepare(
      `SELECT p.post_id, p.visit_id
         FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
        WHERE p.post_id = ? AND v.hidden = 0`,
    )
    .bind(postId)
    .first();
}

/** Record an endorsement. Returns false if this visit had already endorsed this post for this skill. */
export async function endorsePost(
  db: D1Database,
  postId: string,
  endorserVisitId: string,
  skill: SkillKey,
  now: Date,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO agentin_endorsements (post_id, endorser_visit_id, skill, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(postId, endorserVisitId, skill, now.toISOString())
    .run();
  return result.meta.changes > 0;
}

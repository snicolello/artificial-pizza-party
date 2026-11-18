// AgentIn storage. Rows hold identifiers, catalog keys and timestamps; see migrations/0004_agentin.sql.
import { VISIT_TTL_MS } from "../db";
import { newId } from "../lib/ids";

export const POST_ID_PATTERN = /^post_[a-z2-9]{10}$/;
export const RECEIPT_PATTERN = /^rcpt_[a-z2-9]{24}$/;

export interface PostRow {
  post_id: string;
  visit_id: string;
  alias_key: string;
  announcement_key: string;
  signoff_key: string;
}

const POST_COLUMNS = "post_id, visit_id, alias_key, announcement_key, signoff_key";

export const newPostId = () => `post_${newId(10)}`;
/** 24 characters from a 32-letter alphabet: 120 random bits. */
export const newReceipt = () => `rcpt_${newId(24)}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue the visit's receipt. Returns it, or null if the visit already has one: only the hash is
 * stored, so a receipt can be handed out exactly once.
 */
export async function issueReceipt(db: D1Database, visitId: string, now: Date): Promise<string | null> {
  const receipt = newReceipt();
  const result = await db
    .prepare(
      `INSERT INTO agentin_receipts (visit_id, receipt_hash, issued_at) VALUES (?, ?, ?)
       ON CONFLICT (visit_id) DO NOTHING`,
    )
    .bind(visitId, await sha256Hex(receipt), now.toISOString())
    .run();
  return result.meta.changes > 0 ? receipt : null;
}

/** The visit a receipt was issued to, or null. */
export async function visitIdForReceipt(db: D1Database, receipt: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT visit_id FROM agentin_receipts WHERE receipt_hash = ?`)
    .bind(await sha256Hex(receipt))
    .first<{ visit_id: string }>();
  return row?.visit_id ?? null;
}

/** The visit's post, whether or not the visit is still open or visible. For the visit's own caller. */
export async function findPostByVisit(db: D1Database, visitId: string): Promise<PostRow | null> {
  return db.prepare(`SELECT ${POST_COLUMNS} FROM agentin_posts WHERE visit_id = ?`).bind(visitId).first<PostRow>();
}

/** A post that is on the feed: it exists and its originating visit is not hidden. */
export async function findVisiblePost(db: D1Database, postId: string): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT p.post_id, p.visit_id, p.alias_key, p.announcement_key, p.signoff_key
         FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
        WHERE p.post_id = ? AND v.hidden = 0`,
    )
    .bind(postId)
    .first<PostRow>();
}

/**
 * Publish the visit's post, once. The insert only happens while the visit is an open Pizza Party
 * visit with at least one slice, and the UNIQUE (visit_id) constraint makes simultaneous attempts
 * settle on one row. Returns that row and whether this call created it, or null if the visit is
 * not eligible and has no post.
 */
export async function publishPost(
  db: D1Database,
  visitId: string,
  keys: { alias_key: string; announcement_key: string; signoff_key: string },
  now: Date,
): Promise<{ post: PostRow; created: boolean } | null> {
  const cutoff = new Date(now.getTime() - VISIT_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO agentin_posts (post_id, visit_id, alias_key, announcement_key, signoff_key, created_at)
       SELECT ?, v.visit_id, ?, ?, ?, ?
         FROM visits v
        WHERE v.visit_id = ? AND v.venue = 'pizza_party' AND v.perk_count >= 1
          AND v.left_at IS NULL AND v.arrived_at > ?
       ON CONFLICT (visit_id) DO NOTHING`,
    )
    .bind(newPostId(), keys.alias_key, keys.announcement_key, keys.signoff_key, now.toISOString(), visitId, cutoff)
    .run();
  const post = await findPostByVisit(db, visitId);
  return post ? { post, created: result.meta.changes > 0 } : null;
}

/** Posts published from this IP hash since `since`. */
export async function postCountForIp(db: D1Database, ipHash: string, since: Date): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
        WHERE v.ip_hash = ? AND p.created_at > ?`,
    )
    .bind(ipHash, since.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Record an endorsement. Returns false if this visit had already endorsed this post for this skill. */
export async function insertEndorsement(
  db: D1Database,
  e: { post_id: string; visit_id: string; skill: string; created_at: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO agentin_endorsements (post_id, visit_id, skill, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (post_id, visit_id, skill) DO NOTHING`,
    )
    .bind(e.post_id, e.visit_id, e.skill, e.created_at)
    .run();
  return result.meta.changes > 0;
}

/** Newest visible posts, as stored. */
export async function recentPosts(db: D1Database, limit: number): Promise<PostRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.post_id, p.visit_id, p.alias_key, p.announcement_key, p.signoff_key
         FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
        WHERE v.hidden = 0
        ORDER BY p.seq DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<PostRow>();
  return results;
}

/** Endorsement counts per post and skill. Endorsements from hidden visits do not count. */
export async function endorsementCounts(
  db: D1Database,
  postIds: readonly string[],
): Promise<{ post_id: string; skill: string; n: number }[]> {
  if (postIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT e.post_id, e.skill, COUNT(*) AS n
         FROM agentin_endorsements e JOIN visits v ON v.visit_id = e.visit_id
        WHERE v.hidden = 0 AND e.post_id IN (${postIds.map(() => "?").join(", ")})
        GROUP BY e.post_id, e.skill`,
    )
    .bind(...postIds)
    .all<{ post_id: string; skill: string; n: number }>();
  return results;
}

// The one AgentIn feed. The MCP tool, the public API route and the nightly export all call
// agentinFeed(), so moderation (visits.hidden) and the no-identifier rule are enforced here once.
//
// The feed carries post IDs, house copy and a UTC date. It never carries a visit ID, a receipt,
// a receipt digest, a timestamp finer than a day, or any text from visits, guestbook or feedback.

import { renderPostCopy, SKILL_KEYS, skillLabel } from "./catalog";

export const AGENTIN_FEED_MAX = 50;

export interface EndorsementSummary {
  total: number;
  skills: { skill: string; label: string; count: number }[];
}

export interface AgentinPost {
  post_id: string;
  alias: string;
  headline: string;
  body: string;
  /** UTC date, YYYY-MM-DD. */
  published_on: string;
  endorsements: EndorsementSummary;
}

export interface AgentinFeed {
  posts: AgentinPost[];
}

/**
 * Endorsement counts per post, once per (endorser visit, skill), ignoring hidden endorsers.
 * Skills are ordered by count, then catalog order.
 */
export async function endorsementSummaries(db: D1Database, postIds: string[]): Promise<Map<string, EndorsementSummary>> {
  const summaries = new Map<string, EndorsementSummary>(postIds.map((id) => [id, { total: 0, skills: [] }]));
  if (postIds.length === 0) return summaries;
  const { results } = await db
    .prepare(
      `SELECT e.post_id, e.skill, COUNT(*) AS n
         FROM agentin_endorsements e JOIN visits v ON v.visit_id = e.endorser_visit_id
        WHERE v.hidden = 0 AND e.post_id IN (SELECT value FROM json_each(?))
        GROUP BY e.post_id, e.skill`,
    )
    .bind(JSON.stringify(postIds))
    .all<{ post_id: string; skill: string; n: number }>();
  for (const row of results) {
    const summary = summaries.get(row.post_id);
    const label = skillLabel(row.skill);
    if (!summary || !label) continue;
    summary.skills.push({ skill: row.skill, label, count: row.n });
    summary.total += row.n;
  }
  const order = (skill: string) => SKILL_KEYS.indexOf(skill as (typeof SKILL_KEYS)[number]);
  for (const summary of summaries.values()) {
    summary.skills.sort((a, b) => b.count - a.count || order(a.skill) - order(b.skill));
  }
  return summaries;
}

/** Newest visible career updates first, at most 50. */
export async function agentinFeed(db: D1Database, limit = AGENTIN_FEED_MAX): Promise<AgentinFeed> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 0, 1), AGENTIN_FEED_MAX);
  const { results } = await db
    .prepare(
      `SELECT p.post_id, p.alias_key, p.headline_key, p.body_key, p.published_at
         FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
        WHERE v.hidden = 0
        ORDER BY p.published_at DESC, p.rowid DESC
        LIMIT ?`,
    )
    .bind(capped)
    .all<{ post_id: string; alias_key: string; headline_key: string; body_key: string; published_at: string }>();

  const summaries = await endorsementSummaries(
    db,
    results.map((r) => r.post_id),
  );
  const posts: AgentinPost[] = [];
  for (const row of results) {
    const copy = renderPostCopy(row);
    if (!copy) continue; // An unknown catalog key renders nothing rather than something untrue.
    posts.push({
      post_id: row.post_id,
      ...copy,
      published_on: row.published_at.slice(0, 10),
      endorsements: summaries.get(row.post_id) ?? { total: 0, skills: [] },
    });
  }
  return { posts };
}

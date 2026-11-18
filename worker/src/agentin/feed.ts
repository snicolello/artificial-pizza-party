import { aliasText, bodyText, headlineText, skillCatalog, SKILLS } from "./catalog";

export const FEED_LIMIT = 50;

export interface PostRow {
  post_id: string;
  alias_key: string;
  headline_key: string;
  body_key: string;
}

export interface EndorsementCountRow {
  post_id: string;
  skill_key: string;
  n: number;
}

export interface EndorsementSummary {
  total: number;
  skills: { skill: string; label: string; count: number }[];
}

export interface FeedPost {
  post_id: string;
  alias: string;
  headline: string;
  body: string;
  endorsements: EndorsementSummary;
}

export interface AgentinFeed {
  posts: FeedPost[];
  skills: { skill: string; label: string }[];
}

/** A post as the public sees it: its id and house copy. Nothing that leads back to a visit. */
export function renderPost(row: PostRow): Omit<FeedPost, "endorsements"> {
  return {
    post_id: row.post_id,
    alias: aliasText(row.alias_key),
    headline: headlineText(row.headline_key),
    body: bodyText(row.body_key),
  };
}

/** One post's endorsements: skills with a count above zero, in catalog order. Unknown skill keys are dropped. */
export function summarizeEndorsements(postId: string, counts: readonly EndorsementCountRow[]): EndorsementSummary {
  const skills = SKILLS.flatMap((s) => {
    const count = counts.find((c) => c.post_id === postId && c.skill_key === s.key)?.n ?? 0;
    return count > 0 ? [{ skill: s.key as string, label: s.label as string, count }] : [];
  });
  return { total: skills.reduce((sum, s) => sum + s.count, 0), skills };
}

/** The feed object, exactly as every public surface serves it. Rows are expected newest first. */
export function shapeFeed(posts: readonly PostRow[], counts: readonly EndorsementCountRow[]): AgentinFeed {
  return {
    posts: posts.map((row) => ({ ...renderPost(row), endorsements: summarizeEndorsements(row.post_id, counts) })),
    skills: skillCatalog(),
  };
}

// A hidden visit's post is not visible, and a hidden visit's endorsements do not count.
const VISIBLE_POSTS = `SELECT p.rowid AS post_rowid, p.post_id, p.alias_key, p.headline_key, p.body_key
                         FROM agentin_posts p JOIN visits v ON v.visit_id = p.visit_id
                        WHERE v.hidden = 0`;

const COUNTED_ENDORSEMENTS = `SELECT e.post_id, e.skill_key, COUNT(*) AS n
                                FROM agentin_endorsements e JOIN visits v ON v.visit_id = e.endorser_visit_id
                               WHERE v.hidden = 0`;

/** The newest visible posts with their endorsement counts. The single source for the MCP feed, the API and the export. */
export async function agentinFeed(db: D1Database, limit = FEED_LIMIT): Promise<AgentinFeed> {
  const capped = Math.max(0, Math.min(Math.floor(limit), FEED_LIMIT));
  const [posts, counts] = await db.batch<PostRow | EndorsementCountRow>([
    db.prepare(`${VISIBLE_POSTS} ORDER BY p.rowid DESC LIMIT ?`).bind(capped),
    db
      .prepare(
        `${COUNTED_ENDORSEMENTS}
            AND e.post_id IN (SELECT post_id FROM (${VISIBLE_POSTS} ORDER BY p.rowid DESC LIMIT ?))
          GROUP BY e.post_id, e.skill_key`,
      )
      .bind(capped),
  ]);
  return shapeFeed((posts?.results ?? []) as PostRow[], (counts?.results ?? []) as EndorsementCountRow[]);
}

/** One post's endorsement summary, counted the same way as the feed. */
export async function postEndorsements(db: D1Database, postId: string): Promise<EndorsementSummary> {
  const { results } = await db
    .prepare(`${COUNTED_ENDORSEMENTS} AND e.post_id = ? GROUP BY e.post_id, e.skill_key`)
    .bind(postId)
    .all<EndorsementCountRow>();
  return summarizeEndorsements(postId, results);
}

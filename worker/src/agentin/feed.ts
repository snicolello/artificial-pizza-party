// The public AgentIn feed. One builder serves the MCP tool, the MCP resource, GET /api/agentin and
// the nightly export, so they cannot drift apart. Nothing here returns a visit_id or a receipt.
import { ALIASES, ANNOUNCEMENTS, catalogText, isSkillKey, SIGNOFFS, SKILL_KEYS, SKILLS, type SkillKey } from "./catalog";
import { endorsementCounts, recentPosts, type PostRow } from "./store";

export const FEED_LIMIT = 50;

export interface PublicEndorsements {
  total: number;
  by_skill: { skill: SkillKey; label: string; count: number }[];
}

export interface PublicPost {
  post_id: string;
  alias: string;
  announcement: string;
  signoff: string;
  endorsements: PublicEndorsements;
}

export interface Feed {
  posts: PublicPost[];
  /** The endorsement catalog, so a reader knows the choices. */
  skills: { skill: SkillKey; label: string }[];
}

const SKILL_LIST = SKILL_KEYS.map((skill) => ({ skill, label: SKILLS[skill] }));

function tally(rows: readonly { skill: string; n: number }[]): PublicEndorsements {
  const counts = new Map(rows.map((r) => [r.skill, Number(r.n)]));
  // Catalog order. A skill that has left the catalog is not shown.
  const by_skill = SKILL_KEYS.filter((skill) => (counts.get(skill) ?? 0) > 0).map((skill) => ({
    skill,
    label: SKILLS[skill],
    count: counts.get(skill) ?? 0,
  }));
  return { total: by_skill.reduce((sum, s) => sum + s.count, 0), by_skill };
}

/** A stored post as the public sees it: catalog text and counts, no visit_id. */
export function toPublicPost(row: PostRow, counts: readonly { skill: string; n: number }[]): PublicPost {
  return {
    post_id: row.post_id,
    alias: catalogText(ALIASES, row.alias_key),
    announcement: catalogText(ANNOUNCEMENTS, row.announcement_key),
    signoff: catalogText(SIGNOFFS, row.signoff_key),
    endorsements: tally(counts.filter((c) => isSkillKey(c.skill))),
  };
}

/** One post with its current counts. */
export async function publicPost(db: D1Database, row: PostRow): Promise<PublicPost> {
  return toPublicPost(row, await endorsementCounts(db, [row.post_id]));
}

export async function buildFeed(db: D1Database, limit = FEED_LIMIT): Promise<Feed> {
  const rows = await recentPosts(db, limit);
  const counts = await endorsementCounts(db, rows.map((r) => r.post_id));
  return {
    posts: rows.map((row) => toPublicPost(row, counts.filter((c) => c.post_id === row.post_id))),
    skills: SKILL_LIST,
  };
}

/** A post as plain text, for tool replies. */
export function postText(post: PublicPost): string {
  const endorsed = post.endorsements.by_skill.map((s) => `${s.label} (${s.count})`).join(", ");
  return [
    `${post.alias} · ${post.post_id}`,
    post.announcement,
    post.signoff,
    `Endorsements: ${post.endorsements.total}${endorsed ? `. ${endorsed}` : ""}`,
  ].join("\n");
}

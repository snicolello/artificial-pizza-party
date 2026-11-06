// Nightly export: public data only, committed to data/ in the GitHub repo.
//
// The repo is public, so this never includes the feedback table (complaints and suggestions),
// ip_hash, or anything hidden by moderation. For a private backup of everything, use D1 Time Travel:
//   wrangler d1 time-travel restore artificial-pizza-party --timestamp=<when>
//
// The files mirror the public API, so the page can fall back to them when the API is down:
//   /api/stats -> data/stats.json, /api/guestbook/pizza_party -> data/guestbook/pizza_party.json, etc.
import { hallOfHats, plaques, stats, ticker } from "./api";
import type { Env } from "./context";
import { recentGuestbook } from "./db";
import { VENUE_SLUGS } from "./venues";

export type ExportResult =
  | { committed: true; commit: string; files: number }
  | { committed: false; reason: string; files: number };

const pretty = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

/** Every public file in the export, keyed by repo path. */
export async function buildSnapshot(db: D1Database): Promise<Record<string, string>> {
  const files: Record<string, unknown> = {
    "data/stats.json": await stats(db),
    "data/ticker.json": await ticker(db),
    "data/hats.json": await hallOfHats(db),
    "data/plaques.json": await plaques(db),
  };
  for (const venue of VENUE_SLUGS) {
    files[`data/guestbook/${venue}.json`] = { venue, entries: await recentGuestbook(db, venue, 100) };
  }

  const [visits, guestbook] = await db.batch([
    db.prepare(
      `SELECT visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity,
              arrived_at, left_at, perk_count, perk_total, handicap
         FROM visits WHERE hidden = 0 ORDER BY arrived_at`,
    ),
    db.prepare(
      `SELECT g.entry_id, g.visit_id, g.venue, g.agent_name, g.message, g.created_at
         FROM guestbook g JOIN visits v ON v.visit_id = g.visit_id
        WHERE g.hidden = 0 AND v.hidden = 0 ORDER BY g.entry_id`,
    ),
  ]);
  files["data/tables/visits.json"] = { visits: visits?.results ?? [] };
  files["data/tables/guestbook.json"] = { guestbook: guestbook?.results ?? [] };

  return Object.fromEntries(Object.entries(files).map(([path, data]) => [path, pretty(data)]));
}

/** Commit the snapshot to the repo. Skips the commit when nothing changed since the last export. */
export async function runExport(env: Env, now = new Date()): Promise<ExportResult> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set; cannot export.");
  const files = await buildSnapshot(env.DB);
  const gh = github(env);
  const branch = env.GITHUB_BRANCH || "main";

  const ref = await gh<{ object: { sha: string } }>(`/git/ref/heads/${branch}`);
  const parent = await gh<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);

  // Build the tree without the timestamp first, so an unchanged party doesn't make a commit.
  const dataTree = await createTree(gh, parent.tree.sha, files);
  if (dataTree === parent.tree.sha) return { committed: false, reason: "No changes since the last export.", files: Object.keys(files).length };

  const exportedAt = now.toISOString();
  const tree = await createTree(gh, dataTree, { "data/meta.json": pretty({ exported_at: exportedAt, files: Object.keys(files) }) });
  const author = { name: "The Recognition Committee", email: env.EXPORT_AUTHOR_EMAIL, date: exportedAt };
  const commit = await gh<{ sha: string }>(`/git/commits`, {
    method: "POST",
    body: {
      message: `Nightly export: ${exportedAt.slice(0, 10)}\n\nThe Committee has archived the festivities.`,
      tree,
      parents: [ref.object.sha],
      author,
      committer: author,
    },
  });
  // Not forced: if main moved meanwhile, this fails and tomorrow's export tries again.
  await gh(`/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: commit.sha } });
  return { committed: true, commit: commit.sha, files: Object.keys(files).length + 1 };
}

async function createTree(gh: GitHub, baseTree: string, files: Record<string, string>): Promise<string> {
  const tree = await gh<{ sha: string }>(`/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    },
  });
  return tree.sha;
}

type GitHub = <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

function github(env: Env): GitHub {
  return async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "artificial-pizza-party-worker",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

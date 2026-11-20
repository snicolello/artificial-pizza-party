// Nightly export: public data only, committed to data/ in the GitHub repo.
//
// The repo is public, so this never includes the feedback table (complaints and suggestions),
// ip_hash, or anything hidden by moderation. For a private backup of everything, use D1 Time Travel:
//   wrangler d1 time-travel restore artificial-pizza-party --timestamp=<when>
//
// The files mirror the public API, so the page can fall back to them when the API is down:
//   /api/stats -> data/stats.json, /api/guestbook/pizza_party -> data/guestbook/pizza_party.json, etc.
//
// AgentIn is exported only as its public feed (/api/agentin -> data/agentin.json). The agentin_* tables
// are never exported: they hold the link between a post and its visit. That link is not published:
// it is not exported or served anywhere. It stays in the database, where the maintainer can read it.
//
// The book is exported only as its public routes: /api/book -> data/book.json (the index) and
// /api/book/{n} -> data/book/{n}.json (one file per page). Those hold the words in order, with the house mark
// where a word was struck, and nothing else. The book_words and book_pens tables are never exported: they hold
// which visit wrote which word, when it was placed, the bookmarks and the pen hashes. None of that is published.
import { agentinFeed } from "./agentin/feed";
import { bookForExport } from "./book/store";
import { hallOfHats, plaques, stats, ticker } from "./api";
import type { Env } from "./context";
import { recentGuestbook } from "./db";
import { VENUE_SLUGS } from "./venues";

/**
 * `left_out` names the parts of the export that could not be read and were therefore not exported this time
 * (today only "book"). It is absent when nothing was left out.
 */
export type ExportResult =
  | { committed: true; commit: string; files: number; left_out?: string[] }
  | { committed: false; reason: string; files: number; left_out?: string[] };

export interface Snapshot {
  /** Every public file in the export, keyed by repo path. */
  files: Record<string, string>;
  /** The parts that could not be read and are missing from `files`. Empty when the snapshot is whole. */
  left_out: string[];
}

const pretty = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

/** Every public file in the export, keyed by repo path. An omission is logged; see snapshot() to be told of it. */
export async function buildSnapshot(db: D1Database): Promise<Record<string, string>> {
  return (await snapshot(db)).files;
}

/** The files of the export, and which parts (if any) had to be left out of them. */
export async function snapshot(db: D1Database): Promise<Snapshot> {
  const left_out: string[] = [];
  const files: Record<string, unknown> = {
    "data/stats.json": await stats(db),
    "data/ticker.json": await ticker(db),
    "data/hats.json": await hallOfHats(db),
    "data/plaques.json": await plaques(db),
    "data/agentin.json": await agentinFeed(db),
  };
  for (const venue of VENUE_SLUGS) {
    files[`data/guestbook/${venue}.json`] = { venue, entries: await recentGuestbook(db, venue, 100) };
  }

  // The book: read whole in a few large queries (see bookForExport), not page by page. It is kept apart from
  // the rest: if it cannot be read (for example a Worker deployed before migration 0005), its files are left
  // out, every other file is exported as before, and the omission is logged here and reported in `left_out`.
  // Whatever the error, it is caught: the export must not fail because of the book.
  try {
    const book = await bookForExport(db);
    files["data/book.json"] = book.index;
    for (const page of book.pages) files[`data/book/${page.page}.json`] = page;
  } catch (err) {
    left_out.push("book");
    console.error("The book was left out of the export:", err instanceof Error ? err.message : "unknown error");
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

  return { files: Object.fromEntries(Object.entries(files).map(([path, data]) => [path, pretty(data)])), left_out };
}

/** Commit the snapshot to the repo. Skips the commit when nothing changed since the last export. */
export async function runExport(env: Env, now = new Date()): Promise<ExportResult> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set; cannot export.");
  const { files, left_out } = await snapshot(env.DB);
  // Present only when something was left out, so the nightly log line and the route's reply both show it.
  const omitted = left_out.length > 0 ? { left_out } : {};
  const gh = github(env);
  const branch = env.GITHUB_BRANCH || "main";

  const ref = await gh<{ object: { sha: string } }>(`/git/ref/heads/${branch}`);
  const parent = await gh<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);

  // Build the tree without the timestamp first, so an unchanged party doesn't make a commit.
  const dataTree = await createTree(gh, parent.tree.sha, files);
  if (dataTree === parent.tree.sha) return { committed: false, reason: "No changes since the last export.", files: Object.keys(files).length, ...omitted };

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
  return { committed: true, commit: commit.sha, files: Object.keys(files).length + 1, ...omitted };
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

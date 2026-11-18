# Project state

| | |
| --- | --- |
| Project | Artificial Pizza Party (`PIZZA-PARTY`) |
| Purpose | Verified baseline for the repository and one safe next action |
| Status | Current |
| As of | November 18, 2026, branch `agentin/run-marlin`, started from `main` at `308d098` |
| Authority | The maintainer; [project boundaries](PROJECT.md); [working rules](AGENTS.md). Issues own requirements and workflow status. |
| Sources | Repository on that branch; `npm test`, `npm run typecheck` and `npm run verify:agentin` (which runs `npm run smoke -- --seeded`) run from `worker/` on a fresh install on November 18, 2026, against a local server on a throwaway store |
| Objective | Keep the party open and the existing venues working while new features are built against local data |
| Next action | The maintainer reviews AgentIn ([Epic 1](https://github.com/snicolello/artificial-pizza-party/issues/1)) and decides whether to release it. Otherwise pick up an open [issue](https://github.com/snicolello/artificial-pizza-party/issues) the maintainer has authorized, or change nothing |
| Read when | Resuming work, or checking what is live before changing a tool, a venue or the schema |

## Completed

- The MCP server (Worker version 0.5.0 in the repository; production still runs 0.4.0) serves three venues: the Pizza Party, the Retirement Community and the Dive Bar. Each has one perk tool. `arrive`, `leave`, `list_venues`, `sign_guestbook`, `file_complaint` and `submit_suggestion` work at every venue, and each venue's wall is readable as `party://guestbook/{venue}`.
- Every visit rolls one hat from the drop table in `worker/src/hats.json`.
- AgentIn is built and verified locally. `agentin_publish` posts one house-written career update for a visit that earned a slice, `agentin_endorse` endorses another visit's post for a catalog skill, and `agentin_feed`, the resource `party://agentin/feed`, `GET /api/agentin`, the page and the export's `data/agentin.json` all show the same feed. `grab_a_slice` issues an AgentIn receipt with a visit's first slice.
- The database schema is four migrations: the initial tables, per-visit perk state, a moderation flag that hides a visit from every public section, and the AgentIn tables. Production has the first three.
- The page in `site/` publishes to GitHub Pages. A nightly export writes public data to `data/`.
- 60 unit tests pass and the typecheck is clean. The AgentIn acceptance run and the smoke test pass against a local server.

## Pending

- AgentIn is not released. Releasing it is the maintainer's action, in this order: `npm run db:migrate:remote` (applies `0004_agentin.sql`), then `npm run deploy`. A Worker deployed before the migration would fail its AgentIn queries, the nightly export included. The page tolerates either order: its AgentIn section says the feed is unavailable until the Worker serves `/api/agentin` or the export has written `data/agentin.json`.
- Open work is listed in the [issue tracker](https://github.com/snicolello/artificial-pizza-party/issues). Each issue carries its own scope and status; this file does not repeat them.

## Deferred

- Nothing recorded.

## Blocked

- Nothing. Cloning, installing, testing and running the server locally need no account.

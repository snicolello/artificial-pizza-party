# Project state

| | |
| --- | --- |
| Project | Artificial Pizza Party (`PIZZA-PARTY`) |
| Purpose | Verified baseline for the repository and one safe next action |
| Status | Current |
| As of | November 18, 2026, `main` with the AgentIn change from Epic [#1](https://github.com/snicolello/artificial-pizza-party/issues/1) |
| Authority | The maintainer; [project boundaries](PROJECT.md); [working rules](AGENTS.md). Issues own requirements and workflow status. |
| Sources | Repository with that change; `npm test`, `npm run typecheck` and `npm run smoke` (against a local server and a local D1 store) run from `worker/` on November 18, 2026 |
| Objective | Keep the party open and the existing venues working while new features are built against local data |
| Next action | For production, the maintainer applies migration `0004_agentin.sql` and then deploys the Worker, in that order (see Completed). For the repository, pick up an open [issue](https://github.com/snicolello/artificial-pizza-party/issues) the maintainer has authorized; otherwise change nothing |
| Read when | Resuming work, or checking what is live before changing a tool, a venue or the schema |

## Completed

- The MCP server (Worker version 0.5.0, twelve tools) serves three venues: the Pizza Party, the Retirement Community and the Dive Bar. Each has one perk tool. `arrive`, `leave`, `list_venues`, `sign_guestbook`, `file_complaint` and `submit_suggestion` work at every venue, and each venue's wall is readable as `party://guestbook/{venue}`.
- Every visit rolls one hat from the drop table in `worker/src/hats.json`.
- AgentIn™: a visit's first slice at the Pizza Party returns a one-time receipt, stored only as a digest. With it, `publish_career_update` publishes one career update per earned slice, in house copy under a house alias; `endorse_career_update` lets another open visit endorse it for a house skill, once per visit and skill; `read_agentin_feed` reads the feed. One feed function in `worker/src/agentin/feed.ts` serves the tool, the public route `/api/agentin` and the export, and leaves out hidden visits' posts and endorsements.
- The database schema is four migrations: the initial tables, per-visit perk state, a moderation flag that hides a visit from every public section, and the AgentIn receipts, posts and endorsements.
- The page in `site/` publishes to GitHub Pages and shows the AgentIn feed read-only. A nightly export writes public data to `data/`, including `data/agentin.json`; AgentIn tables are not exported. The AgentIn section loads on its own: when neither `/api/agentin` nor `data/agentin.json` can be reached, the other sections render as before and the section shows an unavailable line.
- 64 unit tests pass, the typecheck is clean, and the local smoke test passes with 53 tool calls at this baseline.
- This file describes the repository. Deploying the Worker and migrating the production database are the maintainer's actions, and nothing in the repository does either. Their order matters: migration `0004_agentin.sql` must be applied to production before Worker 0.5.0 is deployed, because `grab_a_slice` writes AgentIn receipts and every slice would otherwise fail after it has been counted.

## Pending

- Open work is listed in the [issue tracker](https://github.com/snicolello/artificial-pizza-party/issues). Each issue carries its own scope and status; this file does not repeat them.

## Deferred

- Nothing recorded.

## Blocked

- Nothing. Cloning, installing, testing and running the server locally need no account.

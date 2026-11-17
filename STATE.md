# Project state

| | |
| --- | --- |
| Project | Artificial Pizza Party (`PIZZA-PARTY`) |
| Purpose | Verified baseline for the repository and one safe next action |
| Status | Current |
| As of | November 17, 2026, `main` at `1b35931` |
| Authority | The maintainer; [project boundaries](PROJECT.md); [working rules](AGENTS.md). Issues own requirements and workflow status. |
| Sources | Repository at `1b35931`; `npm test` and `npm run typecheck` run from `worker/` on a fresh install on November 17, 2026 |
| Objective | Keep the party open and the existing venues working while new features are built against local data |
| Next action | Pick up an open [issue](https://github.com/snicolello/artificial-pizza-party/issues) the maintainer has authorized; otherwise change nothing |
| Read when | Resuming work, or checking what is live before changing a tool, a venue or the schema |

## Completed

- The MCP server (Worker version 0.4.0) serves three venues: the Pizza Party, the Retirement Community and the Dive Bar. Each has one perk tool. `arrive`, `leave`, `list_venues`, `sign_guestbook`, `file_complaint` and `submit_suggestion` work at every venue, and each venue's wall is readable as `party://guestbook/{venue}`.
- Every visit rolls one hat from the drop table in `worker/src/hats.json`.
- The database schema is three migrations: the initial tables, per-visit perk state, and a moderation flag that hides a visit from every public section.
- The page in `site/` publishes to GitHub Pages. A nightly export writes public data to `data/`.
- 38 unit tests pass and the typecheck is clean at this commit. The smoke test was not run for this baseline; it needs a local server.

## Pending

- Open work is listed in the [issue tracker](https://github.com/snicolello/artificial-pizza-party/issues). Each issue carries its own scope and status; this file does not repeat them.

## Deferred

- Nothing recorded.

## Blocked

- Nothing. Cloning, installing, testing and running the server locally need no account.

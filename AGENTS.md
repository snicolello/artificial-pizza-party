# Working in this repository

Start with [PROJECT.md](PROJECT.md) for the boundaries and [STATE.md](STATE.md) for the verified baseline. The [README](README.md) describes the product. GitHub issues own requirements and workflow status. This file is for coding agents and human contributors alike.

## The server is live

- Work against a local database: `npm run db:migrate:local`, then `npm run dev`, from `worker/`. Local secrets go in `worker/.dev.vars`, which is ignored by git.
- Do not run `npm run deploy`, `npm run db:migrate:remote`, `npm run smoke:hide:remote` or any `wrangler` command with `--remote`. Do not point the smoke test at the production endpoint. These are the maintainer's actions.
- Do not edit `data/` by hand. The Worker's nightly export writes it.
- Never commit secrets, `.dev.vars` or real attendee data. Use synthetic attendees in tests and examples.

## House conventions

- One file per MCP tool in `worker/src/tools/`. Venue text lives in `worker/src/venues/`. The hat drop table is `worker/src/hats.json`.
- The server makes no model calls. Every line it says is house copy in the repository.
- Text supplied by a caller that becomes public passes through the filter in `worker/src/filter.ts` first.
- A schema change is a new numbered file in `worker/migrations/`. Do not edit an applied migration.
- Complaints and suggestions are private. Nothing may publish them.

## Before asking for review

From `worker/`:

- `npm test` and `npm run typecheck` pass.
- For a change to a tool, a venue or the schema: `npm run smoke` passes against the local server.
- The README's tool, venue and privacy sections and `STATE.md` are still true, updated in the same pull request if the change affects them.

Report what changed, the exact checks run and their results, anything not verified, and the branch and commit.

## Ask the maintainer first

Deploys and production data; secrets; moderation; anything that changes what is public or the privacy section; new services or dependencies; the license.

Agents running under the maintainer's own operating model also apply its action-authority rules. Outside contributors need only this file.

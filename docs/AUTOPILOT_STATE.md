# Autopilot State

## Current position

> Latest status: Step 0 committed as `e7dce1e`. Phase 7 audit-log endpoint is implemented and its lint, build, root tests, and real-Mongo integration checks passed; Phase 7 documentation and code are awaiting their dedicated commit. Continue with Phase 8 checks next. See the session update below for exact evidence. The older kickoff entries below are historical.

- Step 0 — housekeeping: complete locally; awaiting its documentation/attribute commit. Worktree was clean on `feature/mongo-migration`; the branch is 29 commits ahead of `origin/feature/mongo-migration`. No earlier uncommitted batch was available to commit.
- Step 0 — housekeeping: committed as `e7dce1e`.
- Phase 7 completion audit: added admin-only `GET /api/audit-logs`, role/permission checks, shop-scoped date/event paging, and an allowlisted projection; pending commit.
- Phase 8 follow-up is next after the Phase 7 commit.
- Docker engine is available (`docker version --format '{{.Server.Version}}'` returned `29.8.0`).
- Current source/docs record Phases 0–9 as implemented or locally checked, with Phase 7 implemented, Phase 8 API adapters present, and Phases 10–12 open. This session must re-run checks before claiming current verification.
- Supabase files and live services remain out of scope; no data or volumes have been deleted.

## Completed

- Read `docs/PROJECT_CONTEXT.md`, `docs/MONGO_MIGRATION.md`, `docs/MONGO_DESIGN.md`, and `docs/MONGO_MIGRATION_INVENTORY.md`.
- Read `docs/MONGO_DECISIONS.md` and `docs/OWNER_STEPS.md`.
- Confirmed current branch and clean worktree; latest commit is `935d94d`.
- Confirmed `src/App.tsx` contains API-mode wiring and `vite.config.ts` plus `docs/DOCKER.md` use the documented Compose `:3000` default / host `:3001` override.
- Added `.gitattributes` rules for LF `.sh` and CRLF `.ps1`.
- `npm.cmd run lint`: exit 0.
- `npm.cmd test`: 264 tests, 253 passed, 0 failed, 11 skipped (Mongo integration cases are skipped by the root runner).
- `npm.cmd run build`: exit 0; existing Vite `__dirname` and large-chunk warnings remain.
- `npm.cmd --prefix server run test:security`: 9 passed, 0 failed, 0 skipped.
- `docker compose run --rm --no-deps api-test`: 11 real-Mongo tests passed, 0 failed, 0 skipped.

## Next actions

1. Run baseline lint, complete root tests, build, server security tests, and the Compose Mongo integration suite.
2. Inspect Phase 7 route coverage and Phase 8 API-mode checklist against current source; implement only demonstrable gaps.
3. Continue the setup/catalog, security, installer/backup, demo/manual-plan, and cutover-preparation steps from the supplied autopilot task.
4. Update this file and the migration/context documentation after each completed step; commit only each step's files and show its stat.

## Verification log

| Command | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---|
| `npm.cmd run lint` | n/a | n/a | n/a | Exit 0 |
| `npm.cmd test` | 253 | 0 | 11 | 264 total |
| `npm.cmd run build` | n/a | n/a | n/a | Exit 0 |
| `npm.cmd --prefix server run test:security` | 9 | 0 | 0 | Passed |
| `docker compose run --rm --no-deps api-test` | 11 | 0 | 0 | Passed against local Mongo replica set |

## Open risks

- No first-run setup wizard, setup-code lifecycle, starter catalog import workflow, shop installer/offline release pipeline, production Compose, backup/restore rehearsal, demo-mode acceptance, or cutover checklist has been verified in this session.
- Browser/manual printer and scanner acceptance and production/independent security testing remain owner-pending.

## Decisions

- Preserve existing product behavior and the legacy Supabase path until Phase 12; no destructive data or volume action is allowed.
- Treat previous documentation as historical evidence only; record new verification only from commands executed in this session.

## Session update — Phase 7 completion audit

- Step 0 was committed as `e7dce1e`; it is no longer pending.
- Added `/api/audit-logs`, protected by admin/super-admin role and `manage_users` permission. Query filtering is shop-scoped and date-filtered in the shop timezone. Only event/entity/actor identifiers and timestamp are projected; raw `before`/`after` fields are excluded.
- Current verification: root tests 264 total (253 passed, 0 failed, 11 skipped), lint and build exit 0, security suite 9/9, Compose Mongo suite 11/11.
- The Compose integration suite additionally proves manager-role denial, missing-permission denial, foreign-shop exclusion, and audit DTO omission of raw before/after content.
- Phase 7 change is awaiting its dedicated commit. Next: continue Phase 8 source checklist, then setup, installer/backup, demo/manual and cutover-preparation work.

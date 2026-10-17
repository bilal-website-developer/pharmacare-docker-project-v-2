# Autopilot State

## Current position

> Current position: first-run setup is committed as `029ee9e`; starter catalog code/data and tests pass current local checks and await commit. Phase 7 and Phase 8 implementation changes are committed; browser/manual acceptance remains outstanding. Continue with shop installer/release workflow, backup/restore, production packaging, demo/manual tests, and cutover preparation.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen.
- Current worktree contains starter catalog import/data/docs and a real-Mongo rollback/idempotency test.
- No `.env` values were read or printed. No Supabase files, volumes, remote branches, or live services were changed.

## Current verification evidence

| Command | Result |
|---|---|
| `docker compose run --build --rm --no-deps api-test` | 12 passed, 0 failed, 0 skipped |
| `npm.cmd test` | 272 total, 259 passed, 0 failed, 13 skipped |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0; existing Vite `__dirname` and chunk-size warnings |
| `npm.cmd --prefix server run test:security` | 9 passed, 0 failed, 0 skipped |
| `npm.cmd --prefix server run test:starter-catalog` | 2 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps api-test` | 13 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps --entrypoint node api -e "import('node:fs/promises').then(async ({readFile}) => { const rows = JSON.parse(await readFile('/app/data/starter-catalog.json', 'utf8')); console.log(JSON.stringify({starterCatalogEntries: rows.length})); })"` | Runtime image returned 20 entries |

The root test runner intentionally skips real-Mongo cases, which are exercised by the Compose test runner. The Compose suite includes one-time/concurrent setup, expiry and wrong-code rejection, password policy, Argon2id persistence, created defaults, and audit events. This is local verification, not shop-PC or production acceptance.

## Open risks and next work

- Commit the current starter catalog batch after final diff-scope checks and current docs are updated.
- The setup wizard currently requires `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; an installer that generates and displays a one-time code is still required.
- A local shop-PC install path still needs to create the per-shop Docker data environment and provision a one-time setup code without exposing secrets in logs or command history.
- Offline shop installer/release and uninstaller/update/restore scripts, scheduled backup/restore rehearsal, production Compose/TLS deployment docs, demo seed/manual role plan, and Phase 12 cutover checklist remain open.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

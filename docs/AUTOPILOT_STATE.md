# Autopilot State

## Current position

> Current position: first-run setup is committed as `029ee9e`; starter catalog is committed as `67c68d9`; the single-PC installer is implemented and awaits its documentation/commit. Phase 7 and Phase 8 implementation changes are committed; browser/manual acceptance remains outstanding. Continue with backup/restore, production packaging, demo/manual tests, and cutover preparation.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen, `029ee9e` first-run setup, `67c68d9` starter catalog.
- Current worktree includes loopback-only compose/installer docs and PowerShell setup changes.
- No `.env` values were read or printed. No Supabase files, volumes, remote branches, or live services were changed.

## Current verification evidence

| Command | Result |
|---|---|
| `npm.cmd test` | 272 total, 259 passed, 0 failed, 13 skipped |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0; existing Vite `__dirname` and chunk-size warnings |
| `npm.cmd --prefix server run test:security` | 9 passed, 0 failed, 0 skipped |
| `npm.cmd --prefix server run test:starter-catalog` | 2 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps api-test` | 13 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps --entrypoint node api -e "import('node:fs/promises').then(async ({readFile}) => { const rows = JSON.parse(await readFile('/app/data/starter-catalog.json', 'utf8')); console.log(JSON.stringify({starterCatalogEntries: rows.length})); })"` | Runtime image returned 20 entries |
| Installer PowerShell parser | Syntax parse passed |
| `docker compose config --quiet` | Exit 0 after loopback port binding |

The root test runner intentionally skips real-Mongo cases, which are exercised by the Compose test runner. The Compose suite includes one-time/concurrent setup, expiry and wrong-code rejection, password policy, Argon2id persistence, created defaults, and audit events. This is local verification, not shop-PC or production acceptance.

## Open risks and next work

- The setup wizard requires installer-provisioned `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; the current script sets them and displays the one-time code, but the real installation workflow remains unrun.
- The installer has not been run against an actual shop directory or data volume; only syntax and Compose config were checked. Offline release packaging, uninstaller/update/restore scripts, scheduled backup/restore rehearsal, production Compose/TLS deployment docs, demo seed/manual role plan, and Phase 12 cutover checklist remain open.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

# Autopilot State

## Current position

> Current position: first-run setup wizard and API bootstrap routes have been implemented locally but are not yet committed. Phase 7 and Phase 8 implementation changes are committed; browser/manual acceptance remains outstanding. Continue with catalog seed, shop installer/release workflow, backup/restore, production packaging, demo/manual tests, and cutover preparation.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen.
- Current worktree contains first-run setup changes plus test-only fixes to use the shop-local date in an expense assertion and to reflect the admin role's effective module permissions.
- No `.env` values were read or printed. No Supabase files, volumes, remote branches, or live services were changed.

## Current verification evidence

| Command | Result |
|---|---|
| `docker compose run --build --rm --no-deps api-test` | 12 passed, 0 failed, 0 skipped |
| `npm.cmd test` | 269 total, 257 passed, 0 failed, 12 skipped |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run build` | Exit 0; existing Vite `__dirname` and chunk-size warnings |
| `npm.cmd --prefix server run test:security` | 9 passed, 0 failed, 0 skipped |

The root test runner intentionally skips real-Mongo cases, which are exercised by the Compose test runner. The Compose suite includes one-time/concurrent setup, expiry and wrong-code rejection, password policy, Argon2id persistence, created defaults, and audit events. This is local verification, not shop-PC or production acceptance.

## Open risks and next work

- Finish and commit the current setup batch after updating migration/context/owner documentation.
- The setup wizard currently requires `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; an installer that generates and displays a one-time code is still required.
- Starter catalog import, offline shop installer/release and uninstaller/update/restore scripts, scheduled backup/restore rehearsal, production Compose/TLS deployment docs, demo seed/manual role plan, and Phase 12 cutover checklist remain open.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

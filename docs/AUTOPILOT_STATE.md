# Autopilot State

## Current position

> Current position: first-run setup is committed as `029ee9e`; starter catalog is committed as `67c68d9`; installer batch is committed as `d6207f1`; Phase 10 backup/production config is committed as `4f8993c`; Phase 11 demo seed/manual plan is committed as `dfff34a`. Phase 12 preparation is now written; manual/browser acceptance, production operations, and cut-over execution remain outstanding.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen, `029ee9e` first-run setup, `67c68d9` starter catalog.
- Current uncommitted worktree is the Phase 12 documentation batch; Phases 10 and 11 are committed.
- No `.env` values were read or printed; no existing Mongo data volume was deleted/reset; no Supabase files/data/schema, remote branches, or public services were changed. The local backup volume and empty Caddy volumes were created for validation.

## Current verification evidence

| Command | Result |
|---|---|
| `npm.cmd test` | Phase 11: 278 total, 265 passed, 0 failed, 13 skipped |
| `npm.cmd run lint` | Passed |
| `npm.cmd run build` | Passed; existing Vite `__dirname` and large-chunk warnings |
| `npm.cmd --prefix server run test:security` | Phase 10 baseline: 9 passed, 0 failed, 0 skipped |
| `npm.cmd --prefix server run test:starter-catalog` | Phase 10 baseline: 2 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps api-test` | Phase 10 baseline: 13 passed, 0 failed, 0 skipped; not rerun for demo seed |
| `npm.cmd run test:demo-seed` | 3 passed, 0 failed, 0 skipped |
| `docker compose config --quiet` with process-local fake required backup credentials | Passed |
| `docker compose run --build --rm --no-deps --entrypoint node api -e "import('node:fs/promises').then(async ({readFile}) => { const rows = JSON.parse(await readFile('/app/data/starter-catalog.json', 'utf8')); console.log(JSON.stringify({starterCatalogEntries: rows.length})); })"` | Runtime image returned 20 entries |
| Installer PowerShell parser | Syntax parse passed |
| `docker compose config --quiet` | Exit 0 after loopback port binding |
| `docker compose --profile backup run --rm mongo-backup backup-once` | Compressed archive created on local authenticated Mongo |
| `docker compose --profile backup --profile backup-restore run --rm mongo-backup restore-latest` | Per-collection counts matched on tmpfs scratch Mongo; 39 customer records |
| `docker compose --profile backup up --detach --wait --wait-timeout 90 mongo-backup` | Scheduled backup service became healthy; service was stopped afterward |
| `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup config --quiet` | Exit 0; parsed config confirms no web published ports and Caddy ports 80/443 only |
| Caddy `validate --config /etc/caddy/Caddyfile --adapter caddyfile` | `Valid configuration` |

The root test runner intentionally skips real-Mongo cases, which are exercised by the Compose test runner. The Compose suite includes one-time/concurrent setup, expiry and wrong-code rejection, password policy, Argon2id persistence, created defaults, and audit events. This is local verification, not shop-PC or production acceptance.

## Open risks and next work

- The setup wizard requires installer-provisioned `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; the current script sets them and displays the one-time code, but the real installation workflow remains unrun.
- The installer has not been run against an actual shop directory or data volume. Production Compose/TLS has only been parsed and Caddyfile validated; DNS, firewall, certificate issuance, real host deployment, off-host archive copy, and disaster-recovery targets remain untested. Demo seed has not been run against an isolated demo database; the human role plan is pending. Phase 12 checklist is preparatory only; no cut-over execution is approved or performed.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

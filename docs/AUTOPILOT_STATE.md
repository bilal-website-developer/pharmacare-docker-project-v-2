# Autopilot State

## Current position

> Current position: Step 1 checks passed locally on 2026-10-18, but the authorized push is blocked by missing noninteractive HTTPS credentials. Step 2 test directory `E:\ShopTest` was created as a local clone of the committed branch because remote cloning requires the same unavailable credentials; it has no `.env` or data directory. The original development Compose stack was stopped (not removed) to free port 8080. Next: run and inspect the installer in the test clone without exposing its one-time code.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen, `029ee9e` first-run setup, `67c68d9` starter catalog.
- Branch: `feature/mongo-migration`; latest code/document commits include Phase 10 `4f8993c`, Phase 11 `dfff34a`, and Phase 12 preparation `c47bef2`.
- Step 1 found `.env` lacked the new backup credential names, causing Compose commands to fail before parsing. Ran `docker\add-backup-credentials.ps1`; it generated and stored a random backup credential without displaying values. Rebuilt/reran `mongo-init`, which logged readiness and index completion and exited 0.
- `docker compose ps -a` showed Mongo healthy, API healthy, and `mongo-init` Exited (0). `curl.exe --silent --show-error --include http://localhost:8080/api/health` returned HTTP 200 and `{"status":"ok","database":"ok"}`.
- The already-running web container was bound to `0.0.0.0:8080`, although current Compose declares `127.0.0.1:8080`. Ran `docker compose up --detach --force-recreate web`; `docker compose port web 80` then returned `127.0.0.1:8080`.
- Tracked worktree was clean at step start. `.env` remains ignored. No `.env` values were displayed, no existing Mongo data volume was deleted/reset, and no Supabase data/schema or public service was changed.
- `git push origin feature/mongo-migration` failed with `Cannot prompt because user interactivity has been disabled` / `unable to get password`; authentication is owner-pending.
- Stopped (did not remove) the original Compose stack and created `E:\ShopTest` from the local committed branch. This clean source clone is not an authenticated clone of `origin`; it contains no `.env` and no Mongo data directory. The local-clone substitution was necessary because remote credentials are unavailable.

## Current verification evidence

| Command | Result |
|---|---|
| `npm.cmd test` | 278 total, 265 passed, 0 failed, 13 skipped |
| `npm.cmd run lint` | Passed |
| `npm.cmd run build` | Passed; existing Vite `__dirname` and large-chunk warnings |
| `npm.cmd --prefix server run test:security` | 9 passed, 0 failed, 0 skipped |
| `npm.cmd --prefix server run test:starter-catalog` | Phase 10 baseline: 2 passed, 0 failed, 0 skipped |
| `docker compose run --build --rm --no-deps api-test` | 13 passed, 0 failed, 0 skipped |
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
- The clean-clone installer test is in progress; no test-shop volume has been deleted. Production Compose/TLS has only been parsed and Caddyfile validated; DNS, firewall, certificate issuance, real host deployment, off-host archive copy, and disaster-recovery targets remain untested. Demo seed has not been run against an isolated demo database; the human role plan is pending. Phase 12 checklist is preparatory only; no cut-over execution is approved or performed.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

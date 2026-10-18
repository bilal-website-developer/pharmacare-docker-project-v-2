# Autopilot State

## Current position

> Current position: Fresh isolated installer run passed setup/login/refresh checks after fixing Compose `BOOTSTRAP_SHOP_SLUG` wiring. Current validation: lint/build passed; `npm.cmd test` 278 total (265 passed, 0 failed, 13 skipped); API security 9/9; real-Mongo Compose integration 13/13. Browser smoke displayed the Pharma Care login screen, but authenticated browser walkthrough is not complete: the browser-control tool could not select its page, and private test credentials were not placed in tool arguments. Production, real shop-PC, and human acceptance remain owner-pending; remote push remains blocked on HTTPS authentication.

- Branch: `feature/mongo-migration`.
- Recent commits: `e7dce1e` housekeeping, `9d3f0bb` admin audit-log endpoint, `d661142` API-unavailable retry screen, `029ee9e` first-run setup, `67c68d9` starter catalog.
- Branch: `feature/mongo-migration`; latest code/document commits include Phase 10 `4f8993c`, Phase 11 `dfff34a`, and Phase 12 preparation `c47bef2`.
- Step 1 found `.env` lacked the new backup credential names, causing Compose commands to fail before parsing. Ran `docker\add-backup-credentials.ps1`; it generated and stored a random backup credential without displaying values. Rebuilt/reran `mongo-init`, which logged readiness and index completion and exited 0.
- `docker compose ps -a` showed Mongo healthy, API healthy, and `mongo-init` Exited (0). `curl.exe --silent --show-error --include http://localhost:8080/api/health` returned HTTP 200 and `{"status":"ok","database":"ok"}`.
- The already-running web container was bound to `0.0.0.0:8080`, although current Compose declares `127.0.0.1:8080`. Ran `docker compose up --detach --force-recreate web`; `docker compose port web 80` then returned `127.0.0.1:8080`.
- Tracked worktree was clean at step start. `.env` remains ignored. No `.env` values were displayed, no existing Mongo data volume was deleted/reset, and no Supabase data/schema or public service was changed.
- `git push origin feature/mongo-migration` failed with `Cannot prompt because user interactivity has been disabled` / `unable to get password`; authentication is owner-pending.
- Stopped (did not remove) the original Compose stack and created `E:\ShopTest` from the local committed branch. This clean source clone is not an authenticated clone of `origin`; it contains no `.env` and no Mongo data directory. The local-clone substitution was necessary because remote credentials are unavailable.
- The installer created an isolated test shop, and its first-run setup completed. Login using the requested slug `shoptest` failed, while login using persisted slug `main` succeeded as `super_admin`. Read-only container inspection confirmed `BOOTSTRAP_SHOP_SLUG` was missing from the API environment. Added that environment mapping to both `api` and `api-test`, and added an integration assertion that the created shop slug equals `bootstrapShopSlug`. Focused Compose-config check reports slug propagation for both profiles.
- Installer retries in `E:\ShopTest` and `E:\ShopTest2` were stopped without deleting their containers or volumes. The successful setup credentials are test-only and stored at `E:\TEST_CREDENTIALS.local.txt`; no values were displayed.
- After commit `deec3c6`, cloned into `E:\ShopTest2\retry` with no `.env`, reran `.\docker\install-shop.ps1 -ShopSlug shoptest`, and captured the new test-only code/password outside the repository without displaying them. Installer exited 0. `docker compose ps -a` showed Mongo healthy, mongo-init Exited (0), API healthy, and web healthy. `docker compose port web 80` returned `127.0.0.1:8080`; Mongo inspect showed `{"27017/tcp":null}`; health returned status/database `ok`.
- Clean install API checks: `/api/setup/status` initially `needsSetup=true`; first setup HTTP 201; after setup `needsSetup=false`; second setup HTTP 409; wrong setup code HTTP 403; login using `shoptest` HTTP 200; refresh HTTP 200; `/api/auth/me` HTTP 200 as `super_admin`; refresh cookie had HttpOnly, Secure, and SameSite=Strict.
- Browser UI smoke: `http://localhost:8080` loaded the Pharma Care sign-in view with email/password inputs and sign-in button. Authenticated screen automation did not run because browser page selection failed; credentials were not passed to browser tool calls. This is not manual acceptance.

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

- The successful pristine test install at `E:\ShopTest2\retry` was stopped after verification with `docker compose stop`; no containers or volumes were deleted. The external test-only credential file `E:\TEST_CREDENTIALS.local.txt` was removed by exact path. Earlier incomplete test stacks are stopped and their named volumes retained. Production Compose/TLS has only been parsed and Caddyfile validated; DNS, firewall, certificate issuance, real host deployment, off-host archive copy, and disaster-recovery targets remain untested. Demo seed has not been run against an isolated demo database; the full human role plan is pending. Phase 12 checklist is preparatory only; no cut-over execution is approved or performed.
- Manual browser, LAN, printer/scanner, production, independent security, and legal acceptance remain owner-pending. Do not claim these are verified.

## Decisions

- Preserve the Supabase implementation until Phase 12 preparation is complete and explicit cut-over approval is given.
- Each run's verification must be recorded from current-session command output; skipped tests are not passes.
- The first-run route consumes a one-time setup marker transactionally and accepts only a hash-configured, expiring setup code. The future installer owns code generation/display and must never log or persist the plaintext code.

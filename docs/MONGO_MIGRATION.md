# MongoDB Migration Phase Tracker

This file tracks migration phase deliverables and verification. It does not authorize database access, deployment, data deletion, or cut-over.

## Phase status

| Phase | Deliverable | Status | Verification / gate |
|---:|---|---|---|
| 0 | Read-only source inventory | Complete, committed as `eb9dd0c` | [`MONGO_MIGRATION_INVENTORY.md`](./MONGO_MIGRATION_INVENTORY.md); source-only. Live Supabase state remains unverified. |
| 1 | Mongo collection/API design and threat model | Drafted; awaiting owner approval | [`MONGO_DESIGN.md`](./MONGO_DESIGN.md), [`MONGO_THREAT_MODEL.md`](./MONGO_THREAT_MODEL.md). No code or database changes. |
| 2 | Docker/API foundation | Implemented locally; awaiting owner-run Compose verification | At Phase 2 completion this provided the health-only Fastify skeleton. Owner-run Compose verification is still pending. |
| 3 | Authentication and Manage Users API | Implemented locally; awaiting owner-run Docker/runtime verification | Auth/session routes, authorization middleware, policy-aligned user routes, bootstrap CLI, and tests are in `server/`. This does not cut over the frontend or implement business modules. |
| 4 | Catalog, product, and supplier API | Implemented locally; tests/build pass | Mongo/Docker runtime and live route verification are not performed. Route tests use in-memory repositories. |
| 5 | Purchases and stock API | Implemented locally; source tests pass, owner runtime proof pending | Purchase posting/void, stock queries, adjustments, write-off, alert summary, and lazy expiry status refresh are in `server/`; Mongo transaction/runtime behavior is not verified. |
| 5b | Mongo replica-set verification and write idempotency | Implemented locally; real-Mongo verification blocked | API image built, but the integration suite could not connect. `docker compose ps` reports Mongo unhealthy; the healthcheck reports authentication failure for the configured root user. No Docker files or volumes were changed. Timezone choice is open. |
| 6+ | Remaining business API implementation | Not started | Preserve the Phase 2 Docker verification gate; implement transactions for every multi-document business write. |
| 12 | Cut-over and Supabase cleanup | Blocked on explicit approval after all manual tests pass | Never delete `supabase/` or migrations; cut-over plan requires owner approval. |

## Phase 1 verification and open items

- Design documents specify collection fields/types, per-shop indexes, transaction boundaries, numbering, role/permission requirements, endpoint contracts, DTO redaction, and the requested top 15 threats/controls.
- No API, MongoDB collection/index, Docker service, Supabase migration, or application code was created or changed.
- Design decisions still requiring approval are listed in `MONGO_DESIGN.md`, especially sale-void policy, purchase-void authorization, naming uniqueness, prescription evidence/retention, external cash refund settlement, user cap/return defaults, and role defaults.
- Frontend `npm run lint`, `npm test` (18 scripts, 122 tests), and `npm run build` passed on the unchanged application baseline; the build reports existing Vite `__dirname` and large-chunk warnings. These checks do not exercise or verify the proposed API, database, Docker, or threat controls.
- No live database checks, container checks, or threat-control implementation have been performed for this documentation phase.

## Phase 2 status

- Added a replica-set MongoDB service with keyfile authentication, root credentials from `.env`, no published Mongo port, named data volume, and healthcheck.
- Added a one-shot initializer for replica set setup, app-only `readWrite` user, and shop-scoped indexes; API health-only skeleton; Nginx web proxy; and PowerShell secret generator. Existing Supabase frontend code remains unchanged.
- Local `npm run lint`, `npm test` (126 tests across 20 test files), and `npm run build` passed. `npm audit --prefix server` reported zero vulnerabilities; `docker compose config --quiet` passed with fake process-only values; and the secret-generator PowerShell syntax parse passed. The frontend build still reports its pre-existing Vite `__dirname` and large-chunk warnings.
- No Docker image was built and no container was started. Mongo replica-set/auth initialization, container networking, Nginx proxying, and the HTTP health response remain unverified until the owner runs Compose and supplies output. Do not claim Docker works before that verification.

## Phase 3 status

- Implemented Mongo-backed login, refresh rotation/reuse detection, logout, `/me`, access-token authentication, role/permission checks, user list/create/update/delete/restore/reset-password routes, Manage Users policy safeguards, audit/trash records, and an interactive `seed:superadmin` command. The command refuses to bootstrap a shop that already has users and persists only an Argon2id hash.
- API DTOs are built from explicit field allowlists; login failures are generic; refresh tokens are stored as keyed hashes; user writes and corresponding audit events use Mongo transactions. Shop scope comes from the authenticated user, not request input.
- `npm run lint`, `npm test` (152 tests across frontend and API), and `npm run build` passed locally; `npm audit --prefix server` reported 0 vulnerabilities. The Vite build emitted the existing `__dirname` and large-chunk warnings. Route tests use an in-memory repository and do not prove Mongo transaction/runtime behavior.
- No Compose container, live database, or deployment was run. Owner-run Docker health/auth checks remain open. Existing React screens continue to use Supabase; cut-over is not part of this phase.

## Phase 4 status

- Implemented shop-scoped CRUD, paging/search/filter/sort, and allowlisted DTOs for categories, brands, medicines, medicine units, and suppliers. Soft-delete/restore writes trash history and audit events; barcode assignment uses EAN-13 and a shared per-shop claim registry; bounded product CSV import reports row errors and export redacts cost for callers without cost access.
- Mongo index initialization now includes per-shop normalized medicine-name and medicine-unit-name uniqueness. `medicineUnits` is a separate collection (rather than the embedded units in the original proposal) to support requested independent CRUD, barcode ownership, and per-medicine uniqueness; see `MONGO_DESIGN.md`.
- Local root lint, complete tests, and frontend/API build pass. The focused catalog suite covers input validation, duplicate handling, cost DTO/CSV filtering, CSV row errors, soft-delete/restore, and concurrent barcode assignment. Frontend build retains the existing `__dirname` and large-chunk warnings.
- No MongoDB container, live database, or Docker Compose runtime was used. Transaction behavior, installed indexes, and network/runtime behavior remain unverified pending owner-run Docker checks; this phase does not cut over the Supabase frontend.

## Phase 5 status

- Implemented purchase catalog/history/detail, purchase posting and guarded voiding, stock overview/expiry buckets/batches/adjustment log, stock adjustment, expired-batch write-off, and permission-gated stock-alert summaries. Business reads use the authenticated user's shop ID; DTOs are allowlisted, and cost-bearing fields are omitted unless role-and-permission policy allows them.
- Mongo purchase, void, adjustment, and write-off mutations use one Mongo session transaction for their stock/supplier/ledger/cash-book/audit writes. Purchase numbering uses an atomic per-shop counter in that transaction; sequential uniqueness is promised, not gap-free numbering. Purchase void is restricted to Admin/Super Admin with `purchases` and is rejected after any post-receipt movement or quantity change.
- Stock statuses are lazily refreshed on stock overview, expiry-bucket, and batch reads. The current expiry-day boundary is UTC; `NEAR_EXPIRY` means through 90 days inclusive. Purchase expiry must be after the purchase date; negative stock and writing off non-expired batches are rejected.
- Local tests use the in-memory repository, including injected mid-write failure/rollback simulation. They do not exercise a Mongo replica set or prove server transaction rollback, installed indexes, or API/container runtime behavior. Docker was not started and no live database was accessed. Owner-run Docker/HTTP proof remains required; Supabase frontend paths are unchanged.
- Root `npm run lint`, `npm test`, and `npm run build` passed. The build retains existing Vite `__dirname` and large-chunk warnings.
- Phase 5b adds required `Idempotency-Key` headers to authenticated business write routes, scoped by authenticated shop and route. Only a SHA-256 hash of the key is stored; successful response status/body are retained for 24 hours and replayed for a matching request. Reusing a key with a different request or while its first request is processing returns a generic conflict. Failed responses release the reservation. `/api/auth/*` is deliberately excluded because login/refresh responses contain credentials and logout has cookie side effects; session endpoints need a separate credential-safe retry contract.
- `mongo-init` removes the obsolete `shop_idempotency_unique` index before creating the new shop/route/key-hash unique index. Existing records are not deleted.
- Idempotency reservation/completion currently brackets, but is not part of, the business Mongo transaction. A process failure after a business transaction commits but before its response is saved leaves the key in `PROCESSING` until its 24-hour expiry; retry is denied rather than re-executed, but the original response cannot be replayed. This crash window must be closed before production write traffic.
- `server/integration/mongo.integration.mjs` contains replica-set integration tests for mid-transaction purchase post/void rollback, per-shop code/barcode uniqueness, competing stock adjustments, and successful idempotency replay. Run `docker compose run --rm api npm run test:mongo-integration` after rebuilding the API image and applying `mongo-init`. `npm test` includes this test file but skips its database cases when required Mongo environment variables are not configured.
- The Compose integration attempt in this session built `pharma-care-api:local` successfully, then all four integration cases failed in the shared `before` hook with `MongoServerSelectionError: Server selection timed out after 30000 ms`. `docker compose ps` showed `mongo` as unhealthy; its healthcheck output was `MongoServerError: Authentication failed` (the root user was not found in `admin`). Resolve this existing runtime issue without deleting the data volume, then rerun the replica-set tests. No database fixture writes were made because the test client could not connect.

## Expiry timezone decision (owner input required)

The current API compares expiry dates using UTC calendar days. Select the business-day interpretation before changing this behavior:

- **Option A — fixed `Asia/Karachi`:** every shop uses Pakistan local midnight for “today” and expiry-day status; simplest for the current deployment context, but not suitable for shops in other time zones.
- **Option B — per-shop IANA timezone, default `Asia/Karachi`:** store a validated timezone on each shop and derive “today” for every expiry/status calculation from that shop’s zone; supports future multi-region shops and requires timezone-aware date conversion/tests.
- **Option C — UTC:** retain the existing UTC calendar boundary and explicitly define all expiry dates as UTC calendar dates; smallest change, but may make a batch appear expired earlier/later than the shop’s local business day.

No timezone option has been selected or implemented. Until a decision is made, source behavior remains UTC.

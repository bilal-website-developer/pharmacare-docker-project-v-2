# MongoDB Migration Phase Tracker

This file tracks migration phase deliverables and verification. It does not authorize database access, deployment, data deletion, or cut-over.

## Phase status

| Phase | Deliverable | Status | Verification / gate |
|---:|---|---|---|
| 0 | Read-only source inventory | Complete, committed as `eb9dd0c` | [`MONGO_MIGRATION_INVENTORY.md`](./MONGO_MIGRATION_INVENTORY.md); source-only. Live Supabase state remains unverified. |
| 1 | Mongo collection/API design and threat model | Drafted; awaiting owner approval | [`MONGO_DESIGN.md`](./MONGO_DESIGN.md), [`MONGO_THREAT_MODEL.md`](./MONGO_THREAT_MODEL.md). No code or database changes. |
| 2 | Docker/API foundation | Implemented locally; awaiting owner-run Compose verification | At Phase 2 completion this provided the health-only Fastify skeleton. Owner-run Compose verification is still pending. |
| 3 | Authentication and Manage Users API | Implemented locally; awaiting owner-run Docker/runtime verification | Auth/session routes, authorization middleware, policy-aligned user routes, bootstrap CLI, and tests are in `server/`. This does not cut over the frontend or implement business modules. |
| 4+ | Business API implementation | Not started | Preserve the Phase 2 Docker verification gate; cover business routes in later phases. |
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

# Control Plane Design

Status: Design basis for an implementation in progress. Steps 1-8 are implemented locally; step 9 (host updater) and steps 10-14 are not complete. Step 8's bundle build and image scan passed locally, but detached signing was not run because OpenSSL is unavailable. See `docs/CONTROL_PLANE_STATE.md` for current evidence and gaps. No real Supabase project has been configured.

## 1. Scope and design intent

This design covers the developer control plane, the per-shop licence model, support access, release distribution, and update behaviour for a multi-shop pharmacy rollout.

The system is intentionally split into two trust zones:

- Control plane: developer-owned Supabase project controlling shops, licences, devices, security audits and release approvals.
- Shop environment: a local Docker stack running on the shop admin PC, with business data retained in the shop's own database and worker PCs accessing through LAN only.

The control plane never pushes into a shop. A shop proves itself by calling out to the control plane using a device key and signed licence state.

---

## 2. Fixed design decisions

These are owner-approved and form the baseline for all implementation work:

- One developer Super Admin exists only in a separate control-plane Supabase project with Supabase Auth and 2FA.
- Shop staff passwords stay in the shop database, hashed with Argon2id.
- Shop admin emails are recorded in the control plane without stored passwords.
- The local `super_admin` role and first-run super-admin creation are removed from all shop installs.
- Shop devices authenticate via per-device key hashed in the control plane; no general Supabase key is distributed to shops.
- The owner selects per-shop plan type, start date, expiry, max PCs, offline grace, warning days and renewal notice days.
- When the owner adds a shop admin, they choose the plan type (monthly, yearly, one_time), expiry, offline_grace_days (default 14, allowed 1-60), warning_days (default 7, allowed 0-30), and renewal_notice_days (default 7, allowed 0-30).
- All licence values are server-validated and signed with Ed25519.
- Licence expiry transitions are: renewal notice, warning period, inactive mode, then manually reactivated by a new signed licence.
- Inactive mode blocks new sales, purchases and stock changes; a one-time API-issued sale-draft token opened before inactivity allows completion within 60 minutes.
- A one-time plan never expires and is immune to offline-time blocking.
- The developer never uses a shop's real password and support uses a 6-digit code valid 30 minutes with scopes diagnostics, read_only and admin_actions.
- Support access never uses the shop admin's real password. It uses a one-time support code and signed support token with scoped access.
- Updates are signed, approved, versioned, and installed only with verified backups and rollback.
- Cashier and manager devices run in LAN mode only; Mongo remains unpublished.

---

## 3. Architecture

```text
Developer browser
  |
  | Supabase Auth + 2FA
  v
Control Plane (Supabase project)
  - Postgres: shops, licences, devices, admins, releases, audit
  - Edge Functions: activate, heartbeat, get-licence, get-release, support-allow, support-token, support-end, create-shop, extend-licence, suspend, change-plan, approve-release, withdraw-release
  - Storage: signed bundle storage
  |
  | HTTPS outbound only
  v
Shop Admin PC (internet-connected)
  - Docker: web + API + Mongo + updater
  - Local secrets: device key, signed licence, public signing key
  |
  +-- LAN client PCs (cashier/manager) browser only
  |
  +-- Local business data in Mongo
```

### 3.1 Trust boundaries

1. Developer trust boundary
   - Browser access to the control plane is limited to the developer's authenticated account.
   - Service-role access and private signing key material are not stored in repo, image, shop or browser.

2. Shop trust boundary
   - Business data remains local to the shop.
   - The shop may receive a signed licence and release metadata but cannot self-issue a valid licence or bypass signature checks.

3. LAN client trust boundary
   - Worker PCs never hold a private key or licence signing key.
   - They only access the admin PC over HTTPS via a local certificate and browser.

---

## 4. Threat model

### 4.1 Control plane threats

- Unauthorized developer access
  - Mitigation: unique password, 2FA, recovery written on paper offline, strict RLS, least-privilege roles, audit logging.

- Shop impersonation
  - Mitigation: device key hashed and scoped to one shop; every request includes device identity and shop ID.

- Licence tampering
  - Mitigation: Ed25519-signed JSON, public key embedded in shop image, signature validation before activation and every check-in.

- Storage abuse or bundle tampering
  - Mitigation: short-lived signed URLs, SHA256 verification, expected bundle manifest, release approval states.

### 4.2 Shop-device threats

- Offline tampering or clock rollback
  - Mitigation: last-seen timestamp and local clock guard; if the system clock moves backwards by more than one day, the app uses last-seen and shows a clock warning.

- Local data theft
  - Mitigation: shop DB stays on the admin PC; LAN workers are browser-only; no Mongo port is published.

- Untrusted update payload
  - Mitigation: signature + SHA256 verification before install; automatic rollback on health check failure.

### 4.3 Support-session threats

- Password leakage
  - Mitigation: no support flow requests a shop password; support code is one-time and the shop admin approves the support scopes.

- Overbroad support access
  - Mitigation: scopes are restricted to `diagnostics`, `read_only`, or `admin_actions`; tokens expire within 30 minutes unless re-approved.

- Data exposure while in support mode
  - Mitigation: masked diagnostics by default, audit rows on both sides, session stop button, approval required before each session.

### 4.4 Update-channel threats

- Malicious or broken release
  - Mitigation: draft/approved/withdrawn states, signed URLs, verification, maintenance window, backup-first, rollback.

- Partial installation or interrupted update
  - Mitigation: rollback to prior image set, health checks, version retention, update state logging.

---

## 5. Data model and access rules

### 5.1 Core tables

```text
shops
- id
- name
- slug
- owner_name
- phone
- city
- timezone
- status
- created_at

licences
- id
- shop_id
- plan_type
- starts_at
- expires_at nullable
- max_pcs
- offline_grace_days
- warning_days
- renewal_notice_days
- status
- updated_at

activation_codes
- id
- shop_id
- code_hash
- expires_at
- used_at

devices
- id
- shop_id
- device_key_hash
- device_name
- app_version
- last_seen_at
- status

shop_admins
- id
- shop_id
- email
- full_name
- status

support_sessions
- id
- shop_id
- scope
- code_hash
- expires_at
- approved_by_shop_admin
- started_by_developer
- ended_at

releases
- id
- version
- channel
- bundle_path
- sha256
- signature
- notes
- status
- approved_at

release_rollouts
- shop_id
- release_id
- state
- updated_at

audit_log
- id
- actor
- action
- shop_id
- detail
- created_at
```

### 5.2 RLS and security rules

All private tables must use RLS. Authenticated shop user roles and developer roles are separate by project and context. The anon role must read zero rows from private tables.

Required invariants:

- `anon` cannot read any private table.
- All writes to `licences`, `releases`, `support_sessions`, and `audit_log` are restricted to developer-controlled roles or service functions.
- A shop device may only access rows for its own `shop_id`.
- A device key is stored as a hash only. The raw key is never persisted.
- Every action that changes business status must append to `audit_log`.

### 5.3 Per-table RLS summary

| Table | Required access | Policy intent |
| --- | --- | --- |
| `shops` | Developer reads/writes, device may read only own shop metadata | Shop registry is private to the developer and the owning shop |
| `licences` | Developer writes; device reads only current signed licence for its own shop | Prevent licence tampering and enforce expiry logic |
| `activation_codes` | Developer creates and marks used; device may never read code values | One-time activation secret must not be exposed |
| `devices` | Device can read and update its own record; developer can manage all devices | Device identity is scoped to one shop |
| `shop_admins` | Developer manages list; admin may read own record only | Store admin contact and approval state without passwords |
| `support_sessions` | Developer creates token records; shop admin can approve or terminate own shop sessions | No secret or broad support access |
| `releases` | Developer approves/releases; devices read only approved current bundle metadata | Release channel must remain auditable |
| `release_rollouts` | Device updates only own rollout record; developer reads all | Track per-shop rollout state | 
| `audit_log` | Append-only; developer and shop-facing service functions write; reads limited by role | Proof of licence, update, and support actions |

### 5.4 Policy examples

```sql
-- Example only; implementation details are design-level
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE licences ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

-- dev-only or service function access
CREATE POLICY "dev_manage_licences"
ON licences
FOR ALL
TO authenticated
USING (auth.jwt() ->> 'role' = 'developer')
WITH CHECK (auth.jwt() ->> 'role' = 'developer');

-- shop-scoped device access
CREATE POLICY "shop_device_access"
ON devices
FOR SELECT
TO authenticated
USING (shop_id = get_current_shop_id());
```

### 5.5 Security tests required

- anon gets zero rows from every private table
- shop A device cannot read or mutate shop B rows
- only developer role can write `licences` and `releases`
- device key hash must be used instead of raw device key
- support session scopes honor approval and expiry
- failed signed licence is rejected

---

## 6. Formats and signed payloads

### 6.1 Licence format

The licence is a signed JSON payload produced by the control plane and verified locally in the shop app.

```json
{
  "shop_id": "uuid",
  "plan_type": "monthly",
  "starts_at": "2026-10-18T00:00:00Z",
  "expires_at": "2026-11-18T00:00:00Z",
  "max_pcs": 3,
  "offline_grace_days": 14,
  "warning_days": 7,
  "renewal_notice_days": 7,
  "issued_at": "2026-10-18T09:00:00Z",
  "nonce": "random-128-bit-string"
}
```

### 6.2 Support code format

```json
{
  "shop_id": "uuid",
  "code": "123456",
  "expires_at": "2026-10-18T11:00:00Z",
  "scope": "diagnostics|read_only|admin_actions",
  "issued_at": "2026-10-18T10:30:00Z"
}
```

The support code is a 6-digit code valid for 30 minutes. The code is issued only after the shop admin approves support and is never accepted beyond its expiry.

### 6.3 Support token format

```json
{
  "shop_id": "uuid",
  "device_id": "uuid",
  "scope": "diagnostics",
  "issued_at": "2026-10-18T10:30:00Z",
  "expires_at": "2026-10-18T11:00:00Z",
  "session_id": "uuid",
  "nonce": "random-128-bit-string"
}
```

The token is signed and validated by the shop before any read-only or admin support action is allowed.

### 6.4 Release manifest format

```json
{
  "version": "2.4.1",
  "channel": "stable",
  "bundle_url": "https://example.invalid/releases/2.4.1.tgz",
  "sha256": "<hash>",
  "signature": "<ed25519-signature>",
  "notes": "Release notes",
  "created_at": "2026-10-18T00:00:00Z"
}
```

### 6.5 One-time reset code format

```json
{
  "shop_id": "uuid",
  "reset_code": "654321",
  "expires_at": "2026-10-18T11:00:00Z",
  "purpose": "password_reset",
  "issued_at": "2026-10-18T10:30:00Z"
}
```

The one-time reset code is single-use, short-lived, and never stored as plaintext in the app or audit log.

---

## 7. API contract for Edge Functions

### 6.1 `activate`

Request:

```json
{
  "activation_code": "string",
  "device_name": "string",
  "app_version": "string",
  "device_key": "string"
}
```

Response:

```json
{
  "shop_id": "uuid",
  "shop_name": "string",
  "device_id": "uuid",
  "licence": {
    "plan_type": "monthly|yearly|one_time",
    "starts_at": "2026-10-18T00:00:00Z",
    "expires_at": "2027-10-18T00:00:00Z",
    "max_pcs": 3,
    "offline_grace_days": 14,
    "warning_days": 7,
    "renewal_notice_days": 7,
    "signature": "ed25519-signature"
  },
  "shop_settings": {
    "timezone": "Asia/Karachi",
    "offline_grace_days": 14,
    "warning_days": 7,
    "renewal_notice_days": 7
  }
}
```

Errors:

- invalid code
- expired code
- too many attempts
- duplicate device registration
- unsupported app version

Rate limits:

- 5 attempts per 10 minutes per IP
- 1 activation per code

### 6.2 `heartbeat`

Request:

```json
{
  "shop_id": "uuid",
  "device_id": "uuid",
  "device_key": "string",
  "app_version": "string",
  "now": "2026-10-18T10:00:00Z"
}
```

Response:

```json
{
  "status": "active|warning|inactive|suspended",
  "licence_valid": true,
  "renewal_notice_active": false,
  "release": {
    "version": "2.4.1",
    "channel": "stable",
    "approved": true,
    "download_url": "https://..."
  },
  "next_check_in_seconds": 21600
}
```

### 6.3 `get-licence`

Request:

```json
{
  "shop_id": "uuid",
  "device_id": "uuid",
  "device_key": "string"
}
```

Response:

```json
{
  "licence": { "...signed-json..." },
  "status": "active"
}
```

### 6.4 `get-release`

Request:

```json
{
  "shop_id": "uuid",
  "device_id": "uuid",
  "device_key": "string",
  "channel": "stable|pilot",
  "current_version": "2.4.0"
}
```

Response:

```json
{
  "available": true,
  "version": "2.4.1",
  "manifest": {
    "sha256": "...",
    "signature": "...",
    "bundle_url": "https://...",
    "notes": "..."
  }
}
```

### 6.5 `support-allow`

Request:

```json
{
  "code": "six-digit one-time code",
  "scope": "diagnostics|read_only|admin_actions"
}
```

Response:

```json
{
  "session_id": "uuid",
  "expires_at": "timestamp"
}
```

The shop authenticates this request with its device key hash. The raw code is returned only by the shop's authenticated `POST /api/support/allow`; only its hash is persisted.

### 6.6 `support-token`

An authenticated developer with Supabase AAL2 submits `shop_id`, `code`, and `scope`. The function verifies the one-time code hash and approved scope, stores the signed token hash, and returns `{ "token": "signed-token" }`. The token is Ed25519-signed and contains the session ID, shop ID, scope, issue time and expiry.

### 6.7 `support-end`

The shop device submits the support session UUID. The function ends only an unended session belonging to that device's shop and appends an audit row.

Errors:

- support code invalid or expired
- device not registered or not associated with the session's shop
- scope not approved by shop admin
- too many token requests

---

## 8. Licence state machine

### 8.1 Signed licence payload

A valid licence is a JSON object signed by Ed25519. The shop must verify signature before accepting it.

```json
{
  "shop_id": "uuid",
  "plan_type": "monthly",
  "starts_at": "2026-10-18T00:00:00Z",
  "expires_at": "2026-11-18T00:00:00Z",
  "max_pcs": 3,
  "offline_grace_days": 14,
  "warning_days": 7,
  "renewal_notice_days": 7,
  "issued_at": "2026-10-18T09:00:00Z",
  "nonce": "random-128-bit-string"
}
```

Rules:

- `plan_type` is one of `monthly`, `yearly`, `one_time`.
- `one_time` has no expiry date.
- `monthly` and `yearly` expiry must be a valid future or current date.
- `offline_grace_days` is 1 to 60.
- `warning_days` is 0 to 30.
- `renewal_notice_days` is 0 to 30.
- Shop never accepts unsigned or tampered licence JSON.

### 8.2 State machine

```text
ACTIVE
  -> renewal notice when now >= expires_at - renewal_notice_days
  -> warning when now >= expires_at
  -> inactive when now > expires_at + warning_days

warning
  -> active if licence is extended by new signed licence
  -> inactive when now > expires_at + warning_days

inactive
  -> active when a valid new licence is accepted
  -> suspended if the owner manually marks the shop suspended

suspended
  -> active when valid licence is reissued and accepted
```

Business behaviour by status:

- active: full business operations allowed
- renewal notice: admin only sees reminder, no block to sales
- warning: admin and manager see warning, business still works
- inactive: new sales, purchases, and stock changes blocked; login/view/print/reports/backups continue; in-progress sale can complete
- suspended: same as inactive, plus a manual suspension message and owner-specific audit entry

### 8.3 Date and clock rules

- If the device clock moves backwards by more than 1 day, the app uses the last-seen time and a clock warning is shown.
- Shop-local timezone defaults to `Asia/Karachi`.
- Expiry computations use the server-issued timestamp and local date boundary for the shop timezone.

### 8.4 Test table

| Scenario | Expected result |
| --- | --- |
| Valid monthly licence before renewal notice | active |
| Expires within renewal notice window | renewal notice |
| Expiry reached, warning window active | warning |
| Warning window ended | inactive |
| Valid new licence received | active |
| One-time plan with no expiry | active always |
| Offline > grace days | warning shown only |
| Shop manually suspended | suspended/inactive behaviour |
| Tampered licence signature | reject and keep previous valid state |
| Device clock moved back > 1 day | last-seen fallback and warning |

---

## 9. Support access and audit model

### 9.1 Support flow

1. A shop admin calls the device-authenticated `support-allow` operation with an approved scope. The shop server generates a six-digit code valid for 30 minutes.
2. The raw code is returned once; Mongo and the control plane persist only its SHA-256 hash. The code-bearing response is excluded from the shop API idempotency cache.
3. An authenticated developer with Supabase AAL2 redeems the code once using `support-token`.
4. The control plane signs a scope-, shop- and expiry-bound token with Ed25519; the control plane stores only the token hash.
5. The shop server verifies the signature using `SUPPORT_TOKEN_PUBLIC_KEY`, then checks the local support-session record, shop binding, expiry and granted scope on every request. It binds the first accepted token by hash.
6. The shop admin can end the session locally; the shop also asks the control plane to end it. Local enforcement rejects requests after ending even if the remote end call fails.

### 9.2 Allowed scopes

- `diagnostics`: the masked diagnostics report only
- `read_only`: diagnostics plus the current allowlisted read-only report (currently the same aggregate report)
- `admin_actions`: diagnostics, read-only report and the currently implemented licence-refresh action

Reading shop screens, password resets, backup triggers and service restarts are not implemented. The direct relay/screen-support path is also not implemented.

### 9.3 Audit requirements

The local audit log records approval, first use, diagnostics/read-only access, licence refresh and end-session events. The control-plane audit log records approval, developer start and end events. Records contain session IDs/scopes but never the code or token.

### 9.4 Implementation boundary

The API endpoints are implemented and tested locally, but external support access still requires a reachable shop API. A deployed Supabase project, internet/NAT relay, support UI, and real-shop acceptance remain future work.

---

## 10. Releases, approvals and auto-update

### 10.1 Release states

```text
draft -> approved -> stable/pilot -> withdrawn
```

- `draft`: bundle created and signed but not live to shops
- `approved`: available for a channel but not yet forced to all shops
- `withdrawn`: removed from active rollout and flagged to shops

### 10.2 Release bundle format

```json
{
  "version": "2.4.1",
  "channel": "stable",
  "bundle_path": "https://...",
  "sha256": "...",
  "signature": "...",
  "notes": "...",
  "created_at": "2026-10-18T08:00:00Z"
}
```

### 10.3 Successful update sequence

1. Developer builds a release and signs it.
2. Control plane stores the bundle and manifest.
3. Shop heartbeat fetches approved release for its channel.
4. Update waits for maintenance window (02:00–05:00 local shop time) unless admin selects “Update now”.
5. Verified backup is created.
6. Bundle downloads and verifies SHA256 and signature.
7. New images load and migration runs.
8. Health check and smoke test are executed.
9. If health fails, rollback to previous image set and backup.

### 10.4 Failure and rollback rules

- Never update during active trading if the admin has not approved a manual window.
- Keep the previous two versions locally.
- A failed install must restore last-known-good state automatically.
- Rollback result is written to `release_rollouts` and `audit_log`.

---

## 11. LAN mode and local deployment

### 11.1 Admin PC

- Fixed local IP and hostname such as `pharmacy-server`.
- Internal HTTPS certificate created during install.
- Service is private to the LAN only.
- Mongo remains unpublished and not exposed to the internet.

### 11.2 Client PCs

- Use browser-only access over LAN.
- Trust the internal CA certificate once during setup.
- No installation or private keys required.

### 11.3 Security hardening

- Windows Firewall allows only Private network access.
- MongoDB is not published.
- The app should never allow plain HTTP to the admin PC over IP.
- Secure cookie settings are used and browser must use HTTPS.

---

## 12. File impact list for Phase B and later

This is the minimal file-impact list for the next implementation phase.

### 12.1 Auth and control plane

- `supabase/config.toml`
- `supabase/migrations/*`
- `supabase/functions/*`
- `docs/OWNER_STEPS.md`
- `docs/PROJECT_CONTEXT.md`

Reason: create developer auth, RLS rules, stored procedures, and audit tables.

### 12.2 Setup and installer

- `docker/`
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.prod.yml`
- `scripts/`

Reason: generate installation scripts, activation code wiring, device key behaviour, HTTPS/certificate provisioning.

### 12.3 Shop app and API

- `server/src/auth-*`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/phase7-routes.ts`
- `server/src/models.ts`

Reason: activation, heartbeat, signed licence verification, support token validation, and local machine identity handling.

### 12.4 UI and control panel web app

- `src/App.tsx`
- `src/components/*`
- `src/permissions.tsx`
- `control-plane/panel/`

Reason: The shop UI provides activation setup, role-filtered licence-state banners and an admin-only Allow Support/end-session page. The standalone developer panel gates on Supabase AAL2, reads through developer-authorized Edge Functions, administers shops/licences and displays the audit log and release approval workflow. Real Supabase Auth/RLS and browser acceptance remain unverified; release bundle signing/publication is separate follow-up work.

### 12.5 Docs and operational proof

- `docs/CONTROL_PLANE_DESIGN.md`
- `docs/CONTROL_PLANE_DECISIONS.md`
- `docs/DEPLOYMENT.md`
- `docs/DOCKER.md`
- `docs/INSTALLER.md`
- `docs/MANUAL_TEST_PLAN.md`

Reason: keep the implementation aligned with the approved design and acceptance gates.

---

## 13. Migration plan for removing `super_admin`

This migration is implemented on `feature/control-plane`; the old literal remains only to select legacy records and record the audit event.

1. First-run setup creates the local shop admin only after both the one-time setup code and a control-plane activation code are accepted.
2. Startup transactionally converts legacy `super_admin` records to `admin` and records one audit event per converted account.
3. Shop role lists and permissions expose `admin` as the highest local role; the obsolete super-admin seed command was removed.
4. Policy and real-Mongo integration tests cover the local role transition. Test counts and gaps are in `docs/CONTROL_PLANE_STATE.md`.

---

## 14. Phase test plan

### Phase B: control plane backend

- RLS tests for each private table
- rate-limit tests for activation and support code
- signature round-trip for licence generation and validation
- server-side validation of plan dates and limits

### Phase C: control panel web app

- Playwright UI tests for add shop flow
- shop list and release approvals
- audit log and support session views
- 2FA developer sign-in

### Phase D: shop integration

- activation code success/failure
- expiry then warning then inactive transitions
- one-time plan never expires
- support token approval and expiry
- clock rollback recovery
- tampered licence rejected
- sale in progress not cut off

### Phase E: release and updater

- successful update
- failed update triggers rollback
- tampered bundle rejected
- interrupted download retry
- health-check failure roll-back

### Phase F: LAN mode

- fixed IP and certificate setup
- client connection via browser
- firewall verification
- restart behaviour and admin PC sleep constraints

---

## 15. Costs and free-plan limits

The exact cost plan must be checked on official supplier sites at implementation time. The following are placeholders only and should be validated against the official pricing pages before live rollout.

| Area | Likely start point | Official source |
| --- | --- | --- |
| Supabase | Free tier for initial control plane | https://supabase.com/pricing |
| Domain registration | Low annual cost | https://www.namecheap.com/domains/ |
| Windows code signing | Optional later, not always required for initial pilot | https://www.digicert.com/code-signing/windows-code-signing |
| Static web hosting | Often free tier or low-cost plan | https://vercel.com/pricing |
| Caddy / reverse proxy | Open source; no vendor fee | https://caddyserver.com/docs/ |

The product owner must confirm final pricing and free-plan constraints before live rollout.

---

## 16. Open questions for the owner

1. Should a shop be allowed to create an admin account automatically after activation or should the shop admin self-register in a wizard?
2. Is the developer allowed to approve support scopes only from the control plane, or should support be limited to diagnostics and read-only until later?
3. Should release channels be strictly `pilot` and `stable`, or should a `beta` channel also be added?
4. Is the owner comfortable with a hosted control plane in Supabase free tier for the first pilot only?
5. Is a local backup-and-restore workflow required before the first pilot or only after Phase E proofs pass?
6. Should a shop be able to postpone updates, or is all update timing strictly maintenance-window enforced?

---

## 18. Verified versus unverified status

Verified in this design pass:

- The owner-approved decisions are captured in this document.
- The design includes architecture, threat model, licence lifecycle, support workflow, release policy, and implementation impact list.
- The required decision boundaries and no-secret rules are documented.

Not yet verified:

- Supabase project setup and RLS behaviour in a real control-plane project.
- Browser UI and real installer behaviour on shop hardware.
- Production deployment, TLS, DNS, and firewall behavior.
- Human acceptance checks on a real pilot shop.

This design is intentionally written as a planning artifact only and must not be treated as production implementation or deployment approval.

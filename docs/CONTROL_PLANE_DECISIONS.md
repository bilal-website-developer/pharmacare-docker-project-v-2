# Control Plane Decisions

Status: Active decision record. Implementation progress and test evidence are tracked in `docs/CONTROL_PLANE_STATE.md`.

## 1. Decision log

| ID | Decision | Status | Notes |
| --- | --- | --- | --- |
| D1 | Shop staff passwords remain in the shop database | Approved | Only the shop app stores local hashed credentials |
| D2 | Developer does not use or store shop passwords | Approved | Support uses signed support token and approval flow |
| D3 | Developer may inspect a shop only when needed, through a scoped support flow | Approved | Includes masked diagnostics and audit log |
| D4 | Plan type and expiry are chosen by owner per shop | Approved | `monthly`, `yearly`, `one_time` |
| D5 | Offline days and warning days are chosen by owner per shop | Approved | Validated server-side with limits |
| D6 | A sale draft opened before inactivity may finish once within 60 minutes | Approved | The shop API issues an HMAC-authenticated draft token while sales are permitted; inactive-mode middleware enforces expiry/shop binding and the sale transaction consumes the token once. |

---

## 2. Coverage checklist against the owner-required design items

| Required item | Covered in design doc | Notes |
| --- | --- | --- |
| 1. Threat model | `docs/CONTROL_PLANE_DESIGN.md` section 4 | Includes control plane, shop device, support session and update channel |
| 2. Full data model and RLS tests | `docs/CONTROL_PLANE_DESIGN.md` section 5 | Includes table list, RLS, and required tests |
| 3. Edge Function API contract | `docs/CONTROL_PLANE_DESIGN.md` sections 6-7 | Covers activation/heartbeat/licence/release and support allow/token/end operations |
| 4. Exact formats | `docs/CONTROL_PLANE_DESIGN.md` section 6 | Covers licence, support code, support token, release manifest, reset code |
| 5. Licence state machine and tests | `docs/CONTROL_PLANE_DESIGN.md` section 8 | Includes states and edge-case test matrix |
| 6. File impact list | `docs/CONTROL_PLANE_DESIGN.md` section 12 | Lists all repo files and reasons |
| 7. Migration plan for removing `super_admin` | `docs/CONTROL_PLANE_DESIGN.md` section 13 | Includes safe migration sequence |
| 8. Phase test plan | `docs/CONTROL_PLANE_DESIGN.md` section 14 | Covers phases B to F and rollback cases |
| 9. Cost and free-plan limits table | `docs/CONTROL_PLANE_DESIGN.md` section 15 | Includes official sources |
| 10. Open questions for the owner | `docs/CONTROL_PLANE_DESIGN.md` section 16 | Lists the open questions |

Fixed rule checks:

- The owner chooses plan type (monthly, yearly, one_time), expiry, offline_grace_days (default 14, allowed 1-60), warning_days (default 7, allowed 0-30) and renewal_notice_days (default 7, allowed 0-30) when adding a shop admin.
- Inactive mode blocks new sales, purchases and stock changes. A sale draft opened before the inactive boundary may complete once within 60 minutes, enforced by a server-issued HMAC token consumed in the sale transaction.
- The developer never uses a shop's real password and support uses a 6-digit code valid 30 minutes with scopes diagnostics, read_only and admin_actions.
- Support codes and signed tokens are persisted only as hashes. Each shop permits one active support session; the first locally verified token is bound by hash. Local session end blocks access immediately, even if the control-plane end request cannot complete. Current `admin_actions` is limited to licence refresh; wider shop administration and direct screen relay are not implemented.

---

## 3. Owner intent summary

The owner wants a system that allows many pharmacy shops to operate independently while the developer maintains centralised oversight and control without holding shop passwords.

The design therefore treats each shop as an independent business unit with its own local data, local signed licence state, and private local web/API stack. The developer controls release approval, licence issuance and support privileges through a separate control plane.

---

## 3. Architectural decisions

### 3.1 Control plane is separate from shop installs

The control plane lives in a distinct Supabase project. It stores metadata for shops, licences, devices, admin registry, support tokens, release bundles, and audit rows.

This keeps the developer's administrative data separate from the shop's business data and avoids shipping a generic service-role key or developer password into the shop environment.

### 3.2 Devices call out, not receive push

The shop never waits for the control plane to push in configuration. Instead, each shop device performs periodic heartbeats and fetches any active release or licence state that has changed.

This avoids inbound firewall problems and matches the owner’s requirement that shops remain offline-safe and local-first.

### 3.3 Local business data remains local

Mongo remains in the shop's local Docker stack. The developer and control plane do not keep shop databases in the shared cloud project.

This matches the core business requirement that each shop keeps its own data on its own PC.

---

## 4. Licence decisions

### 4.1 Licence is signed JSON, not a database record alone

A licence is not trusted merely because it exists in a database table. It must be signed and validated by the shop before use.

Reasons:

- prevents local users from editing the licence by hand
- preserves trust boundaries between control plane and shop
- allows offline validation until expiry time
- supports consistent audit and support review

### 4.2 Owner chooses plan and expiry values

The owner is the only one who decides:

- plan type
- start date
- expiry date (or none for `one_time`)
- max PCs
- offline grace period
- warning window duration
- renewal notice duration

The control plane validates those values on the server and rejects invalid combinations.

### 4.3 Expiry model is non-destructive

The design deliberately avoids hard blocking on the first sign of expiry.

Instead:

- a reminder starts before expiry
- a warning period starts at expiry
- inactivity begins only after the warning period ends
- new sales, purchases and stock updates are blocked, but view/report/download features stay available

This makes the system operationally safe and avoids cutting off a running sale or causing unnecessary lockout.

---

## 5. Support access decisions

### 5.1 Developer never receives the real shop password

This is the highest-priority decision from the owner.

The system uses a short-lived support code instead. The shop admin approves the support request and gives the owner a one-time code. The control plane issues a signed support token specific to a scope and expiry.

No real password is stored, requested, or reused.

### 5.2 Support is scoped

The support token cannot do everything. It must be one of the following:

- `diagnostics`
- `read_only`
- `admin_actions`

This prevents broad data access and keeps the audit trail precise.

### 5.3 Audit log is mandatory

Every support approval and support action is recorded in both the shop-local audit log and the control-plane audit log. This protects the owner and the shop admin.

---

## 6. Security decisions

### 6.1 Private key stays outside the repo

The private signing key is never committed to code, not saved in the repo, and not shipped in the app image.

The public key is embedded into the app, but the private key remains in the control plane secrets store and in the owner’s offline encrypted backup.

### 6.2 No general API secret for shops

The shop has no broad secret that gives it free access to all shop or control-plane data. It has only a device key hash and the signed licence it has received for that shop.

### 6.3 RLS is required on all private tables

The control plane must not rely on UI-only restrictions. All private tables have RLS and the developer routes are limited to the correct roles.

---

## 7. Update decisions

### 7.1 Upgrades are signed and verified

A release is only valid if it has a valid signature and SHA256 hash. The shop verifies both before installing.

### 7.2 Upgrades require backup and rollback

A release never installs blindly. The system must create a verified backup, run the update, and then execute a health check. If the health check fails, the system restores the prior version.

### 7.3 Pilot before stable

The owner can promote a release to `pilot` first, validate it on one friendly shop, and only then move it to `stable` for broader rollout.

This reduces the blast radius of a failed release.

---

## 8. Decision rationale

### Why not store shop passwords in the control plane?

This would create legal and operational risk. A pharmacy staff password belongs to the shop's own identity system and should remain local. The developer only needs to support the shop with scoped access, not to impersonate the shop's staff.

### Why not push updates into shops directly?

The owner’s architecture requires shops to be behind routers and to operate without general internet access. Pull-based check-ins and maintenance windows are safer and more reliable.

### Why not allow broad remote admin access?

This would violate the owner’s requirement for least privilege, auditability, and legal safety. The support system intentionally limits every session to a small and well-defined scope.

### Why sign the licence?

The licence includes plan and expiry values that affect whether a shop stays active or inactive. If those values can be edited locally without verification, the system loses all trust boundaries.

---

## 9. Open questions and follow-up items

These are not blocking design decisions; they are implementation choices to confirm later.

1. Should the control plane support both `pilot` and `stable` channels only, or also a `beta` channel?
2. Should update postponement be allowed for admin-selected maintenance windows, or should the update auto-install on the next start of the maintenance window?
3. Is the owner comfortable with a first pilot on the free-tier Supabase plan only?
4. Should the shop admin self-register after activation or should the owner create the admin account during onboarding?
5. Should remote support for `read_only` be allowed via direct relay only after the pilot, or should it be part of Phase H with the rest of the built-in support system?

---

## 10. Final implementation gate

The next step is implementation only after:

- owner approval of this design,
- real control-plane project setup,
- real RLS and Edge Function test coverage,
- pilot shop setup and operational acceptance,
- manual review of local device security and LAN setup.

This document is a design record, not an approval to build or deploy.

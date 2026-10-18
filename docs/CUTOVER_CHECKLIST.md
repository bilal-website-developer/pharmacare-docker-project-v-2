# Phase 12: Supabase Cut-over Preparation

**Preparation only.** This checklist describes a future owner-approved cut-over.
It authorizes no deletion, move, deployment, merge, push, or change to the live
Supabase project. Keep the current Supabase implementation and migrations
intact until the owner explicitly approves a separate execution task.

## Preconditions

- [ ] Phase 7 API behavior and real-Mongo transactional cases accepted.
- [ ] Every Phase 8 module passes `docs/MANUAL_TEST_PLAN.md` in API mode for
  all five roles, including cost-visibility and cross-shop checks.
- [ ] Owner approves the Mongo production deployment, backups, restore drill,
  DNS/TLS, firewall, monitoring, and recovery targets.
- [ ] Production Mongo backup and restore are tested on an isolated target;
  record counts and application-level acceptance are reviewed.
- [ ] Security review findings are resolved or formally accepted; the existing
  security report is not a penetration test.
- [ ] A tested maintenance window, data export/reconciliation plan, rollback
  plan, and owner authorization exist. No live Supabase query or migration is
  included in preparation.
- [ ] Confirm a tested release commit, tagged images, and recovery contact.

## Proposed frontend cleanup (do not execute here)

- [ ] Remove the Supabase client package from the frontend manifest and lock
  file only after all runtime imports and tests no longer require it.
- [ ] Remove Supabase client initialization, environment variables, types,
  adapters, and fallback branches after the API-only release is accepted.
- [ ] Search for and remove `RepositoryReviewView.tsx`, `POSScreen.tsx`, and
  `ControlledDrugScreen` only if code intelligence/source references and
  production navigation prove each file is unreferenced. Do not assume a
  similarly named screen is dead.
- [ ] Update frontend setup/build documentation and environment examples to
  remove Supabase-specific configuration only after the last supported
  Supabase build has ended.
- [ ] Re-run full lint, tests, production build, API integration tests, and the
  manual acceptance suite after cleanup.

## Proposed archival (requires separate explicit approval)

- [ ] Archive `supabase/` to `archive/supabase-legacy/` only after owner
  approval, repository retention review, and confirmation no branch/release
  or legal/operational procedure still depends on the checked-in migrations.
- [ ] Preserve migration history, baseline schema, and edge-function source in
  version control. Do not delete the live Supabase project or its data as part
  of repository cleanup.
- [ ] Update links, ownership, and archival notes after the approved move.

## Cut-over execution evidence (future task)

- [ ] Owner records explicit approval and chosen maintenance window.
- [ ] Record exact deployed API/web image tags and Mongo backup archive identity
  without recording credentials.
- [ ] Perform only the separately approved data migration/reconciliation.
- [ ] Verify health, login, representative workflows, permissions, audit
  events, backup, and restore after cut-over.
- [ ] Retain Supabase access and rollback plan until acceptance sign-off.
- [ ] Provide a rollback and reconciliation report; do not treat successful
  container startup alone as cut-over acceptance.

No checklist item above has been executed by preparing this document.

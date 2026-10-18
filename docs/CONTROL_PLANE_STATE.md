# Control Plane Implementation State

Updated: 2026-10-18

## Progress

- Done: Recorded starting branch `feature/mongo-migration` and clean tracked worktree; created and switched to `feature/control-plane`. Step 1 added nine control-plane tables, RLS policies, append-only audit enforcement, licence CHECK constraints, and SQL security tests.
- In progress: Step 2, control-plane function logic and fake-database/signature tests.
- Next: Continue the remaining numbered implementation steps in prompt order; use local-only test resources and record evidence here.

## Test counts

- Step 1: throwaway `postgres:17-alpine` migration + `psql -v ON_ERROR_STOP=1 -f /tmp/tests.sql` passed 13 assertions (13 passed, 0 failed, 0 skipped). Evidence: output included `PASS: all nine tables have RLS`, `PASS: anon sees zero rows across all private tables`, `PASS: shop A device cannot read shop B rows from any shop-scoped table`, developer-only licence/release write checks, six constraint rejection checks, and both append-only checks. The container was stopped with `--rm`; no volume was created.
- This branch: root application tests have not been run (0 passed, 0 failed, 0 skipped).
- Previously documented on `feature/mongo-migration`: root 278 total (265 passed, 0 failed, 13 skipped), security 9/9, Compose Mongo integration 13/13. These are prior-branch results, not verification of this branch.

## Not verified

- Steps 2-14 are not implemented or verified yet. Step 1 has only been run against throwaway local PostgreSQL, not a real Supabase deployment.
- Real Supabase project, shop hardware, printer/scanner, two-client LAN, independent security review, and DRAP/FBR review are not verified.
- No secrets or environment-file contents have been read or recorded. `supabase/` has not been touched.

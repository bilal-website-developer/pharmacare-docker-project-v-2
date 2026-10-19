# Control Plane Owner Steps

These are deployment instructions, not evidence that a live project has been configured. Complete them only in an owner-controlled Supabase organization and never paste credentials into source control or support messages.

## Create the Supabase project

1. Sign in to the owner's Supabase organization and choose **New project**.
2. Select the intended organization and a supported region. Use a unique project name, a strong database password, and the owner's approved recovery email.
3. Store the database password in the owner's password manager. Do not put it in this repository or a shop installation.
4. In the project dashboard, open **SQL Editor** and apply the migrations in `control-plane/migrations/` in numeric order, then run the SQL checks in `control-plane/tests/` using the documented local/controlled test process.
5. Confirm RLS is enabled on all control-plane tables and that the anonymous role cannot read private rows. Do not enable anonymous table policies to make the panel work.

## Configure Edge Function secrets

In **Project Settings → Edge Functions → Secrets** (or the current Supabase CLI secret workflow), add the environment variables required by the deployed function:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LICENSE_SIGNING_PRIVATE_KEY`
- `LICENSE_SIGNING_PUBLIC_KEY`
- `SUPPORT_SIGNING_PRIVATE_KEY`
- `SUPPORT_SIGNING_PUBLIC_KEY`

Use the exact PEM encodings expected by the function. Keep private values in the provider's secret store and the owner's password manager only; do not print them, commit them, put them in browser variables, or share them with shop owners. Public keys may be published to shop servers only after matching fingerprints are independently checked. The Supabase anon key is public but must not be mistaken for authorization; RLS remains mandatory.

## Signing-key custody

1. Generate Ed25519 licence and support key pairs using the owner's approved cryptographic process on a controlled machine.
2. Put private keys into the Supabase Edge Function secrets store. Keep encrypted offline recovery copies in two separately controlled locations.
3. Limit access to the private keys to the owner and a documented recovery custodian. Do not store them in the repository, panel build, shop `.env`, release bundle, or general cloud drive.
4. Record key identifiers/fingerprints and rotation procedure, never private key text.
5. The release bundle signer uses Node's built-in Ed25519 support. Its private-key path is supplied at runtime; generate any test pair only in a temporary test folder.

## Require developer 2FA

1. Create the developer identity through Supabase Auth and restrict project membership to named owner-approved accounts.
2. In **Authentication → Providers / MFA**, enable TOTP MFA and disallow weaker recovery paths where the project settings permit.
3. Enroll an authenticator and store recovery codes offline. Do not use a shop's account for developer login.
4. Assign the `control_plane_role=developer` user metadata only to the approved developer account.
5. Sign in to the panel and confirm it requires enrollment/challenge at AAL2 before any shop, licence, audit, or release action.

## Deploy and validate

1. Apply reviewed migrations, deploy `control-plane/functions/`, and configure the panel with only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
2. Verify Edge Function authentication, developer-role checks, MFA/AAL2 enforcement, RLS, and audit append-only behavior using non-production test records.
3. Create a test shop and activation code, activate a throwaway shop install, confirm the code cannot be reused, and validate signed licence and release retrieval.
4. Configure approved HTTPS release storage and confirm the updater can fetch a manifest and verify its detached Ed25519 signature before promoting a pilot release.
5. Do not onboard real shops until a separate owner-approved deployment/restore, security, and operational acceptance has been completed.

No real Supabase project, Auth session, signing secret, or live shop was used to write this guide.

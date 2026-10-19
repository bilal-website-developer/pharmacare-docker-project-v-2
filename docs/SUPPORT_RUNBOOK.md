# Support Runbook

## Before responding

1. Ask the shop Admin to describe the affected screen and approximate time. Do not request passwords, `.env` files, customer records, or screenshots containing customer information.
2. Confirm the shop has a recent backup before any change that may affect data.
3. Prefer the masked diagnostics report. It contains service state and aggregate counts, not customer-level data.
4. Never sign in with a shop user's credentials. Support requires the Admin's time-limited approval and a scoped support token.

## Scoped support session

1. The shop Admin opens **Allow support**, chooses `diagnostics`, `read_only`, or the explicitly required `admin_actions` scope, and creates a support code.
2. The code is one-time and expires after 30 minutes. The Admin shares it only through the owner's approved private channel.
3. Redeem the code through the control-plane support flow while signed in as a developer with the required 2FA assurance level.
4. Use only the granted scope. The current `admin_actions` scope permits licence refresh only; it does not authorize general shop administration.
5. Record a concise support reason and actions taken. Avoid customer identifiers and credentials.
6. Ask the Admin to select **End session**. Confirm local access is ended; do not rely only on the remote control-plane session ending.

## Diagnostics and escalation

- Use the shop's masked diagnostics endpoint for API/database status and aggregate counts. Do not export raw Mongo collections.
- A release issue must be escalated with version, channel, redacted updater status, and verification result; never include signing keys or device credentials.
- A failed health check should trigger automatic rollback. Do not retry by deleting volumes or skipping backup/signature checks.
- For data loss, suspected credential exposure, or a failed rollback, stop changes and involve the shop owner. Preserve logs and backups without copying private records into tickets.
- A real Supabase deployment, Windows shop hardware, LAN client acceptance, printer/scanner behavior, independent security assessment, and regulatory review are outside this local runbook's verified scope.

## Sensitive material handling

- Supabase service-role credentials and signing private keys are held only in the owner's approved secret manager.
- The licence public key is safe to distribute but must match the private signing key used for releases/licences.
- Never send any secret or customer data to a third-party service or ask a shop to paste a secret into chat.
- If a secret may have been exposed, stop use and have the owner rotate it through the provider's official console; do not copy the old value into logs or notes.

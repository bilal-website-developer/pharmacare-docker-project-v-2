# Single-PC shop installer

`docker\install-shop.ps1` provisions one local shop instance from an extracted release directory. Extract a separate copy of the release for each local shop instance, then run from PowerShell:

```powershell
Set-Location E:\PharmaCare\shop-a
.\docker\install-shop.ps1 -ShopSlug shop-a
```

Use only lowercase letters, digits, and hyphens in the shop slug. The installer:

1. Refuses to read, overwrite, or rotate an existing `.env`.
2. Creates strong Mongo/auth secrets, a unique Compose project name, and a random 256-bit setup code. It writes only the setup-code SHA-256 digest and four-hour expiry to the ignored `.env`.
3. Displays the one-time setup code in the local console, validates Compose configuration, builds images, starts the stack, waits for the API/database health response, and checks that first-run setup is still pending.
4. Uses Compose project-name volume scoping so each installation has a separate `mongo_data` named volume. MongoDB has authentication and replica-set configuration and is not published to the host; the API is also unpublished.
5. Publishes the web service only on `127.0.0.1:8080`. Complete setup on the shop PC at `http://localhost:8080`; enter the displayed one-time code before it expires.

The installer never prints `.env` contents or application passwords. The setup code is intentionally displayed once to the local operator; do not record it in a transcript, support log, screenshot, command history, or chat. If the code is lost or expires, stop and follow an approved credential rotation/reset procedure; do not delete the data volume.

This is a local single-PC install path, not multi-PC LAN deployment. It does not provide TLS, a public domain, automatic certificates, Windows firewall rules, unattended update/restore, or backup retention. Do not expose the HTTP port to a shop LAN. Use the separately documented production/LAN HTTPS configuration only after its owner acceptance and restore rehearsal.

Current validation is limited to PowerShell parser success, `docker compose config --quiet`, and the broader repository build/tests. The installer itself has not been run against a shop installation directory, and no `.env` or data volume was created by these checks. Treat installation and owner acceptance as pending.

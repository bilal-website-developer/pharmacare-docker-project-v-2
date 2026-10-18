# Owner-operated setup

## Repository push authentication

This run could not push `feature/mongo-migration`: noninteractive Git reported
`Cannot prompt because user interactivity has been disabled`. Sign in to the
configured HTTPS Git credential provider on the development machine, then ask
the engineer to retry the explicitly approved push. Do not paste a password,
personal access token, or credential-helper output into chat.

The first-run setup API/wizard and a single-PC installer script are implemented. The script has only been syntax/Compose-configuration checked and has not yet been run as an actual shop installation; LAN and production use remain unverified. It provisions `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`, then displays the corresponding one-time plaintext code. Do not paste setup codes, passwords, `.env` contents, or tokens into chat.

From a new extracted release directory, start the installer in PowerShell:

```powershell
Set-Location E:\PharmaCare\shop-a
.\docker\install-shop.ps1 -ShopSlug shop-a
```

The installer shows an expiring one-time code in the local PowerShell console; enter it at `http://localhost:8080`. The wizard asks for pharmacy identity, time zone, and the first Super Admin details. The password is sent only to the API over the local service path and stored as an Argon2id hash. The code expires and the API rejects subsequent setup attempts. Do not save credentials in command history.

The interactive `npm run seed:superadmin` CLI remains available for controlled owner-operated bootstrap when needed. It creates the initial shop and Super Admin; enter the password only at its hidden prompt. Do not run the CLI after the setup wizard has already created the shop, and do not delete a Mongo volume or reset credentials to bypass a setup guard.

For existing `.env` files created before the backup service was added, run `.\docker\add-backup-credentials.ps1`, then `docker compose build mongo-init` and `docker compose up --no-deps --force-recreate mongo-init`. This adds a random dedicated read-only account for application-database backups. Keep `.env` private and never paste its contents into chat.

After verifying the configured shop and deciding that the synthetic inactive examples are wanted, the Super Admin may run the optional starter catalog import:

```powershell
Set-Location E:\PHARMCYYYY
npm.cmd run seed:starter-catalog
```

It is safe to repeat by medicine code and will not update an existing record, set prices, activate products, or create stock. Set real prices and review/activate each product only through the normal authorized application workflow.

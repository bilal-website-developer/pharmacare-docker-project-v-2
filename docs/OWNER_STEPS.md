# Owner-operated setup and outstanding installer handoff

The first-run setup API and wizard are implemented, but the shop installer that provisions `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT` and displays the corresponding one-time plaintext code is not yet implemented. Until that installer is delivered and tested, this is not a complete shop-PC setup procedure. Do not paste setup codes, passwords, `.env` contents, or tokens into chat.

After an approved installer has provisioned the code and expiry in the ignored `.env`, launch the local services from PowerShell:

```powershell
Set-Location E:\PHARMCYYYY
docker compose up --detach api web
docker compose ps
```

Open the local web app. If Mongo has no shop, the wizard asks for pharmacy identity, time zone, and the first Super Admin details. Enter the one-time code displayed by the installer in the wizard. The password is sent only to the API over the local service path and stored as an Argon2id hash. The code expires and the API rejects subsequent setup attempts. Do not save credentials in command history.

The interactive `npm run seed:superadmin` CLI remains available for controlled owner-operated bootstrap when needed. It creates the initial shop and Super Admin; enter the password only at its hidden prompt. Do not run the CLI after the setup wizard has already created the shop, and do not delete a Mongo volume or reset credentials to bypass a setup guard.

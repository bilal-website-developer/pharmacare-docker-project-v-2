# Owner-operated bootstrap steps

These commands run from PowerShell in `E:\PHARMCYYYY`. They use the existing ignored `.env`; do not display or paste its contents.

```powershell
Set-Location E:\PHARMCYYYY
docker compose up --detach api web
docker compose ps
npm run seed:superadmin
```

The seed command creates the first shop and its first `super_admin` together if the shop slug does not exist. In the interactive terminal, enter the desired shop slug, shop name, username, email, and full name. Type the password and confirmation only at the hidden prompts. The password is not echoed; it is stored only as an Argon2id hash. Do not paste credentials into chat or save them in command history.

The command refuses to create a second bootstrap user in a shop that already has users. If the command reports that the shop already has users, stop and use the normal authenticated Manage Users workflow instead. Do not delete a Mongo volume or reset credentials to bypass this guard.

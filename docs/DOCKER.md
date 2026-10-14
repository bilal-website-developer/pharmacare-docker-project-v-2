# Local Docker development

This setup is for local development only. It builds the existing React frontend and a Fastify health-check skeleton, runs a single-node authenticated MongoDB replica set, creates a least-privilege application user, and creates the initial indexes. It does not implement business API routes or migrate Supabase data.

MongoDB is only on the private Docker `database` network and has no published host port. The API is not published on the host; only Nginx is exposed at `http://localhost:8080`. Do not treat this setup as production deployment configuration.

## Requirements

- Windows PowerShell 5.1 or later
- Docker Desktop running with Docker Compose v2 (`docker compose`)
- Node.js/npm only if running frontend/API commands outside Docker

## Create local secrets

From the repository root in PowerShell, generate a new ignored `.env` file. The script refuses to overwrite an existing `.env` and does not print the generated values:

```powershell
.\docker\generate-secrets.ps1
```

The script uses the operating system cryptographic random-number generator. `.env` is ignored by Git and excluded from Docker build contexts. Do not display it, paste it into chat, or commit it.

The legacy frontend still contains Supabase-backed screens. The generated file leaves `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` blank. If you intentionally want those legacy screens to contact an existing Supabase project during this phase, add the public project URL and anon key to `.env` locally before building. Do not put a service-role key in either variable or in the frontend build.

## Build and start

```powershell
docker compose config --quiet
docker compose build
docker compose up --detach
docker compose ps
```

`docker compose up` waits for MongoDB health, then `mongo-init` initiates `rs0`, creates the app user with `readWrite` on `pharmacare` only, and creates the planned indexes. The API starts after initialization and MongoDB health checks pass. Nginx starts after the API health check passes.

## Bootstrap the first API user

After the stack is running, create the initial super-admin interactively:

```powershell
npm run seed:superadmin
```

The command attaches to the API container, prompts for shop/user details and a hidden password, and refuses to create a second bootstrap user in that shop. It stores only the Argon2id password hash. The existing frontend still authenticates through its legacy Supabase integration; this bootstrap does not cut over the UI.

## Verify the local health response

```powershell
Invoke-RestMethod -Uri http://localhost:8080/api/health -Method Get
```

Expected shape after successful startup:

```text
status   database
------   --------
ok       ok
```

The response only checks the API's MongoDB ping. It does not prove business routes, role authorization, data integrity, production readiness, backups, or migration behavior.

## Inspect startup logs and stop

```powershell
docker compose logs --tail 100 mongo mongo-init api web
docker compose down
```

`docker compose down` deliberately preserves the named `mongo_data` volume. Do not add `--volumes` unless you separately approve and understand the data deletion. To start again:

```powershell
docker compose up --detach
```

## Reset notes

The generated credentials belong to the initialized MongoDB data volume. Do not regenerate `.env` while retaining `mongo_data`: the root/app credentials stored in MongoDB will not be changed automatically, and startup may fail. Credential rotation requires a planned authenticated database operation. Removing the data volume is destructive and is outside this setup guide.

Only the web container has a published port (`8080:80`). Do not add a MongoDB or API `ports` mapping. The API is attached to the internal database network and the web-facing network to receive reverse-proxied requests.

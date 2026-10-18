# Local Docker development

This Compose file is for local development and single-PC installation only. It builds the React frontend and Fastify API, runs a single-node authenticated MongoDB replica set, creates a least-privilege application user, and creates the initial indexes. The web UI binds to loopback on port 8080; the API and MongoDB have no published host ports. It does not provide LAN HTTPS or production deployment configuration.

MongoDB is only on the private Docker `database` network and has no published host port. The API is not published on the host; only Nginx is bound to `127.0.0.1:8080`. Do not treat this setup as production or multi-PC LAN deployment configuration.

For a new single-PC shop instance, use the installer in a separate extracted release directory per shop:

```powershell
.\docker\install-shop.ps1 -ShopSlug main
```

The installer refuses to overwrite an existing `.env`, creates a unique `COMPOSE_PROJECT_NAME` so each installation gets its own Compose-scoped `mongo_data` volume, builds and starts the stack, waits for API health, and displays an expiring first-run setup code once. Enter that code in the local setup wizard. The code itself is not stored; only its SHA-256 digest and expiry are written to the ignored `.env`. Never paste the code or `.env` values into chat. This local installer binds only to loopback; LAN access must wait for the HTTPS deployment configuration.

Existing development `.env` files from before the backup service need its dedicated credential added once:

```powershell
.\docker\add-backup-credentials.ps1
docker compose build mongo-init
docker compose up --no-deps --force-recreate mongo-init
```

The helper writes a random, database-read-only Mongo backup user/password into the ignored `.env` without displaying either value. The backup service is opt-in for local use; run a one-time backup with `docker compose --profile backup run --rm mongo-backup backup-once`. Scheduled backup and the scratch restore rehearsal are documented in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

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

The frontend build uses `VITE_BACKEND=api` by default and reads `VITE_SHOP_SLUG` to select the shop for API sign-in. The installer sets it to the selected shop slug. These are build-time settings, so rebuild the web image after changing them.

To use the legacy Supabase paths, set `VITE_BACKEND=supabase` and configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the ignored `.env` before building. These values are public client settings; never put a service-role key in either variable or in the frontend build.

## Build and start

```powershell
docker compose config --quiet
docker compose build
docker compose up --detach
docker compose ps
```

`docker compose up` waits for MongoDB health, then `mongo-init` initiates `rs0`, creates the app user with `readWrite` on `pharmacare` only, and creates the planned indexes. The API starts after initialization and MongoDB health checks pass. Nginx starts after the API health check passes.

When running Vite and the API directly on the host, use two terminals: `npm run dev` serves Vite on port 3000, while `npm --prefix server run dev` starts Fastify on port 3001. The Vite proxy defaults to the Compose API target (`http://127.0.0.1:3000`) so local Docker traffic matches the container layout; to target a host-run API on port 3001, set `VITE_API_PROXY_TARGET=http://127.0.0.1:3001` before starting Vite. Compose explicitly sets `PORT=3000` inside the API container, where Nginx proxies `/api` over the private Docker network to `api:3000`. The API container remains unpublished on the host.

## Bootstrap the first API user

For an install created by `docker\install-shop.ps1`, enter the displayed one-time code in the first-run wizard at `http://localhost:8080`. The wizard creates the initial shop, Super Admin, and server-side settings in one transaction.

For a development stack created with `generate-secrets.ps1`, create the initial Super Admin interactively instead:

```powershell
npm run seed:superadmin
```

The command attaches to the API container, prompts for shop/user details and a hidden password, and refuses to create a second bootstrap user in that shop. It stores only the Argon2id password hash. In API mode, sign-in uses the configured `VITE_SHOP_SLUG`, and the login form retains its existing email/password fields.

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

Only the web container has a published port, bound to loopback (`127.0.0.1:8080:80`). Do not add a MongoDB or API `ports` mapping. The API is attached to the internal database network and the web-facing network to receive reverse-proxied requests.

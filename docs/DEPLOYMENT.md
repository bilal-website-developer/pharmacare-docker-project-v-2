# Production deployment and Mongo backup operations

This is an operator guide for a single Docker host. It is not a record of a production deployment: no public DNS, firewall, TLS issuance, or production install was performed while writing it. Do not use production mode until an owner has accepted the manual and restore tests.

## Host and network prerequisites

- Use a maintained Linux server with Docker Engine and Docker Compose v2.24 or later (`!reset` is used to remove the base file's web port).
- Pin and review a release before deployment. Set `PHARMA_API_IMAGE` and `PHARMA_WEB_IMAGE` to immutable image tags/digests in the ignored `.env`; do not deploy a floating `latest` tag.
- Point the public DNS A/AAAA records for `PUBLIC_DOMAIN` at the server. Configure the host firewall and cloud firewall to allow inbound TCP 80 and 443 only, plus SSH from the operator's trusted management addresses. Do not open MongoDB, API, or Nginx ports. Use SSH keys, disable password SSH where operationally supported, and keep a documented recovery path.
- Use a dedicated server account with least privilege for Docker operations. Apply OS and Docker security updates on a maintenance schedule, monitor disk/volume capacity and service health, and configure host log rotation. Protect the host and its Docker socket as privileged infrastructure.

## Configure and start

For an existing local `.env` that predates the backup service, add the dedicated random read-only backup credential without displaying it:

```powershell
.\docker\add-backup-credentials.ps1
```

For a new instance, `.\docker\generate-secrets.ps1` already creates the backup credential. Set the public domain, ACME contact email, and immutable API/web image references in the ignored `.env` using a local editor or secrets manager. Never print or commit `.env`.

Validate and start the production overlay (PowerShell):

```powershell
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup config --quiet
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup build
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup up --detach
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup ps
```

Caddy obtains and renews public TLS certificates automatically for `PUBLIC_DOMAIN`. TCP 80 is required for certificate challenges and HTTP-to-HTTPS service; TCP 443 serves the application. The web container has no host port in the production overlay. The API and MongoDB remain unpublished; MongoDB stays on the internal database network. Mongo's persistent database, backup archive, and Caddy certificate/configuration data use separate named volumes. API, web, Caddy, backup, and Mongo resource limits and container health checks are configured in the production overlay/base services.

The generated certificate and application are not proven reachable until the owner checks DNS, firewall, `docker compose ps`, Caddy logs, browser TLS, authentication, and a representative transaction on the actual host. Do not expose the loopback-only installer port or use the HTTP local installer for LAN access.

## Scheduled backups

The `mongo-backup` service starts immediately and then repeats at `BACKUP_INTERVAL_SECONDS` (default 86400). It writes compressed database archives and applies file-age retention using `BACKUP_RETENTION_DAYS` (default 30). It authenticates as a dedicated account with `read` only on the application database. The archive and backup log contain no credentials; temporary Mongo tools configuration is stored on container tmpfs and removed on exit. Backup failures emit a generic event and are retried at the next interval; monitor the service health and logs.

Inspect backup status without printing environment files or values:

```powershell
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup logs --tail 50 mongo-backup
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile backup exec mongo-backup ls -lh /backups
```

The named backup volume is not an off-host backup, encryption-at-rest system, or disaster-recovery plan. Arrange a separately secured off-host copy with access controls, retention, and encryption appropriate to the shop, and regularly monitor free disk space. Do not delete or prune data volumes as a rotation method.

## Restore rehearsal to an ephemeral scratch MongoDB

Run the rehearsal during a quiet period so source collection counts do not change between snapshot and comparison. These commands create a new archive in the persistent backup volume and use a no-auth scratch MongoDB on the internal Docker network with its data on tmpfs. They do not alter the source database or remove any volume:

```powershell
docker compose --profile backup run --rm mongo-backup backup-once
docker compose --profile backup-restore up --detach mongo-restore-scratch
docker compose --profile backup run --rm mongo-backup restore-latest
docker compose stop mongo-restore-scratch
```

The restore command reports per-collection document counts and exits nonzero if the source and scratch counts differ. Inspect the command output, record the archive name/counts and outcome in the shop's operational log, and ensure the scratch service is stopped. Its in-memory data disappears when its container is recreated; no cleanup or volume deletion is needed. Do not point the scratch restore command at `mongo`, do not add `--drop`, and do not run a test restore over production data.

## Updates and monitoring

Before updating, capture the currently deployed immutable image tags and verify a recent backup archive. Build/tag and test a new immutable release, then update the two image references in `.env` and run `docker compose ... up --detach` with the same compose files and `--profile backup`. Validate all health checks, the TLS endpoint, auth/session renewal, and one read/write flow. Retain the prior image tags for rollback. A database schema/data rollback is not implied by image rollback; use a rehearsed, owner-approved restore plan only.

Monitor host disk, Docker daemon, certificate renewal, API/Mongo health, backup timestamps, backup failures, and Mongo volume capacity. Logs are structured and redact credentials, but operational logs still contain application metadata. Restrict log access and retention. Confirm that host log rotation includes Docker's logging driver; set the host-specific policy before production rather than assuming Compose rotates logs.

This deployment setup has not been run on a public host or subjected to a penetration test. Off-host backup, at-rest backup encryption, disaster-recovery RTO/RPO, certificate issuance, server/firewall hardening, and owner acceptance remain open.

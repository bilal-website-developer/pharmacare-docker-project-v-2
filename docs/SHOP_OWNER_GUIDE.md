# Shop Owner Guide

## Before installation

- Use a dedicated Windows admin PC that can stay powered on for shop hours.
- Keep an encrypted, offline copy of the installer, the release-signing public key, and the shop's backups.
- Do not send staff passwords, setup codes, licence tokens, or `.env` contents to support.
- This repository's local install and automated tests are not real-shop acceptance. Confirm the current owner-approved release and the installation checklist before using business data.

## Install and first run

1. Unpack the approved release into a new, empty folder on the admin PC.
2. Open elevated PowerShell in that folder and run `.\docker\install-shop.ps1 -ShopSlug <shop-slug>`.
3. Keep the one-time setup code private and enter it only in the first-run wizard. Do not place it in a ticket or message.
4. Obtain an activation code from the control-plane owner and enter both codes in the setup wizard. Create the shop's Admin account with a unique password.
5. Confirm the browser opens at `http://localhost:8080`, sign in, and verify that the shop, time zone, and licence banners are correct.
6. The installer creates a daily host Scheduled Task at 02:00. Updates remain inactive until the installation's control-plane update configuration, public verification key, and release channel have been provisioned and tested by the owner.

The installer creates local credentials in `.env`. Never send or copy that file to support. The code in this repository does not yet provision update configuration during activation; do not assume the Scheduled Task can install releases until the owner completes that integration.

## LAN access

LAN mode is optional and requires Windows administrator rights, Docker Compose, and a static/reserved admin-PC address.

1. Pick a DNS name that resolves to the admin PC for client devices.
2. Run `.\scripts\enable-lan.ps1 -LanHostname <admin-pc-name>` from elevated PowerShell.
3. Give client PCs the exported `exports\pharmacare-lan-root.crt` through a trusted local channel. Install it in the client computer's trusted root store, then browse to `https://<admin-pc-name>/`.
4. Confirm the browser reports a trusted connection and the pharmacy UI loads before staff sign in.
5. Firewall access is intended for the Windows Private profile and local subnet only. Do not expose MongoDB or forward port 27017.
6. Check the admin PC's sleep settings. A sleeping or powered-off server makes the shop unavailable to LAN clients.

This LAN procedure has not been accepted on a real Windows shop PC or tested with two client PCs. Keep loopback-only mode if any step is unclear.

## Backups and restore

- Compose stores scheduled Mongo archives in a separate backup volume. A backup archive should be validated before it is relied on.
- Copy an archive to a separately controlled drive with `.\scripts\backup-external.ps1 -DestinationDirectory <external-folder>`. Keep its `.sha256` sidecar next to it.
- Run the scratch restore check with `.\installer\restore.ps1 -ScratchTest`. It is intended to restore into a temporary scratch service and compare record counts, not overwrite the live shop.
- A live restore is destructive to the selected shop database. It requires the exact shop slug confirmation and a verified pre-restore safety backup. Run it only with the shop owner present and an independently checked archive.
- Keep at least one encrypted backup disconnected from the admin PC.

Neither external-copy nor scratch-restore has been validated against a real shop dataset in this continuation.

## Licence and support

- Renewal notices are for the Admin. The warning period keeps shop work available; inactive or suspended mode blocks new sales, purchases, and stock changes.
- Viewing, reports, printing, and backups remain available in inactive mode. A sale draft opened while active can be completed once within 60 minutes.
- Offline grace expiry is a warning, not a sales lock. One-time licences do not expire.
- Use **Allow support** only when needed. Select the narrowest scope, share the six-digit code through a trusted channel, and select **End session** as soon as support is finished.
- Support does not require the shop's real password. Never share a cashier login or password with the developer.

## If something fails

1. Do not remove Docker volumes or run `docker compose down -v`.
2. Record the visible error, time, app version, and whether the admin PC has internet; do not include names, phone numbers, sales, passwords, tokens, or `.env` values.
3. Leave the shop database and backups intact. Contact the owner using the approved support channel.
4. Do not approve or install a release manually if signature verification or backup checks fail.

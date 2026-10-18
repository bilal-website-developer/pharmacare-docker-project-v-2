#!/bin/sh
set -eu

: "${MONGO_APP_DB:?MONGO_APP_DB is required}"
: "${MONGO_BACKUP_USERNAME:?MONGO_BACKUP_USERNAME is required}"
: "${MONGO_BACKUP_PASSWORD:?MONGO_BACKUP_PASSWORD is required}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=30}"

invalid_interval=$(printf '%s' "$BACKUP_INTERVAL_SECONDS" | sed 's/[0-9]//g')
if [ -z "$BACKUP_INTERVAL_SECONDS" ]; then
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"invalid_interval"}' >&2
  exit 1
fi
if [ -n "$invalid_interval" ]; then
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"invalid_interval"}' >&2
  exit 1
fi
invalid_retention=$(printf '%s' "$BACKUP_RETENTION_DAYS" | sed 's/[0-9]//g')
if [ -z "$BACKUP_RETENTION_DAYS" ]; then
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"invalid_retention"}' >&2
  exit 1
fi
if [ -n "$invalid_retention" ]; then
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"invalid_retention"}' >&2
  exit 1
fi
if [ "$BACKUP_INTERVAL_SECONDS" -lt 60 ] || [ "$BACKUP_RETENTION_DAYS" -lt 1 ]; then
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"interval_or_retention_out_of_range"}' >&2
  exit 1
fi

umask 077
mkdir -p /backups /run/mongo-backup

escape_yaml_single_quoted() {
  printf '%s' "$1" | sed "s/'/''/g"
}

escape_json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

print_safe_tool_diagnostic() {
  sed \
    -e "s|$MONGO_BACKUP_PASSWORD|[REDACTED]|g" \
    -e 's#mongodb[^:]*://[^[:space:]"<>]*#[REDACTED_MONGODB_URI]#g' \
    "$1" | tail -n 12 >&2
}

write_tools_config() {
  escaped_password=$(escape_yaml_single_quoted "$MONGO_BACKUP_PASSWORD")
  printf 'uri: "mongodb://%s@%s:%s/%s?authSource=%s"\n' "$MONGO_BACKUP_USERNAME" "$MONGO_HOST" "$MONGO_PORT" "$MONGO_APP_DB" "$MONGO_APP_DB" > /run/mongo-backup/tools.yml
  printf "password: '%s'\n" "$escaped_password" >> /run/mongo-backup/tools.yml
  chmod 0600 /run/mongo-backup/tools.yml
}

write_authenticated_count_script() {
  escaped_username=$(escape_json_string "$MONGO_BACKUP_USERNAME")
  escaped_password=$(escape_json_string "$MONGO_BACKUP_PASSWORD")
  printf 'const username = "%s";\n' "$escaped_username" > /run/mongo-backup/source-count.js
  printf 'const password = "%s";\n' "$escaped_password" >> /run/mongo-backup/source-count.js
  printf 'const auth = db.getSiblingDB("%s").auth(username, password);\n' "$MONGO_APP_DB" >> /run/mongo-backup/source-count.js
  printf 'if (auth !== 1 && auth.ok !== 1) throw new Error("source authentication failed");\n' >> /run/mongo-backup/source-count.js
  printf 'const target = db.getSiblingDB("%s");\n' "$MONGO_APP_DB" >> /run/mongo-backup/source-count.js
  printf 'const names = target.getCollectionNames().filter((name) => !name.startsWith("system.") && name !== "requestRateLimits" && name !== "authRateLimits").sort();\n' >> /run/mongo-backup/source-count.js
  printf 'const counts = Object.fromEntries(names.map((name) => [name, target.getCollection(name).countDocuments({})]));\n' >> /run/mongo-backup/source-count.js
  printf 'print(JSON.stringify(counts));\n' >> /run/mongo-backup/source-count.js
  chmod 0600 /run/mongo-backup/source-count.js
}

backup_once() {
  timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
  archive="/backups/pharmacare-${timestamp}.archive.gz"
  partial="${archive}.partial"
  if ! mongodump --config /run/mongo-backup/tools.yml --db "$MONGO_APP_DB" --archive="$partial" --gzip >/run/mongo-backup/dump.log 2>&1; then
    rm -f "$partial"
    printf '%s\n' '{"event":"mongo_backup_failed","reason":"dump_command_failed"}' >&2
    print_safe_tool_diagnostic /run/mongo-backup/dump.log
    return 1
  fi
  mv "$partial" "$archive"
  find /backups -maxdepth 1 -type f -name 'pharmacare-*.archive.gz' -mtime "+$BACKUP_RETENTION_DAYS" -delete
  printf '%s\n' "$timestamp" > /backups/last-success.partial
  mv /backups/last-success.partial /backups/last-success
  printf '{"event":"mongo_backup_complete","archive":"%s","timestamp":"%s"}\n' \
    "$(basename "$archive")" "$timestamp"
}

restore_latest_to_scratch() {
  archive=$(ls -1t /backups/pharmacare-*.archive.gz 2>/dev/null | head -n 1 || true)
  if [ -z "$archive" ]; then
    printf '%s\n' '{"event":"mongo_restore_rehearsal_failed","reason":"no_backup_archive"}' >&2
    return 1
  fi

  write_authenticated_count_script
  source_counts=$(mongosh --quiet --host "$MONGO_HOST" --port "$MONGO_PORT" \
    --file /run/mongo-backup/source-count.js)
  if mongorestore --host mongo-restore-scratch --port 27017 \
    --archive="$archive" --gzip --nsInclude="${MONGO_APP_DB}.*" \
    >/run/mongo-backup/restore.log 2>&1; then
    :
  else
    printf '%s\n' '{"event":"mongo_restore_rehearsal_failed","reason":"restore_command_failed"}' >&2
    print_safe_tool_diagnostic /run/mongo-backup/restore.log
    return 1
  fi
  restored_counts=$(mongosh --quiet --host mongo-restore-scratch --port 27017 \
    --eval "const target = db.getSiblingDB('${MONGO_APP_DB}'); const names = target.getCollectionNames().filter((name) => !name.startsWith('system.') && name !== 'requestRateLimits' && name !== 'authRateLimits').sort(); const counts = Object.fromEntries(names.map((name) => [name, target.getCollection(name).countDocuments({})])); print(JSON.stringify(counts));")

  if [ "$source_counts" != "$restored_counts" ]; then
    printf '%s\n' '{"event":"mongo_restore_rehearsal_failed","reason":"collection_counts_differ"}' >&2
    printf '{"sourceCollectionCounts":%s,"restoredCollectionCounts":%s}\n' \
      "$source_counts" "$restored_counts" >&2
    return 1
  fi
  printf '{"event":"mongo_restore_rehearsal_complete","archive":"%s","collectionCounts":%s}\n' \
    "$(basename "$archive")" "$restored_counts"
}

write_tools_config
trap 'rm -f /run/mongo-backup/tools.yml /run/mongo-backup/source-count.js /run/mongo-backup/dump.log /run/mongo-backup/restore.log' EXIT HUP INT TERM

command="${1:-scheduled}"
if [ "$command" = 'backup-once' ]; then
  backup_once
elif [ "$command" = 'restore-latest' ]; then
  restore_latest_to_scratch
elif [ "$command" = 'scheduled' ]; then
  while :; do
    backup_once || true
    sleep "$BACKUP_INTERVAL_SECONDS"
  done
else
  printf '%s\n' '{"event":"mongo_backup_failed","reason":"unsupported_command"}' >&2
  exit 2
fi

#!/bin/sh
set -eu

: "${MONGO_REPLICA_KEY:?MONGO_REPLICA_KEY is required}"
: "${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD is required}"

if [ "${#MONGO_REPLICA_KEY}" -lt 32 ] || [ "${#MONGO_INITDB_ROOT_PASSWORD}" -lt 32 ]; then
  printf '%s\n' "MongoDB root password and replica key must each be at least 32 characters." >&2
  exit 1
fi

install -d -o mongodb -g mongodb -m 0700 /run/mongo-auth
printf '%s' "$MONGO_REPLICA_KEY" > /run/mongo-auth/keyfile
chown mongodb:mongodb /run/mongo-auth/keyfile
chmod 0400 /run/mongo-auth/keyfile

exec /usr/local/bin/docker-entrypoint.sh mongod \
  --replSet rs0 \
  --bind_ip_all \
  --auth \
  --keyFile /run/mongo-auth/keyfile

#!/usr/bin/env bash
# ESS "box": the portal plus its three databases in ONE Cloudflare container.
#
#   Postgres 14 (127.0.0.1:5432)  MongoDB 7 (127.0.0.1:27017)  Redis 7 (127.0.0.1:6379)
#   └──────────────── the SvelteKit app (start.sh → node build/index.js, :3000)
#
# A Cloudflare container's disk is wiped on every restart and every deploy, so
# the data lives in R2 between runs:
#   - on start:    download the latest Postgres + Mongo backup from R2 and restore it
#   - every N min: dump both and upload them to R2 (BACKUP_INTERVAL_MINUTES, default 5)
#   - on SIGTERM:  stop the app, take one final backup, then shut the databases down
#   - once an hour: also keep a dated copy under history/ (point-in-time fallback)
# Redis is not backed up: it only holds sessions, rate limits and caches.
#
# R2 is reached WITHOUT any API keys: plain HTTP to R2_BRIDGE_URL is intercepted
# by the Worker (outboundByHost in cloudflare/src/index.ts), which reads and
# writes the bucket through its native R2 binding. Nothing outside the
# container can reach that bridge.
#
# Anything written after the last successful backup is lost if the container
# dies without a clean SIGTERM (host crash, OOM kill).
set -uo pipefail

log() { echo "[ess-box] $(date -u +%H:%M:%S) $*"; }

DATA=/var/lib/ess
PGDATA=$DATA/pg
MONGODATA=$DATA/mongo
BK=$DATA/backup
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DB_NAME=champ_hr
BACKUP_INTERVAL_MINUTES=${BACKUP_INTERVAL_MINUTES:-5}
BRIDGE=${R2_BRIDGE_URL:-http://198.51.100.7}
R2_OK=0

# --- R2 bridge helpers ------------------------------------------------------
r2_ping() { curl -fsS -m 20 "$BRIDGE/_ping" >/dev/null 2>&1; }
# 0 = exists, 1 = not found, 2 = error
r2_exists() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -I -m 60 "$BRIDGE/$1")
  case "$code" in 200) return 0 ;; 404) return 1 ;; *) log "R2 HEAD $1 returned $code"; return 2 ;; esac
}
r2_get() { curl -fsS -m 3600 -o "$2" "$BRIDGE/$1"; }
r2_put() { curl -fsS -m 3600 -T "$2" -H 'content-type: application/octet-stream' "$BRIDGE/$1" >/dev/null; }

# --- 0. Refuse to run without somewhere to keep the data --------------------
for _ in $(seq 1 20); do r2_ping && { R2_OK=1; break; }; sleep 3; done
if [ "$R2_OK" != 1 ]; then
  if [ "${ALLOW_EPHEMERAL_DATA:-0}" = "1" ]; then
    log "WARNING: R2 bridge unreachable and ALLOW_EPHEMERAL_DATA=1 — all data is lost on every restart."
  else
    # Fail closed: starting empty would later overwrite the real backup.
    log "FATAL: cannot reach the R2 bridge at $BRIDGE. Refusing to start."
    exit 1
  fi
fi

mkdir -p "$PGDATA" "$MONGODATA" "$BK"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# --- 1. Start the three databases (localhost only) --------------------------
log "starting postgres ($PGBIN)"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  su postgres -s /bin/sh -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust --encoding=UTF8 >/dev/null"
fi
su postgres -s /bin/sh -c "$PGBIN/pg_ctl -D $PGDATA -l $DATA/postgres.log -w -t 60 \
  -o '-c listen_addresses=127.0.0.1 -c shared_buffers=256MB' start" || { cat "$DATA/postgres.log"; exit 1; }

log "starting mongodb"
mongod --dbpath "$MONGODATA" --bind_ip 127.0.0.1 --port 27017 --wiredTigerCacheSizeGB 0.5 \
  --fork --logpath "$DATA/mongo.log" >/dev/null || { tail -50 "$DATA/mongo.log"; exit 1; }

log "starting redis"
redis-server --bind 127.0.0.1 --port 6379 --save '' --appendonly no --daemonize yes \
  --logfile "$DATA/redis.log" || exit 1

for _ in $(seq 1 30); do
  mongosh --quiet --eval 'db.runCommand({ping:1}).ok' mongodb://127.0.0.1:27017 >/dev/null 2>&1 && break
  sleep 1
done

# --- 2. Restore the latest backup -------------------------------------------
psql_q() { "$PGBIN/psql" -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

if [ "$(psql_q -c "select count(*) from pg_database where datname='$DB_NAME'")" = "0" ]; then
  psql_q -c "create database $DB_NAME"
fi

if [ "$R2_OK" = 1 ]; then
  r2_exists latest/postgres.dump; rc=$?
  if [ $rc = 0 ]; then
    log "restoring postgres from R2 latest/postgres.dump"
    r2_get latest/postgres.dump "$BK/restore.pg.dump" || { log "FATAL: download failed"; exit 1; }
    if ! "$PGBIN/pg_restore" -h 127.0.0.1 -U postgres -d "$DB_NAME" --no-owner --no-privileges \
         --exit-on-error "$BK/restore.pg.dump"; then
      log "FATAL: postgres restore failed. Not starting, so the good backup in R2 is not overwritten."
      exit 1
    fi
  elif [ $rc = 1 ]; then
    log "no postgres backup in R2 yet — starting with an empty database (first run)"
  else
    log "FATAL: could not check R2 for a postgres backup. Refusing to start."; exit 1
  fi

  r2_exists latest/mongo.archive.gz; rc=$?
  if [ $rc = 0 ]; then
    log "restoring mongodb from R2 latest/mongo.archive.gz"
    r2_get latest/mongo.archive.gz "$BK/restore.mongo.gz" || { log "FATAL: download failed"; exit 1; }
    if ! mongorestore --uri mongodb://127.0.0.1:27017 --archive="$BK/restore.mongo.gz" --gzip --drop --quiet; then
      log "FATAL: mongodb restore failed. Not starting, so the good backup in R2 is not overwritten."
      exit 1
    fi
  elif [ $rc = 1 ]; then
    log "no mongodb backup in R2 yet — starting empty (first run)"
  else
    log "FATAL: could not check R2 for a mongodb backup. Refusing to start."; exit 1
  fi
  rm -f "$BK"/restore.*
fi

# --- 3. Backup ---------------------------------------------------------------
backup() {
  [ "$R2_OK" = 1 ] || return 0
  (
    flock 9
    hour=$(date -u +%Y-%m-%d/%H)
    "$PGBIN/pg_dump" -h 127.0.0.1 -U postgres -Fc --no-owner --no-privileges "$DB_NAME" -f "$BK/pg.dump" \
      || { log "backup: pg_dump failed"; exit 1; }
    mongodump --uri mongodb://127.0.0.1:27017 --archive="$BK/mongo.archive.gz" --gzip --quiet \
      || { log "backup: mongodump failed"; exit 1; }
    r2_put latest/postgres.dump "$BK/pg.dump" \
      && r2_put latest/mongo.archive.gz "$BK/mongo.archive.gz" \
      || { log "backup: upload to R2 failed"; exit 1; }
    if [ "$(cat "$BK/.last-history" 2>/dev/null)" != "$hour" ]; then
      r2_put "history/$hour/postgres.dump" "$BK/pg.dump" \
        && r2_put "history/$hour/mongo.archive.gz" "$BK/mongo.archive.gz" \
        && echo "$hour" > "$BK/.last-history"
    fi
    log "backup ok ($(du -h "$BK/pg.dump" | cut -f1) pg, $(du -h "$BK/mongo.archive.gz" | cut -f1) mongo)"
  ) 9>"$BK/.lock"
}

stop_databases() {
  redis-cli -h 127.0.0.1 shutdown nosave >/dev/null 2>&1 || true
  mongod --dbpath "$MONGODATA" --shutdown >/dev/null 2>&1 || true
  su postgres -s /bin/sh -c "$PGBIN/pg_ctl -D $PGDATA -m fast -w stop" >/dev/null 2>&1 || true
}

# --- 4. Run the app ------------------------------------------------------------
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/$DB_NAME"
export MONGO_URL="mongodb://127.0.0.1:27017/$DB_NAME"
export REDIS_URL="redis://127.0.0.1:6379"

(
  while sleep $((BACKUP_INTERVAL_MINUTES * 60)); do backup || true; done
) &
LOOP_PID=$!

cd /app || exit 1
./start.sh &
APP_PID=$!

shutdown() {
  log "received $1 — stopping app, taking final backup"
  kill "$LOOP_PID" 2>/dev/null || true
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  backup || log "final backup FAILED"
  stop_databases
  log "stopped"
  exit 0
}
trap 'shutdown SIGTERM' TERM
trap 'shutdown SIGINT' INT

wait "$APP_PID"
code=$?
log "app exited with code $code — taking a backup before stopping"
kill "$LOOP_PID" 2>/dev/null || true
# Safe even after a failed start: the databases still hold the restored data.
backup || true
stop_databases
exit "$code"

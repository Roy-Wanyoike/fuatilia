#!/usr/bin/env bash
# boot-api-lane.sh — provision + boot the API kernel's test cluster (issue #72).
#
# The Go integration tests boot the same pieces programmatically
# (internal/infra/pgtest); this script is the human-run equivalent for local
# gates: idempotent initdb, start on port 5435, create the lane database and
# apply db/migrations 0001–0014 through the reference migrate.cjs.
#
# Usage:  backend-go/internal/infra/testdata/boot-api-lane.sh
set -euo pipefail

# Binary discovery mirrors pgtest.PGBin (issue #131): FUATILIA_TEST_PGBIN,
# then FUATILIA_PG_BIN_DIR (the name the TS testutil + CI set), then PATH.
PGBIN="${FUATILIA_TEST_PGBIN:-${FUATILIA_PG_BIN_DIR:-}}"
if [[ -z "$PGBIN" ]]; then
  INITDB_PATH="$(command -v initdb 2>/dev/null || true)"
  if [[ -n "$INITDB_PATH" ]]; then
    PGBIN="$(dirname "$INITDB_PATH")"
  fi
fi

if [[ -z "$PGBIN" || ! -x "$PGBIN/pg_ctl" ]]; then
  echo "pgtest: postgres binaries not found (tried FUATILIA_TEST_PGBIN, FUATILIA_PG_BIN_DIR, PATH lookup of initdb/pg_ctl)" >&2
  echo "pgtest: set FUATILIA_TEST_PGBIN or FUATILIA_PG_BIN_DIR to the directory holding initdb, pg_ctl and postgres — e.g. FUATILIA_TEST_PGBIN=/usr/lib/postgresql/16/bin — or add that directory to PATH" >&2
  exit 1
fi

PORT="${FUATILIA_TEST_PGPORT:-5435}"
DATADIR="${FUATILIA_TEST_PGDATA:-/home/z/my-project/tools/pgdata-10-a}"
DBNAME="fuatilia_api_test"
HOST="127.0.0.1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ ! -d "$DATADIR" ]]; then
  echo "pgtest: initdb -> $DATADIR"
  "$PGBIN/initdb" -D "$DATADIR" -U postgres -A trust -E UTF8 --no-locale
fi

if ! "$PGBIN/pg_ctl" -D "$DATADIR" status >/dev/null 2>&1; then
  echo "pgtest: starting cluster on $HOST:$PORT"
  "$PGBIN/pg_ctl" -D "$DATADIR" -o "-p $PORT -c listen_addresses=$HOST -k $DATADIR" \
    -l "$DATADIR/server.log" -w -t 60 start
fi

export DATABASE_URL="postgres://postgres@$HOST:$PORT/$DBNAME"
"$PGBIN/psql" "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1 || \
  "$PGBIN/psql" "postgres://postgres@$HOST:$PORT/postgres" -c "CREATE DATABASE $DBNAME"

echo "pgtest: applying migrations to $DBNAME"
PGUSER=postgres PGHOST="$HOST" PGPORT="$PORT" PGDATABASE="$DBNAME" node "$REPO_ROOT/db/migrate.cjs"

echo "pgtest: lane database ready at $DATABASE_URL"

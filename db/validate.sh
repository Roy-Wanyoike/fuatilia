#!/usr/bin/env bash
# db/validate.sh — real end-to-end validation of the financial schema (issue #66).
#
# 1. Boots a THROWAWAY PostgreSQL 16 cluster (portable binaries in user space;
#    no sudo, nothing installed system-wide, port 55432).
# 2. Applies every migration with db/migrate.cjs (suite tracked in
#    schema_migrations).
# 3. Applies the whole suite a SECOND time — must be a complete no-op
#    (suite-level idempotency).
# 4. Runs db/smoke.cjs — proves the invariants actually fire:
#    ledger append-only + balance (R3/R4), posting matrix (R5/K5),
#    idempotency replay (R9/C5), one-open-case-per-receivable (R8),
#    role_assignments/audit append-only, fx quote immutability (R10),
#    webhook terminal freeze, allocation ceiling + applied_minor sync (R1/R2).
# 5. Stops the cluster and removes the temp dir. Exit 0 = all gates green.
#
# Usage:  bash db/validate.sh [--ci]
#   --ci  same suite for the GitHub Actions postgres-service job (no initdb;
#         expects PGHOST/PGPORT/PGUSER/PGDATABASE of a fresh empty database).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_HOME="${PG_HOME:-$HOME/tools/pgsql}"
PORT="${PGPORT:-55432}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="$PORT"
export PGUSER="${PGUSER:-fuatilia}"
export PGDATABASE="${PGDATABASE:-fuatilia_validate}"

# Readiness probe via the stdlib wire client — the portable bundle ships
# only initdb/pg_ctl/postgres (no psql/createdb/pg_isready), so EVERYTHING
# client-side goes through db/pgclient.cjs.
probe_ready() {
  node -e "require('$HERE/pgclient.cjs').connect({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:'postgres'}).then(c=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

boot_cluster() {
  TMPDIR_PG="$(mktemp -d /tmp/fuatilia-pgvalidate.XXXXXX)"
  echo "validate: initdb → $TMPDIR_PG/data"
  "$PG_HOME/bin/initdb" -D "$TMPDIR_PG/data" -U "$PGUSER" --auth=trust -E UTF8 >/dev/null
  "$PG_HOME/bin/pg_ctl" -D "$TMPDIR_PG/data" \
    -o "-p $PORT -c listen_addresses=127.0.0.1 -k $TMPDIR_PG" \
    -l "$TMPDIR_PG/server.log" start >/dev/null
  for _ in $(seq 1 60); do
    probe_ready && break
    sleep 0.5
  done
  probe_ready || { echo "validate: cluster never became ready"; exit 2; }
  # exec.cjs lets PGDATABASE override --db — pin env so we bootstrap from the
  # always-present 'postgres' database.
  PGDATABASE=postgres node "$HERE/exec.cjs" --db postgres --sql "CREATE DATABASE $PGDATABASE" >/dev/null
}

teardown_cluster() {
  if [ -n "${TMPDIR_PG:-}" ]; then
    "$PG_HOME/bin/pg_ctl" -D "$TMPDIR_PG/data" stop -m fast >/dev/null 2>&1 || true
    rm -rf "$TMPDIR_PG"
  fi
}

export PG_HOME

if [ "${1:-}" = "--ci" ]; then
  echo "validate: CI mode — using the provided postgres service at $PGHOST:$PGPORT/$PGDATABASE"
else
  boot_cluster
  trap teardown_cluster EXIT
fi

echo "validate: applying migrations (pass 1)"
node "$HERE/migrate.cjs"

echo "validate: applying migrations (pass 2 — must be a full no-op)"
SECOND="$(node "$HERE/migrate.cjs")"
echo "$SECOND"
echo "$SECOND" | grep -q "0 applied" || { echo "validate: FAIL — second pass re-applied migrations (suite not idempotent)"; exit 1; }

echo "validate: invariant smoke suite"
node "$HERE/smoke.cjs"

echo "validate: ALL GATES GREEN"

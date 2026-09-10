#!/usr/bin/env bash
# Dependency vulnerability evidence collector — issue #148.
#
# Collects RAW scanner output into scripts/security/evidence/ so the triage in
# docs/security/dependency-triage.md stays reproducible and CI-reusable:
#
#   scripts/security/scan-dependencies.sh <stage>            # collect evidence
#   scripts/security/scan-dependencies.sh <stage> --strict   # also exit 2 on any finding
#
# <stage> is a free-form label (typically "before" / "after") that names the
# evidence files, e.g. backend-go-govulncheck-after.txt.
#
# Surfaces scanned:
#   backend-go  — govulncheck ./... (symbol-level source scan, vuln.go.dev DB)
#   repo root   — npm audit --json   (TS domain core: pg + test tooling)
#   frontend    — npm audit --json   (Next.js web console)
#
# Scanner exit codes are EXPECTED to be non-zero when findings exist
# (govulncheck: 3; npm audit: 1) — the script records evidence regardless and
# reports a summary. It only fails hard when a scanner could not run at all.
#
# Requirements on PATH: go, npm, govulncheck (go install
# golang.org/x/vuln/cmd/govulncheck@latest). GOTOOLCHAIN=auto (default) lets
# backend-go resolve the toolchain pinned in its go.mod.
#
# NOTE for CI: wire this into a workflow only if you own the workflows lane;
# this script deliberately makes no assumptions about runners beyond the PATH
# tools above and works from a bare checkout for the root/backend surfaces
# (npm audit reads the lockfile; frontend additionally needs `npm ci` first).
set -uo pipefail

STAGE="${1:-}"
STRICT=0
[ "${2:-}" = "--strict" ] && STRICT=1
if [ -z "$STAGE" ]; then
  echo "usage: $0 <stage-label> [--strict]" >&2
  exit 1
fi
case "$STAGE" in
  */*|.*) echo "scan-dependencies: stage label must be a plain filename chunk, got '$STAGE'" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE="$REPO_ROOT/scripts/security/evidence"
mkdir -p "$EVIDENCE"

fail() { echo "scan-dependencies: $*" >&2; exit 3; }
command -v go >/dev/null || fail "go not on PATH"
command -v npm >/dev/null || fail "npm not on PATH"
command -v govulncheck >/dev/null || fail "govulncheck not on PATH (go install golang.org/x/vuln/cmd/govulncheck@latest)"

findings_any=0
tool_failed=0

note_findings() { findings_any=1; }

# --- backend-go: govulncheck (symbol-level source scan) ---------------------
out="$EVIDENCE/backend-go-govulncheck-$STAGE.txt"
err="$EVIDENCE/backend-go-govulncheck-$STAGE.stderr.txt"
( cd "$REPO_ROOT/backend-go" && govulncheck ./... ) >"$out" 2>"$err"
rc=$?
if [ $rc -ne 0 ] && [ $rc -ne 3 ]; then tool_failed=1; fi
if [ $rc -eq 3 ]; then note_findings; fi
# Belt-and-braces on top of the exit code: textual summary line differs across
# govulncheck versions; absence of "No vulnerabilities found" counts as findings.
grep -q "No vulnerabilities found" "$out" || note_findings
( cd "$REPO_ROOT/backend-go" && govulncheck -json ./... ) \
  >"$EVIDENCE/backend-go-govulncheck-$STAGE.json" 2>>"$err"
rc=$?
if [ $rc -ne 0 ] && [ $rc -ne 3 ]; then tool_failed=1; fi

# --- repo root: npm audit (TS domain core) ----------------------------------
out="$EVIDENCE/root-npm-audit-$STAGE.json"
err="$EVIDENCE/root-npm-audit-$STAGE.stderr.txt"
( cd "$REPO_ROOT" && npm audit --json ) >"$out" 2>"$err"
rc=$?
[ -s "$out" ] || tool_failed=1
if grep -q '"severity":' "$out" 2>/dev/null; then note_findings; fi

# --- frontend: npm audit (needs node_modules — run `npm ci` in frontend first)
out="$EVIDENCE/frontend-npm-audit-$STAGE.json"
err="$EVIDENCE/frontend-npm-audit-$STAGE.stderr.txt"
if [ -d "$REPO_ROOT/frontend/node_modules" ]; then
  ( cd "$REPO_ROOT/frontend" && npm audit --json ) >"$out" 2>"$err"
  [ -s "$out" ] || tool_failed=1
  if grep -q '"severity":' "$out" 2>/dev/null; then note_findings; fi
else
  echo "scan-dependencies: frontend/node_modules missing — run 'npm ci' in frontend/ first; skipping frontend audit (evidence file left absent)" >&2
  tool_failed=1
fi

echo "scan-dependencies[$STAGE]: evidence in $EVIDENCE"
echo "scan-dependencies[$STAGE]: findings detected: $findings_any (0=clean, 1=some scanner reported findings)"
if [ $tool_failed -ne 0 ]; then
  echo "scan-dependencies[$STAGE]: WARNING — a scanner failed to run; inspect *.stderr.txt" >&2
fi
[ $STRICT -eq 1 ] && [ $findings_any -ne 0 ] && exit 2
[ $tool_failed -ne 0 ] && exit 3
exit 0

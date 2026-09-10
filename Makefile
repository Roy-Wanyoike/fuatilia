# Fuatilia — developer entrypoints (issue #138).
#
# Targets:
#   make gate    — the full merge gate: typecheck + vitest (root & frontend)
#                  + gofmt/go vet/go test (backend-go, -race, real PostgreSQL)
#   make up      — boot the full local stack (compose build + detached up)
#   make down    — stop the stack (volumes kept; `docker compose down -v`
#                  wipes data, run it by hand when you mean it)
#   make logs    — follow compose logs
#   make smoke   — curl health/meta through the running stack (see below)
#   make validate— static deploy validator (scripts/validate_deploy.py)
#
# Prerequisites:
#   Node >= 22 (root + frontend npm installs; `npm ci` runs on first use),
#   Go toolchain on PATH (gofmt/go), and — for the Go/PG test suites — the
#   trust-auth PostgreSQL 16 lane cluster on 127.0.0.1:5435 (this sandbox:
#   scripts/boot_pg.sh → /home/z/tools/pgsql; the suites refuse to skip, so
#   an unreachable cluster fails the gate loudly instead of passing green).
#   `up`/`down`/`logs`/`smoke` need a Docker engine with `docker compose` v2.
#
# Test-cluster knobs (override on the command line, e.g.
#   make gate FUATILIA_TEST_PGBIN=/usr/lib/postgresql/16/bin):
FUATILIA_TEST_PGBIN ?= /home/z/tools/pg164/bin
FUATILIA_TEST_DATABASE_URL ?= postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test

COMPOSE ?= docker compose
API_URL ?= http://127.0.0.1:8080
WEB_URL ?= http://127.0.0.1:3000

.PHONY: help gate typecheck vitest gofmt govet gotest validate up down logs smoke

help:
	@echo "fuatilia — make targets"
	@echo "  gate        full merge gate (typecheck + vitest + gofmt/vet/go test)"
	@echo "  typecheck   tsc --noEmit for the TS core (src/) and the frontend"
	@echo "  vitest      vitest suites (root needs the PG cluster, frontend is jsdom)"
	@echo "  gofmt       gofmt -l must list nothing (backend-go)"
	@echo "  govet       go vet ./... (backend-go)"
	@echo "  gotest      go test ./... -race against the real PG cluster (backend-go)"
	@echo "  validate    static deploy validator (compose/Dockerfiles/env contract)"
	@echo "  up          docker compose up -d --build (full local stack)"
	@echo "  down        docker compose down (data volumes kept)"
	@echo "  logs        docker compose logs -f --tail=200"
	@echo "  smoke       curl /v1/health + /v1/meta + web + BFF seam through the stack"

# --- the gate ----------------------------------------------------------------
# One target, the whole contract: fast static TS checks first, then the test
# suites, then Go. Everything must be green — mirrors what the orchestrator
# runs before merging (worklog precedent, issues #72-#138).
gate: typecheck vitest gofmt govet gotest
	@echo "== gate: ALL GREEN =="

typecheck:
	@echo "== typecheck: root (src/) =="
	@[ -d node_modules ] || npm --prefix . ci
	npm --prefix . run typecheck
	@echo "== typecheck: frontend =="
	@[ -d frontend/node_modules ] || npm --prefix frontend ci
	npm --prefix frontend run typecheck

vitest:
	@echo "== vitest: root (src/) — real PostgreSQL persistence adapters =="
	@[ -d node_modules ] || npm --prefix . ci
	FUATILIA_TEST_DATABASE_URL='$(FUATILIA_TEST_DATABASE_URL)' npm --prefix . test
	@echo "== vitest: frontend (jsdom) =="
	@[ -d frontend/node_modules ] || npm --prefix frontend ci
	npm --prefix frontend test

gofmt:
	@echo "== gofmt: backend-go =="
	@unformatted=$$(cd backend-go && gofmt -l .) ; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt found unformatted files:"; echo "$$unformatted"; exit 1; \
	fi; echo "gofmt: clean"

govet:
	@echo "== go vet: backend-go =="
	cd backend-go && go vet ./...

gotest:
	@echo "== go test: backend-go (-race, FUATILIA_TEST_PGBIN=$(FUATILIA_TEST_PGBIN)) =="
	cd backend-go && FUATILIA_TEST_PGBIN='$(FUATILIA_TEST_PGBIN)' go test ./... -race

# --- deploy static validation -------------------------------------------------
validate:
	python3 scripts/validate_deploy.py

# --- full local stack (docker compose v2) -------------------------------------
# Compose refuses to interpolate without POSTGRES_PASSWORD/DATABASE_URL, and a
# stack booted with CHANGE_ME placeholders would be an accident waiting to
# happen — preflight before touching the daemon.
up:
	@if [ ! -f .env ]; then \
		echo "no .env — run: cp .env.example .env  (then set POSTGRES_PASSWORD and DATABASE_URL)"; exit 1; fi
	@if grep -q 'CHANGE_ME' .env; then \
		echo ".env still carries CHANGE_ME placeholders — generate secrets (openssl rand -hex 24) before 'make up'"; exit 1; fi
	$(COMPOSE) up -d --build
	@echo
	$(COMPOSE) ps
	@echo "stack up — web console: $(WEB_URL) · api: $(API_URL)/v1/meta · smoke: make smoke"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

# --- smoke: prove the stack end-to-end over plain HTTP ------------------------
# Four probes, each proving a different seam:
#   1. GET  api:/v1/health      — the Go service answers with PostgreSQL behind
#                                 it (boot order: healthy postgres → migrate →
#                                 api) — the container healthcheck's target.
#   2. GET  api:/v1/meta        — the public capability list is served.
#   3. GET  web:/               — the Next standalone server renders (the
#                                 frontend image healthcheck's target).
#   4. GET  web:/api/v1/health  — the BFF seam. WITHOUT a session cookie the
#                                 relay must refuse with the contract's 401
#                                 envelope (fail-closed) — so 401 IS the
#                                 expected pass, proving web→api wiring AND
#                                 auth enforcement in one probe.
smoke:
	@set -e; \
	echo "== smoke 1/4: api /v1/health =="; \
	curl -fsS --max-time 10 $(API_URL)/v1/health; echo; \
	echo "== smoke 2/4: api /v1/meta =="; \
	curl -fsS --max-time 10 $(API_URL)/v1/meta | head -c 400; echo; \
	echo "== smoke 3/4: frontend / =="; \
	code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $(WEB_URL)/); \
	echo "GET $(WEB_URL)/ -> $$code"; test "$$code" = "200"; \
	echo "== smoke 4/4: BFF seam fail-closed (expect 401 without a session) =="; \
	code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $(WEB_URL)/api/v1/health); \
	echo "GET $(WEB_URL)/api/v1/health -> $$code"; test "$$code" = "401"; \
	echo "== smoke: ALL PROBES PASSED =="

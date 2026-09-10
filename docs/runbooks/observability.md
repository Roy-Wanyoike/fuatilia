# Runbook — Observability: what is wired, what is not, and what to do meanwhile

Scope: the observability lane `backend-go/internal/observability/` (issue #88,
landed via PR #159 — tracing, Prometheus metrics, redacted structured logging
as three injected ports). This runbook exists to keep the pager honest: it
catalogs the real series, states plainly what is and is NOT mounted, and
gives the interim (SQL/log) dashboards that work today.
Entry point: [on-call-triage.md](on-call-triage.md).

## Wiring status — the honest ledger (do not fake dashboards)

| Capability | State | Evidence |
|---|---|---|
| Metrics library (`fuatilia_*` series, private registry) | **landed** | `backend-go/internal/observability/metrics.go` |
| HTTP middleware (W3C trace context, duration histogram, panic capture + re-raise, requestId/traceId log context) | **landed** | `backend-go/internal/observability/middleware.go` |
| Tracing (OTLP/HTTP exporter, standard `OTEL_*` env, no-op without endpoint) | **landed** | `backend-go/internal/observability/tracing.go` |
| Redacted slog JSON (`FUATILIA_LOG_LEVEL`; keys containing authorization/password/token/secret/credential never reach the wire) | **landed** | `backend-go/internal/observability/logging.go` |
| Kernel composition: `Middleware()` wrapping the transport kernel, `/metrics` route mounted | **NOT wired** | grep on main @ 5280e0a: zero imports of `internal/observability` outside the package; no `/metrics` in `internal/transport/routes.go` |
| Relay backlog probes: `BacklogSource` implemented by `internal/outbox`, counters added per cycle | **NOT wired** | no references outside `observability` (`metrics.go` documents the seam: "the next wave wires …") |
| Compose collector / Prometheus scraper service | **NOT present** | `docker-compose.yml` ships five services, deliberately no collector ([docs/DEPLOY.md § Observability](../DEPLOY.md)) |

**Follow-ups carry issue refs, never invented dashboards.** Issue #88 (closed)
delivered the library; the wiring work above is the stated "next wave" in
`backend-go/internal/observability/doc.go` and is tracked in the #144
follow-up ledger — **file a dedicated issue before wiring** (composition
snippet in `doc.go` is the pinned contract). Until then: `/metrics` does not
exist on the API; any dashboard you see claiming `fuatilia_*` series is
fiction.

## The series catalog (real names from `metrics.go`, ready for wiring day)

| Series | Type | Labels | Meaning |
|---|---|---|---|
| `fuatilia_outbox_lag_rows` | gauge | — | pending `outbox_events` rows awaiting publication |
| `fuatilia_outbox_lag_oldest_seconds` | gauge | — | age of the oldest pending row |
| `fuatilia_outbox_dlq_depth` | gauge | — | poisoned rows (requeueable via `worker replay poisons`) |
| `fuatilia_outbox_dlq_in_total` | counter | — | cumulative rows moved into the DLQ |
| `fuatilia_outbox_published_total` | counter | — | envelopes published to JetStream (at-least-once) |
| `fuatilia_outbox_failed_total` | counter | — | failed publish attempts (retried up to the budget) |
| `fuatilia_http_requests_total` | counter | method, route, status | served requests (route = low-cardinality resolver, never URL path; unknown → `unresolved`) |
| `fuatilia_http_request_duration_seconds` | histogram | method, route, status | 5ms–10s SLO ladder (`HTTPDurationBuckets`) |
| `fuatilia_http_request_bytes_total` / `fuatilia_http_response_bytes_total` | counters | method, route, status | body sizes |
| `fuatilia_http_panics_total` | counter | method, route | panics captured AND re-raised |
| `fuatilia_pg_pool_acquired` / `_idle` / `_total` / `_max` | gauges | — | pgxpool stats (registered only when `SetPoolSource` is wired) |

Note the push model: lag/DLQ gauges refresh from the relay's own per-cycle
probe (`RefreshBacklog`) — **the scrape never touches the database**, and a
failed probe leaves gauges untouched rather than presenting stale data as
fresh.

## Interim dashboards that DO exist today

1. **stdout JSON** — the aggregation story ([docs/DEPLOY.md § Observability](../DEPLOY.md)):
   ```sh
   docker compose logs -f --tail=200                 # all services
   docker compose logs --since=15m worker | grep -E 'outbox\.(cycle|poisoned|publish_failed)'
   ```
   Worker relay cycles log `lag_rows` / `lag_oldest_ms` / published / failed /
   poison counts (`relay.go` RunOnce) — the same numbers the gauges will carry.
2. **Health surfaces**: `GET /v1/health` (api, public, healthcheck target),
   `GET /v1/meta`, `docker compose ps`; NATS monitor `/healthz`
   (container-internal only).
3. **The SQL pack** — the real dashboards until wiring lands:
   [outbox-lag.md](outbox-lag.md) Q1–Q6, [dlq-drain.md](dlq-drain.md) D1–D2,
   [webhook-failure-burst.md](webhook-failure-burst.md) W1–W5,
   [daraja-outage.md](daraja-outage.md) P1–P3.

## Env contract (for wiring day)

- `FUATILIA_LOG_LEVEL` = `debug|info|warn|error` (default info;
  `logging.go` `LevelFromEnv`).
- Standard OTel names only (`tracing.go`): `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `_TRACES_ENDPOINT`, `_HEADERS`, `_TIMEOUT`, `_INSECURE`,
  `OTEL_TRACES_SAMPLER`(+`_ARG`), `OTEL_SERVICE_NAME`,
  `OTEL_RESOURCE_ATTRIBUTES`. **No endpoint configured = no-op provider** —
  boot never requires a collector; W3C tracecontext + baggage propagation is
  always active.
- Metrics disabled mode serves a valid EMPTY exposition; the private registry
  never leaks foreign series.
- Compose note: adding any `OTEL_*` / metrics env to `docker-compose.yml`
  triggers the `.env.example` ↔ compose contract validator
  (`scripts/validate_deploy.py`) — document the keys in `.env.example` in the
  same PR (and land the known `PATH` allowlist fix flagged in deploy.md).

## Proposed alerts (PROPOSAL — nothing is deployed; do not treat as live)

- `fuatilia_outbox_lag_oldest_seconds > 900` for 5m → [outbox-lag.md](outbox-lag.md)
- `fuatilia_outbox_dlq_in_total` increasing for 15m → [dlq-drain.md](dlq-drain.md)
- `rate(fuatilia_http_panics_total[5m]) > 0` → page (panics are re-raised; a 500 wave means a real defect)
- `fuatilia_http_request_duration_seconds` p95 beyond the SLO ladder's 1s rung on money-path routes → investigate
- webhook dead-letter growth (SQL W4 until the delivery worker is wired) → [webhook-failure-burst.md](webhook-failure-burst.md)

## Escalation

- "The metric says X" during an incident when nothing is wired → the metric
  cannot exist; re-ground on the SQL pack above before acting.
- Wiring the observability lane is **kernel-touching work** (imports in
  `cmd/api`, `internal/transport`, `internal/outbox`) — it is NOT a docs/runbooks
  change: file the issue, route to the Go backend lane, keep this runbook's
  ledger updated in the same PR that wires it.

## References

- [backend-go/internal/observability/metrics.go](../../backend-go/internal/observability/metrics.go) — the registry, every series above
- [backend-go/internal/observability/middleware.go](../../backend-go/internal/observability/middleware.go) — trace context, panic capture, requestId contract
- [backend-go/internal/observability/doc.go](../../backend-go/internal/observability/doc.go) — composition contract (the "next wave" wiring snippet)
- [backend-go/internal/observability/logging.go](../../backend-go/internal/observability/logging.go) — levels + redaction guarantee
- [docs/DEPLOY.md](../DEPLOY.md) § Observability — the documented attach points

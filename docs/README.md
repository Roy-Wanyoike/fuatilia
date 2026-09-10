# Fuatilia — Documentation Hub

Everything the code proves, the design intends, and the ops need — indexed. Start here if
you are new; every document is traceable to the tree it describes. The product story and
gate numbers live in the root [README](../README.md).

## Start here

| Doc | What it gives you |
|-----|-------------------|
| [Root README](../README.md) | What Fuatilia is, the architecture map, R1–R10, real gate numbers, 60-second quickstart |
| [01 — Context map](01-context-map.md) | The 9 bounded contexts and the golden rule about fund truth |
| [02 — Domain model](02-domain-model.md) | Aggregates, entities, and the v2 changes (new entities + corrections) |
| [03 — State machines](03-state-machines.md) | Every lifecycle, diagrammed (Mermaid) |
| [04 — Event catalog](04-event-catalog.md) | The 27 core domain events, their payloads, and the outbox envelope contract |
| [05 — Data dictionary](05-data-dictionary.md) | Fields, constraints, unique keys, posting matrix |
| [06 — Review findings](06-review-findings.md) | C1–C5 critical, H1–H7 high, K1–K6 Kenya compliance findings |
| [07 — Invariants](07-invariants.md) | R1–R10 — the testable rules the code must guarantee (mirrored as DDL in [`db/`](../db/README.md)) |
| [08 — Build plan](08-build-plan.md) | Three phases, wave order, definition of done |

## Architecture, positioning, long-term thinking

| Doc | What it gives you |
|-----|-------------------|
| [VISION](VISION.md) | The 10–15 year thesis: the receivables intelligence layer that AI agents, payment rails, banks and ERPs plug into |
| [SPEC](SPEC.md) | Master build-requirements brief (stack sections superseded by the TypeScript-decision + Go-kernel split) |
| [DECISIONS](DECISIONS.md) | ADRs — PostgreSQL is the only financial truth (ADR-0002), NATS JetStream fabric (ADR-0003), Go as production kernel with TS as behavioral spec (ADR-0001) |
| [design/diagrams](design/diagrams/README.md) | Rendered review figures: context map, money flow, 5 ER clusters, 7 state machines |

## Operations

| Doc | What it gives you |
|-----|-------------------|
| [DEPLOY](DEPLOY.md) | The compose stack (PG → migrate → NATS → api → worker → frontend), the full env contract, and what the static validator does and does not prove |
| [ops/CI-BILLING-BLOCKER](ops/CI-BILLING-BLOCKER.md) | Why GitHub Actions is red (account billing lock, with evidence), the owner unblock steps, and local-gate parity commands |
| [db/](../db/README.md) | The 14 migrations, the invariant-per-DDL map, and `validate.sh` — 25 assertions proven on a real cluster |
| [Makefile](../Makefile) | `make gate` (the full merge gate) · `make up` / `smoke` (the stack) · `make validate` |

## Honest status

| Doc | What it gives you |
|-----|-------------------|
| [ENGINEERING_STATUS](ENGINEERING_STATUS.md) | The verified facts board (test counts, blockers, NOT-STARTED rows) as of its commit of record |
| [PRODUCTION_AUDIT](PRODUCTION_AUDIT.md) | The wave-8 audit: evidence paths behind every status claim |
| [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) | P0 → P2 production plan and rationale |
| [API_STATUS](API_STATUS.md) | Route-by-route truth table for the mounted `/v1` surface vs the OpenAPI contract |
| [BACKLOG](BACKLOG.md) | Live dispatch board — waves 1–11, one row = one PR-sized feature |

## Research

| Doc | What it gives you |
|-----|-------------------|
| [research/market-analysis](research/market-analysis.md) | The African AR/collections market landscape |
| [research/product-gaps](research/product-gaps.md) | Where existing tools fail SMEs — the wedge Fuatilia exploits |
| [research/investor-brief](research/investor-brief.md) | The investor-facing summary of the thesis |

## Lane guides (per-package READMEs in the tree)

The kernel is documented where it lives. Every lane ships its own README with its contract,
refusal taxonomy, and proof tests:

- **TS domain kernel** — `src/domain/<lane>/README.md` (25 lanes documented; the kernel itself
  is pure: no I/O, injected clock/RNG)
- **TS adapters** — [`src/adapters/daraja`](../src/adapters/daraja/README.md) (conformance suite),
  [`http`](../src/adapters/http/README.md) (TS /v1 kernel), [`intake`](../src/adapters/intake/README.md),
  [`bankfeed`](../src/adapters/bankfeed/README.md), [`comm-sms`](../src/adapters/comm-sms/README.md),
  [`comm-email`](../src/adapters/comm-email/README.md), [`comm-whatsapp`](../src/adapters/comm-whatsapp/README.md)
- **Go production kernel** — [`backend-go/README.md`](../backend-go/README.md) (layout + conformance
  philosophy), [`internal/outbox`](../backend-go/internal/outbox/README.md) (relay guarantees),
  [`internal/webhooks`](../backend-go/internal/webhooks/README.md) (delivery guarantees table with
  proof tests), [`internal/daraja`](../backend-go/internal/daraja/README.md) (error taxonomy)
- **Schema** — [`db/README.md`](../db/README.md) (migration-by-migration invariant map)
- **Deploy** — [`docker-compose.yml`](../docker-compose.yml) (annotated boot order) + [DEPLOY](DEPLOY.md)

## Contributing

`CONTRIBUTING.md` + `ARCHITECTURE.md` — the engineering handbook — are **landing in
[Roy-Wanyoike/fuatilia#141](https://github.com/Roy-Wanyoike/fuatilia/issues/141)**. Until then:
features land as PRs that close a tracked issue, squash-merged only with the full gate green
(`make gate`), AI never owns financial truth (R1–R10), no mocks in production paths, and no
credentials in files or commits. The wave-by-wave working history is the root
[README "How we ship"](../README.md#how-we-ship).

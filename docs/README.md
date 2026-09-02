# Fuatilia — Design Docs

Target-state design (v2) for the AR & Collections platform, incorporating every accepted
finding from the domain model review. Start here if you are new:

| Doc | What it gives you |
|-----|-------------------|
| [01 — Context map](01-context-map.md) | The 9 bounded contexts and the golden rule about fund truth |
| [02 — Domain model](02-domain-model.md) | Aggregates, entities, and the v2 changes (new entities + corrections) |
| [03 — State machines](03-state-machines.md) | Every lifecycle, diagrammed (Mermaid) |
| [04 — Event catalog](04-event-catalog.md) | The 27 core domain events and their payloads |
| [05 — Data dictionary](05-data-dictionary.md) | Fields, constraints, unique keys, posting matrix |
| [06 — Review findings](06-review-findings.md) | C1–C5 critical, H1–H7 high, K1–K6 Kenya compliance |
| [07 — Invariants](07-invariants.md) | R1–R10, the testable rules the code must guarantee |
| [08 — Build plan](08-build-plan.md) | Three phases, wave order, definition of done |
| [BACKLOG](BACKLOG.md) | Dispatchable feature list with live status |

Working agreements for engineers and agents are in the root [README](../README.md#how-we-ship).

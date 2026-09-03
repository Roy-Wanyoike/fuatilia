# `domain/webhooks` — developer-platform delivery contracts (issue #47, SPEC §53)

The pure-domain half of the developer platform: webhook **endpoints**, **subscriptions**,
the **signing contract**, and the **delivery lifecycle** that a future transport mounts.
No HTTP, no crypto libraries — HMAC computation stays behind an injected `DigestPort`,
entropy behind an injected `generateSecret`.

## Modules

| File | Owns |
|---|---|
| `events.ts` | Lane envelope + 11 `webhook.*` events (`WEBHOOK_CLOCK_INVALID` guard via `webhookNow`) |
| `subscription.ts` | Pattern grammar (`payment.confirmed` exact / `payment.*` wildcard over the known context table) + the total, never-throwing matcher |
| `endpoint.ts` | Org-scoped endpoint registry: URL validation (https-only, SSRF-guarded, no userinfo), lifecycle `active → paused → active`, `→ revoked` (terminal, reason mandatory), secret returned ONCE (record carries only the non-reversible `secretRef`), idempotent subscription append |
| `signing.ts` | Canonical string `<unixMillis>.<payload>`, header `t=<unixMillis>,v1=<hex>`; decision table `MALFORMED → STALE_TIMESTAMP → MISMATCH → VERIFIED`; per-delivery idempotent verification ledger (replays return the SAME decision; replayed rejections re-emit with `replay: true`) |
| `attempts.ts` | `planDelivery` refusal values (`ENDPOINT_REVOKED` / `ENDPOINT_PAUSED` / `NOT_SUBSCRIBED` / `PAYLOAD_TOO_LARGE`) each paired with `webhook.deliveryRefused`; idempotent enqueue (active duplicate → `WEBHOOK_DELIVERY_DUPLICATE`, id unique forever); attempt lifecycle `queued → delivering → delivered` with bounded ascending retry ladder → `deadLettered`; append-only attempt log |

## Invariants

1. **A revoked endpoint never plans deliveries** — checked before every other consideration.
2. **Every refusal is observable** — `planDelivery` refusals are VALUES + `webhook.deliveryRefused` facts.
3. **The queue never double-sends** — an active (queued|delivering) delivery for the same
   (endpointId, eventId) is refused; delivery ids are unique forever.
4. **Attempts are append-only facts** — outcomes are logged, never edited; the ladder is
   strictly ascending positive steps (`WEBHOOK_RETRY_LADDER_INVALID`); exhaustion is an
   explicit dead-letter terminal (two facts, one transition).
5. **Secrets never persist or travel** — the plaintext secret exists only in the
   registration result; records carry `secretRef`; `WEBHOOK_HASH_NOT_IRREVERSIBLE`
   refuses a hash port that echoes the secret; no event payload carries secret material
   (pinned by tests).
6. **Verification is idempotent (R9-style)** — one decision per (endpointId, deliveryId),
   sticky in the injected ledger; replays re-audit but never re-compute.

## Stable error codes

`WEBHOOK_URL_TOO_LONG`, `WEBHOOK_URL_MALFORMED`, `WEBHOOK_URL_INSECURE`,
`WEBHOOK_URL_FORBIDDEN_HOST`, `WEBHOOK_LABEL_REQUIRED`, `WEBHOOK_LABEL_TOO_LONG`,
`WEBHOOK_DESCRIPTION_TOO_LONG`, `WEBHOOK_SECRET_MALFORMED`, `WEBHOOK_SECRET_REF_MALFORMED`,
`WEBHOOK_HASH_NOT_IRREVERSIBLE`, `WEBHOOK_REASON_REQUIRED`, `WEBHOOK_TRANSITION_INVALID`,
`WEBHOOK_SUBSCRIPTION_MALFORMED`, `WEBHOOK_EVENT_PREFIX_UNKNOWN`, `WEBHOOK_TIMESTAMP_INVALID`,
`WEBHOOK_PAYLOAD_REQUIRED`, `WEBHOOK_SECRET_REQUIRED`, `WEBHOOK_SKEW_INVALID`,
`WEBHOOK_RETRY_LADDER_INVALID`, `WEBHOOK_EVENT_MALFORMED`, `WEBHOOK_DELIVERY_ID_TAKEN`,
`WEBHOOK_DELIVERY_DUPLICATE`, `WEBHOOK_DELIVERY_NOT_QUEUED`, `WEBHOOK_DELIVERY_NOT_DELIVERING`,
`WEBHOOK_FAILURE_REASON_REQUIRED`, `WEBHOOK_CLOCK_INVALID`.

## Events

`webhook.endpointRegistered` · `webhook.endpointPaused` · `webhook.endpointResumed` ·
`webhook.endpointRevoked` · `webhook.subscriptionAdded` · `webhook.deliveryQueued` ·
`webhook.deliverySucceeded` · `webhook.deliveryFailed` · `webhook.deliveryDeadLettered` ·
`webhook.deliveryRefused` · `webhook.signatureRejected` — repo envelope v1, narrow
serializable payloads, ISO timestamps.

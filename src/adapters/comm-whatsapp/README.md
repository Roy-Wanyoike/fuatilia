# WhatsApp Cloud API runtime provider adapter (`src/adapters/comm-whatsapp/`)

**Issue #128 (wave 11c)** — the production WhatsApp adapter behind the EXISTING
`MessagingProvider` seam (`src/domain/communications/provider.ts`, which this
lane does NOT modify), mirroring `../comm-sms/` exactly: an injected fetch
(the GLOBAL fetch type, no new deps), Meta WhatsApp Cloud API **template
message sends**, token from config only, Kenya phone normalization to E.164,
delivery/read receipt ingestion as structured events, and a typed refusal
taxonomy where malformed API responses are REFUSALS, never throws.

## Files

| File | Role |
|---|---|
| `transports.ts` | The injected `HttpFetch` port (`typeof fetch`) + PURE codecs: template request builder (URL/headers/body — asserted against Meta's documented wire contract), response parser, the refusal-taxonomy classifier, Kenya MSISDN normalization (`+2547…`/`07…`/`25407…` → `2547XXXXXXXX` E.164 wa_id) with last-4 masking, env config loader. **No credentials hardcoded, no full numbers in error strings.** |
| `idempotency.ts` | Wire-layer idempotency (R9 for comms): durable (key → result) store port + `withWireIdempotency` wrapper — the crash window between "Cloud API accepted" and "worker persisted" replays the recorded wamid instead of re-charging. Concurrent followers are refused (`WA_IN_FLIGHT`); stale reservations are reclaimed by a 5-minute lease. Keys compose over the NORMALIZED wa_id + per-attempt clientRef. |
| `provider.ts` | The seam wiring: `dispatchToOutcome` (async worker half) → `preResolvedProvider` (satisfies the PURE `MessagingProvider` port) → the domain's own `attemptSend` ladder. Plus `withConsentRequirement` (fail-closed consent boundary, defence in depth behind `guard.ts`), Meta webhook status parsing (delivery/read receipts → verdicts → the pure `markDelivered`/`markRead`/failure paths → `comms.*` structured events), and `policyForWireResult` (PERMANENT refusals collapse the ladder to one attempt — never wasted retries). |

## Worker wiring (documented contract)

```
WhatsAppTemplateSend { to, templateName, languageCode, bodyParams, clientRef: "<messageId>#<attemptNo>" }
  → whatsappCloudTransport(config, fetch).dispatch(req)   (wire, injected fetch)
  → dispatchToOutcome(transport, req)                      (ProviderOutcome value)
  → preResolvedProvider('whatsapp', outcome)               (pure port)
  → attemptSend(conversation, messageId, provider, cmd, policyForWireResult(...), clock)
```

Inbound receipts (the webhook half):

```
Meta webhook JSON → parseWhatsAppStatusWebhook → verdict VALUES
  delivered → markDelivered → comms.messageDelivered
  read      → markRead       → comms.messageRead
  failed    → the message-failure path → comms.messageFailed
```

## Environment contract

| Variable | Meaning |
|---|---|
| `WA_PHONE_NUMBER_ID` | The sending phone number id of the WhatsApp Business Account |
| `WA_ACCESS_TOKEN` | Bearer token (system-user access token) |
| `WA_API_VERSION` | Optional Graph API version override (`v21.0` default) |

Credentials are env-only, never logged, never echoed; the config loader
refuses to build without them. The loader is the ONLY place the env is read.

## Refusal taxonomy (malformed responses = structured refusals, never throws)

| Signal | Refusal | Retryable |
|---|---|---|
| HTTP 401, or Graph code 190 | `WA_AUTH_REJECTED` | no |
| HTTP 429, or Graph code **131048** (rate limit hit) | `WA_RATE_LIMITED` | **yes** |
| Graph code 131047 (re-engagement / 24h window) | `WA_WINDOW_CLOSED` | no |
| Graph code 131026 (undeliverable) | `WA_RECIPIENT_UNDELIVERABLE` | no |
| Graph codes 132000 / 132001 (param/template rejected) | `WA_TEMPLATE_REJECTED` | no |
| other `13xxxx` business refusals | `WA_PROVIDER_REFUSED_<code>` | no |
| other Graph codes (4xx) | `WA_PROVIDER_ERROR_<code>` | no |
| HTTP 5xx | `WA_PROVIDER_OUTAGE_<status>` | yes |
| non-JSON body / missing `messages[0].id` | `WA_WIRE_MALFORMED(_NO_MESSAGE_ID)` | per status class |
| fetch / body-read faults | `WA_NETWORK_ERROR: <cause>` | yes |

Retryability is transport knowledge carried on the refusal; the retry
DECISION stays with the domain's pure `decideRetry` policy
(`policyForWireResult` only collapses PERMANENT refusals to one attempt).
Meta error messages can embed recipient numbers — long digit runs are
scrubbed to `****` everywhere a provider message reaches a refusal string.

## Semantics worth knowing

- **Template-only sends**: business-initiated WhatsApp messages REQUIRE a
  pre-approved Meta template (no free-text mode outside the 24h window), so
  the wire request is always `type: 'template'` with positional body
  parameters; template name and language-code shape are refused BEFORE the
  wire.
- **Phone normalization discipline**: input formats `+254712345678`,
  `254712345678`, `2540712345678`, `0712345678`, `712345678` (with ` `/`-`
  separators) all normalize to the E.164 wa_id `254712345678`; anything that
  cannot normalize to a Kenyan mobile is refused (masked, never echoed).
  Unfixable phones are refused before idempotency claims are taken, so a
  malformed dispatch can never leak a store placeholder.
- **Consent is enforced twice by design**: the domain guard (upstream,
  consent-trail aware) AND `withConsentRequirement` at the boundary
  (injected probe; a broken probe fails CLOSED).
- **Every attempt is its own chargeable call**: the idempotency key is
  per-message-PER-attempt (`wa:<waId>:<messageId>:<attemptNo>`).
- **Receipts are facts, not guesses**: only well-formed statuses become
  verdicts; `deleted` is filtered (not a delivery fact this lane acts on);
  malformed entries throw `WA_CALLBACK_MALFORMED` so the worker dead-letters
  the webhook for review instead of inventing state.
- Tests never touch network: recorded fake fetches (real platform
  `Request`/`Response`), scripted transports, injectable clock. Fakes live
  ONLY in `*.spec.ts`.

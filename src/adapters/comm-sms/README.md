# SMS runtime provider adapter (`src/adapters/comm-sms/`)

**RICE #1 / issue #95 (wave 11, lane 11-b)** — the production messaging adapter behind the
EXISTING `MessagingProvider` seam (`src/domain/communications/provider.ts`, which this lane does
NOT modify). Two wire transports selected by config: **Africa's Talking SMS** and
**Twilio-compatible REST**. The lane recovered a partially-delivered draft from a dead agent run;
the dispatcher re-verified and rebuilt the surface below (design notes salvaged from the draft:
per-failure-class policy selection and wire-layer idempotency).

## Files

| File | Role |
|---|---|
| `transports.ts` | The injected `HttpPost` port + PURE codecs per provider: request builders (URL/headers/body — asserted against the documented wire contracts), response parsers, error classifier (auth / rate-limit / outage / per-recipient refusal), MSISDN validation with last-4 masking, env config loaders. **No credentials hardcoded, no full numbers in error strings.** |
| `provider.ts` | The seam wiring: `dispatchToOutcome` (async worker half) → `preResolvedProvider` (satisfies the PURE `MessagingProvider` port with a pre-resolved outcome) → the domain's own `attemptSend` ladder. Plus `withConsentRequirement` (fail-closed consent boundary, defence in depth behind `guard.ts`), status-callback parsers (Twilio form-encoded + AT delivery reports → verdicts), and `policyForWireResult` (PERMANENT refusals collapse the ladder to one attempt — never wasted retries). |
| `idempotency.ts` | Wire-layer idempotency (R9 for comms): durable (key → result) store port + `withWireIdempotency` wrapper — the crash window between "provider accepted" and "worker persisted" replays the recorded providerRef instead of re-charging. Concurrent followers are refused (`SMS_IN_FLIGHT`); stale reservations are reclaimed by a 5-minute lease. |

## Worker wiring (documented contract)

```
SmsTransport.dispatch({ to, body, clientRef: "<messageId>#<attemptNo>" })
  → Promise<SmsWireResult>                       (wire, injected HttpPost)
  → dispatchToOutcome(transport, req)            (ProviderOutcome value)
  → preResolvedProvider(name, outcome)           (pure port)
  → attemptSend(conversation, messageId, provider, cmd, policyForWireResult(...), clock)
```

## Environment contract

| Provider | Variables |
|---|---|
| Africa's Talking | `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` (optional), `AT_BASE_URL` (optional override in wiring) |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` |

Credentials are env-only, never logged, never echoed; config loaders refuse to build without them.

## Semantics worth knowing

- **Consent is enforced twice by design**: the domain guard (upstream, consent-trail aware) AND
  `withConsentRequirement` at the boundary (injected probe; a broken probe fails CLOSED).
- **Retryability is transport knowledge; the DECISION is domain policy**: permanent refusals
  (invalid recipient, auth, blacklist) get a maxAttempts-1 policy — immediate terminal dead-letter;
  retryable refusals (rate limit, outage, network) ride the org's standard ladder.
- **Every attempt is its own chargeable call**: the idempotency key is per-message-PER-attempt.
- Tests never touch network: recorded fake `HttpPost`, scripted transports, injectable clock.

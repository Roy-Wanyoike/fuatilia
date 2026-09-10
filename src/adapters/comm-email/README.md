# Email runtime provider adapter (`src/adapters/comm-email/`)

**Issue #127 (wave 11c, lane A-6)** — the production messaging adapter behind the
EXISTING `MessagingProvider` seam (`src/domain/communications/provider.ts`, which this lane does
NOT modify), mirroring `src/adapters/comm-sms/` pattern-for-pattern. One wire transport selected
by config: **SMTP against the org's relay**. The SMTP client (envelope validation, RFC 5322/MIME
message build, reply classification) sits BEHIND an injected `SmtpDeliver` transport — the same
shape as comm-sms's injected `HttpPost` — so the lane is network-free in tests and credentials
live only in the edge wiring.

## Files

| File | Role |
|---|---|
| `transports.ts` | The injected `SmtpDeliver` port + PURE codecs: RFC 5322/MIME message builder (deterministic Date + Message-ID under the injected Clock, base64 body parts, 76-char wrap), address validation with local-part masking, CR/LF header-injection guard, SMTP reply classifier (2xx accept / 4xx transient / 5xx permanent), env config loader. **No credentials hardcoded, no local parts in error strings, credentials never reach the wire.** |
| `provider.ts` | The seam wiring: `dispatchToOutcome` (async worker half) → `preResolvedProvider` (satisfies the PURE `MessagingProvider` port with a pre-resolved outcome) → the domain's own `attemptSend` ladder. Plus `withConsentRequirement` (fail-closed consent boundary, defence in depth behind `guard.ts`), DSN (RFC 3464 bounce) parsers → verdicts, and `policyForWireResult` (PERMANENT refusals collapse the ladder to one attempt — never wasted retries). |
| `idempotency.ts` | Wire-layer idempotency (R9 for comms): durable (key → result) store port + `withWireIdempotency` wrapper — the crash window between "relay accepted" and "worker persisted" replays the recorded Message-ID instead of re-sending. Concurrent followers are refused (`EMAIL_IN_FLIGHT`); stale reservations are reclaimed by a 5-minute lease. |

## Worker wiring (documented contract)

```
EmailTransport.dispatch({ to, subject, text, html?, clientRef: "<messageId>#<attemptNo>" })
  → Promise<EmailWireResult>                     (wire, injected SmtpDeliver)
  → dispatchToOutcome(transport, req)            (ProviderOutcome value)
  → preResolvedProvider(name, outcome)           (pure port)
  → attemptSend(conversation, messageId, provider, cmd, policyForWireResult(...), clock)
```

The SMTP acceptance carries NO provider-issued id, so the transport derives the `Message-ID`
header from the clientRef + clock and the accepted `providerRef` IS that bracketed Message-ID —
the handle every relay and DSN echoes back. clientRef is therefore REQUIRED on the email wire
request (the one deliberate divergence from the SMS shape, where the wire does not need it).

## Environment contract

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | Relay host — REQUIRED |
| `SMTP_PORT` | Relay port (default `587`) |
| `SMTP_FROM` | Org's verified sender (envelope + `From` default) — REQUIRED |
| `SMTP_RELAY_DOMAIN` | Message-ID domain override (defaults to the domain of `SMTP_FROM`) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | Relay auth (must be set together) — consumed by the edge session factory, never by codecs, never logged |

Credentials are env-only, never logged, never echoed; the config loader refuses to build without
the required pair. The socket-level session (STARTTLS/AUTH, connect/EHLO/MAIL FROM/RCPT TO/DATA)
is edge wiring that closes the `SmtpDeliver` port — a ~80-line TLS client or a nodemailer
transport wrapper, whichever the mounting worker lane chooses.

**Why nodemailer is NOT added here (justification per AC3):** the adapter's value — codecs,
taxonomy, idempotency, seam — needs no socket code, and the repo keeps the runtime dependency
surface minimal (`pg` only). Adding nodemailer now would introduce a production dependency with
zero call sites, a standing supply-chain risk ahead of the lane that actually mounts the rail.
The injected port keeps that choice local to the wiring without weakening any AC.

## Semantics worth knowing

- **Consent is enforced twice by design**: the domain guard (upstream, consent-trail aware) AND
  `withConsentRequirement` at the boundary (injected probe; a broken probe fails CLOSED).
- **Retryability is transport knowledge; the DECISION is domain policy**: permanent refusals
  (unknown mailbox 550/551/553, policy 554, auth) get a maxAttempts-1 policy — immediate terminal
  dead-letter; transient refusals (greylisting 450, queueing 451/452, 421 outages, network errors,
  malformed replies) ride the org's standard ladder.
- **Untrusted input is refused, never normalized**: bare dot-atom addresses only (display-name
  and quoted forms are refused), fqdn domains, CR/LF guard on header fields, subject required,
  relay banners truncated — and DSN `Diagnostic-Code` text is deliberately NOT embedded in
  refusal reasons because diagnostics quote recipient addresses (redaction-safe metadata).
- **Every attempt is its own chargeable call**: the idempotency key is per-message-PER-attempt
  (`email:<to>:<messageId>:<attemptNo>`), replaying the recorded wire result — including recorded
  refusals — instead of re-sending.
- Tests never touch network: recorded fake `SmtpDeliver`, scripted transports, injectable clock.

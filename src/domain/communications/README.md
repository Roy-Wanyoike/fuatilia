# Communications module — wave 3 (issue #22, SPEC §26)

Owns the Unified Collections Inbox domain: one thread per (org, customer, channel)
across `whatsapp | sms | email`, the messages in it, the delivery attempts behind
every outbound send, the versioned template registry those messages render from,
and the **consent-before-send boundary (K2)** that every automated send must pass.

## Scope
- `Conversation` — unique per `(orgId, customerId, channel)`
  (`COMMS_CONVERSATION_EXISTS` on duplicates). Append-only `messages` thread and
  append-only consent `facts` trail. Opaque `Uuid` ids only — no cross-lane
  entity imports.
- `Message` — direction `in|out`, opaque `bodyRef` (bodies live in an adapter
  store; the domain keeps refs, not PII), optional pinned `templateRef`
  (`{ templateId, version }` — messages record the EXACT template version they
  were rendered from), `linkage` per SPEC §26 (`customerId` required;
  `caseId`/`promiseId`/`invoiceId` optional, all opaque), `sentAt`, `status`
  (`queued → sent → delivered → read`, `failed` = retry pending,
  `deadLettered` = terminal).
- `DeliveryAttempt` — `attemptNo` (1-based monotonic), `providerRef` (opaque,
  set when the provider accepts), `status`
  (`queued|sent|delivered|failed|read`), `failureReason`.
- **Templates (versioned, immutable)** — `registerTemplate` appends a frozen row
  keyed by `(orgId, name, channel, locale, version)`; re-registration of a
  version is `COMMS_TEMPLATE_VERSION_EXISTS` and rows are `Object.freeze`d.
  Bodies carry `{{placeholder}}` slots (`[a-zA-Z0-9_]+`); malformed syntax is
  rejected at registration. `renderTemplate` is deterministic and total:
  unknown value keys → `COMMS_TEMPLATE_VALUE_UNKNOWN`, missing values →
  `COMMS_TEMPLATE_VALUE_MISSING`; same inputs always render byte-identical
  output. `findTemplate`/`latestTemplate`/`nextTemplateVersion` navigate the
  registry; old versions never change.
- **Consent boundary (K2, core)** — `sendAutomatedMessage` is the ONLY path for
  automated outbound sends. It screens the conversation's consent fact trail:
  no `consentRef` on the command, a ref never granted on the conversation, or a
  ref whose latest fact is `consentRevoked` → refusal. A refusal is a VALUE
  carrying stable code `COMMS_SEND_BLOCKED_NO_CONSENT` plus the
  `comms.sendBlockedNoConsent` event (audit records every blocked attempt).
  Once `appendConsentRevoked` lands, ALL subsequent automated sends are blocked
  until a NEW `appendConsentGranted` fact (K3 re-consent). Manual agent replies
  (`queueOutboundMessage`) are not automated sends and bypass the gate.
- **Provider ports (pure)** — `MessagingProvider.send(cmd, attemptNo)` returns
  an outcome VALUE (`accepted` + providerRef | `rejected` + failureReason); the
  domain performs no I/O. `simulatedProvider(script)` is the deterministic test
  double (refs `<name>-<n>`, over-dispatch → `COMMS_PROVIDER_SCRIPT_EXHAUSTED`).
  `decideRetry(policy, failedAttemptNo)` is the pure retry ladder: retry with
  the next injected backoff step up to `maxAttempts`, then dead-letter —
  `attemptSend` applies it (failure → `comms.messageFailed` with `willRetry` +
  `retryAt` = clock + backoff; final failure → `deadLettered` +
  `comms.messageDeadLettered`). `markDelivered`/`markRead` advance receipts.
- **Inbound threading** — `routeInbound` matches (org, customer, channel); a
  miss returns the `comms.unmatchedInbound` FACT (never silently dropped). A
  match appends via `appendInboundMessage` (arrives `delivered`,
  `comms.inboundReceived`), preserving thread order.

## Events (`comms.*`, envelope `{ name, version: 1, aggregateId, payload, occurredAt }`)
`comms.conversationStarted`, `comms.messageSent`, `comms.messageDelivered`,
`comms.messageRead`, `comms.messageFailed`, `comms.messageDeadLettered`,
`comms.sendBlockedNoConsent`, `comms.inboundReceived`, `comms.unmatchedInbound`.
Aggregate conventions: conversation-scoped facts → conversation id;
message-scoped delivery facts → message id; `unmatchedInbound` → org id
(no conversation exists). Payloads are narrow/serializable (ids + ISO-8601).

## Rules
- Import ONLY from `../shared` + this lane. `customerId`, `caseId`,
  `promiseId`, `invoiceId`, `consentRef` are opaque `Uuid`s; the org-wide DPA
  consent registry lives in the consent lane and is projected into a
  conversation's fact trail at the boundary.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time via the injected
  `Clock` (backoff delays are applied against it, never slept on).
- Stable `DomainError` codes, `COMMS_*` prefix (`COMMS_CONVERSATION_EXISTS`,
  `COMMS_CHANNEL_INVALID`, `COMMS_TEMPLATE_*`, `COMMS_MESSAGE_*`,
  `COMMS_RETRY_*`, `COMMS_PROVIDER_*`, `COMMS_BODY_REF_REQUIRED`,
  `COMMS_CLOCK_INVALID`); the K2 refusal is the deliberate exception — a value,
  not a throw.

## Definition of done
- Retry→dead-letter ladder, consent-blocked sends (before/after revocation),
  template versioning immutability + placeholder validation, inbound
  threading/unmatched facts — all table-driven tested.
- `npm run typecheck && npm test` green.

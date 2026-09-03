# Auth & RBAC module — wave 6 (issue #46, SPEC §34/§35/§37)

Owns the pure domain core of authentication & authorization: org-scoped users,
the closed permission vocabulary, roles, append-only role grants, API keys
(machine principals), sessions, the deterministic `can`/`authorize` decision
core, and the audit events for every one of those decisions. **No HTTP, no
hashing libraries, no I/O** — password/API-key hashing stays behind an
injected `SecretCodec` port and time behind the injected `Clock`; the domain
owns the *decisions*.

## Scope
- `User` — org-scoped principal record (`userId`, opaque `orgId`, normalized
  `UserEmail`/`Username` values, `displayName`). Uniqueness is per org and a
  domain decision (`AUTH_EMAIL_TAKEN`, `AUTH_USERNAME_TAKEN`): the same email
  MAY exist in two orgs. Status lifecycle `active → suspended → active`
  (`suspendUser`/`reactivateUser`) and `→ deactivated` (terminal — rehiring
  creates a NEW user). `suspendUser` emits `auth.userSuspended` and is the
  fact the session/key cascades hang off.
- **Password credentials (injected port)** — `SecretCodec { hash, verify }` is
  a function parameter; the domain stores the hash it is handed
  (`recordPassword`), verifies with a boolean (wrong password ≠ exception),
  treats a missing record as "no" (no enumeration oracle), and refuses a
  broken port (`AUTH_HASH_PORT_INVALID`). Plaintext is never stored; SPEC §34.
- **Permissions & roles** — a CLOSED vocabulary of `"<resource>:<action>"
  strings (`PERMISSIONS`: receivables, payments, collections, adjustments,
  ledger, intelligence, admin, policy). Wildcards (`collections:*`) are legal
  ONLY inside role definitions — never per grant, never in key scopes
  (`AUTH_PERMISSION_WILDCARD_FORBIDDEN`). `defineRole` builds frozen,
  org-scoped, deduped roles (`AUTH_ROLE_NAME_TAKEN`, `AUTH_ROLE_ID_TAKEN`);
  `roleCovers`/`expandRolePermissions` interpret wildcards (the only place
  they are interpreted); `effectivePermissions` expands a principal's active
  grants into the concrete set (dangling grants confer nothing).
- **Role assignments (append-only facts)** — `grantRole` appends a
  `RoleGrant` fact (scoped `resourceId` optional for resource-level
  authorization). Same-role re-grant is IDEMPOTENT (original returned, no
  duplicate, no event); re-grant after revocation is a NEW fact
  (latest-fact-wins); revocation sets fields ON the fact, never deletes
  (`revokeRole` + `auth.roleRevoked`); revoking an unheld role is the stable
  error `AUTH_ROLE_NOT_HELD`. **Escalation guard**: granting requires
  `admin:manage-users` AND every permission the target role confers must sit
  in the granter's own effective set — the refusal is a DECISION VALUE
  (`AUTH_ESCALATION_BLOCKED` + reason `GRANTER_NOT_ADMIN` /
  `GRANTER_LACKS_PERMISSION` + `missing[]`) paired with the
  `auth.escalationBlocked` audit event (K2 precedent:
  communications/guard.ts). Grants never outlive the granter's authority.
- **API keys** — `issueKey` hashes the adapter-generated secret via the
  injected codec, keeps only the visible `prefix` (first 8 chars) + hash,
  validates concrete scopes (`AUTH_KEY_SCOPES_REQUIRED`), optional strictly-
  future expiry, and emits `auth.apiKeyIssued` (prefix + scopes only — never
  the secret, never the hash). `revokeKey` is an idempotent FACT +
  `auth.apiKeyRevoked`. `authenticateKey` is a decision path with audited
  denials: `KEY_UNKNOWN → KEY_SECRET_MISMATCH → KEY_REVOKED → KEY_EXPIRED
  (inclusive boundary) → KEY_OWNER_INACTIVE (suspension cascade)` — every
  denial is a VALUE carrying the stable KEY_* code AND `auth.accessDenied`;
  replay of a revoked key is denied + audited forever. Success stamps
  `lastUsedAt` via the clock and emits nothing.
- **Sessions** — dual-horizon lifecycle: idle timeout from `lastSeenAt` plus
  absolute lifetime cap from `createdAt` (an endlessly-touched session still
  dies at the cap). Expiry is inclusive at the boundary (usable ⇔
  `now < horizon`, ±1ms-tested). `touchSession` stamps activity and can never
  resurrect an expired session; `endSession` (logout) and `revokeSession`
  (admin/cascade kill) are distinct facts; `expireSession` is the sweeper and
  emits `auth.sessionExpired` with reason `idle | absolute`;
  `revokeSessionsForUser` is the session half of the suspension cascade.
- **Decision core** — `can(principal, permission, resource?)` is the
  deterministic permission matrix: ALLOW carries matched-rule EVIDENCE (rule
  + grant + role); DENY carries a machine-readable reason. Precedence:
  `PERMISSION_UNKNOWN` → principal-status denials (`PRINCIPAL_SUSPENDED` /
  `PRINCIPAL_DEACTIVATED` / `PRINCIPAL_REVOKED`) → `NO_GRANT` /
  `NOT_IN_RESOURCE_SCOPE`. `userPrincipal`/`apiKeyPrincipal` project
  aggregates into the decision input; `authorize(...)` adds the session gate
  (`SESSION_*` reasons) and wraps every denial as a decision VALUE +
  `auth.accessDenied` event — refusals are first-class facts, only malformed
  input (broken clock) throws.

## Invariants (issue #46 §7)
- **DENY by default** — unknown permission, unknown user, suspended,
  deactivated, expired session, unheld permission: every denial carries a
  reason code, and `authorize`/`authenticateKey` audit each one.
- **Grants never outlive the granter's authority** — the escalation guard
  blocks and audits (`auth.escalationBlocked`) any grant exceeding the
  granter's own effective permissions or lacking `admin:manage-users`.
- **Idempotent re-grant** — same (user, role, scope) while active returns the
  original fact; no duplicate authority, no duplicate event.
- **Revocation as fact** — role revocation and key revocation set fields on
  the record; history is never rewritten; replay of revoked credentials is a
  denial + audit event, not a silent success.

## Events (`auth.*`, envelope `{ name, version: 1, aggregateId, payload, occurredAt }`)
`auth.userCreated`, `auth.userSuspended`, `auth.roleGranted`,
`auth.roleRevoked`, `auth.escalationBlocked`, `auth.apiKeyIssued`,
`auth.apiKeyRevoked`, `auth.sessionExpired`, `auth.accessDenied`.
Aggregate conventions: user facts → user id; grant facts → grant id; key
facts → key id; session expiry → session id; `escalationBlocked` → org id
(the refused grant must never exist); `accessDenied` → org id (the denial may
concern an unknown principal). Payloads are narrow/serializable (ids +
ISO-8601); secrets and hashes never travel in payloads.

## Rules
- Import ONLY from `../shared` + this lane. Cross-lane ids (org, resource,
  case, receivable…) are opaque `Uuid`s — never imported types.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time via the
  injected `Clock`; secrets via the injected `SecretCodec` port.
- Stable `DomainError` codes with lane prefixes: `AUTH_*` (users, roles,
  grants, permissions, guard), `KEY_*` (api-key lifecycle + authentication
  denials), `SESS_*` (session lifecycle). The two deliberate non-throwing
  refusals are decision VALUES with their own exported codes:
  `AUTH_ESCALATION_BLOCKED` (grantRole) and `AUTH_ACCESS_DENIED`
  (authorize/authenticateKey) — each paired with its audit event.

## Definition of done
- Permission allow/deny grid, deny-by-default matrix, escalation guard,
  key lifecycle (issue→authenticate→revoke→replay), session expiry boundaries
  (±1ms, idle + absolute + touch), suspension cascade (sessions + keys),
  idempotent re-grant, revocation-as-fact — all table-driven tested.
- `npm run typecheck && npm test` green.

## Deliberate non-events (catalog gaps, dispatcher owns docs/04)
- `reactivateUser`/`deactivateUser` and `openSession`/`endSession`/
  `revokeSession` emit no event — the issue's catalog lists none for them;
  the status change is the fact on the aggregate (same precedent as the
  collections lane's open→in_progress).
- Password set/rotate emits no event — a hash is not a business fact; the
  access log is the audit story for credential checks.

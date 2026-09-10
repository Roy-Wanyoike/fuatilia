# Portal i18n (issues #149 + #180)

Type-safe en/sw dictionaries for the whole app — the payer portal
(`src/app/(portal)/**`, issue #149) plus the collector dashboard and the
auth surfaces (`src/app/(dashboard)/**`, `(auth)/**`, issue #180).

## One shared dictionary (the #180 decision, and why)

#180 chose to EXTEND this single catalog in place rather than split per
route group:

1. **One app, one language preference.** The locale cookie, provider and
   toggle are app-wide already; a split would force either duplicated
   runtime plumbing or cross-imports between lane libraries.
2. **One safety loop.** `Dictionary`, `LocaleKey`, `satisfies Dictionary`
   and the parity test are catalog-agnostic — a single catalog with
   per-surface sections keeps exactly one derive-and-refuse mechanism for
   every surface; the key union grows, each call site still accepts only
   derived keys.
3. **Sections, not silos.** `en.ts` groups by SURFACE (the #149 portal
   sections first, then `dashboard` + `auth`), so copy never mixes while
   shared sections (`common`, `language`) stay shared — e.g. the (auth)
   refusal envelope reuses `common.codeLabel`/`common.requestIdLabel`.

The folder keeps its landed name (`lib/portal-i18n`, the #149 brand);
`MissingPortalStringError` keeps its name for the same reason — tests pin
both.

## The pattern (tsc-level missing-key safety)

1. **`en.ts` is the source of truth** — a single `as const` object holding
   every payer-facing string, grouped by view (`gate`, `shell`, `balance`,
   `invoices`, `statement`) plus shared `common`/`states`/`language` sections.
   Placeholders are `{name}` tokens (`'page {page} of ≤ {pages}'`).
2. **`dictionary.ts` derives everything from `en`:**
   - `Dictionary` — the en shape with every leaf widened to `string`;
   - `LocaleKey` — the union of all dot-paths to leaf strings
     (`'balance.cards.overdue.title' | …`), computed by the recursive
     `DictionaryKey<T>` mapped type. **Key derivation from usage:** there is
     no hand-maintained key list anywhere.
3. **`sw.ts` is `satisfies Dictionary`** — a key missing in sw, an extra key
   only in sw, or a non-string value is a **compile error inside `sw.ts`**
   itself. The Kiswahili catalog cannot silently drift from the English one.
4. **`t.ts` types the key parameter as `LocaleKey`** — so at any call site:

   ```ts
   const t = usePortalT();
   t('balance.cards.overdue.title'); // ✅ compiles
   t('balence.cards.overdue.title'); // ❌ tsc error — typo'd key
   t('gate.retired');                // ❌ tsc error — removed key
   ```

   The test file pins this contract with `// @ts-expect-error` assertions:
   if key derivation ever stops rejecting unknown keys, `npm run typecheck`
   fails on the test file itself — the pattern is load-bearing, not prose.
5. **Runtime refusal (defense in depth)** — `translate()` throws
   `MissingPortalStringError` for an unresolved key or an unfilled `{var}`
   instead of rendering `undefined`/`[object Object]`/a raw key. A portal
   must never show a fabricated blank; a loud error is the honest failure.
6. **Runtime parity test** — `portal-i18n.test.ts` flattens both catalogs and
   asserts en ≡ sw key sets, non-empty sw leaves, and identical `{var}`
   tokens (a translation that drops a placeholder would break its view).

## Language switching & persistence

- `cookie.ts` — the `fuatilia_portal_locale` cookie (`en | sw`). It is a UI
  preference, **not a credential**: client-writable, `SameSite=Lax`,
  `Path=/`, one year. Absent or garbage values always resolve to `en`.
- `(portal)/layout.tsx` reads the cookie server-side (`server.ts`, which owns
  the `next/headers` import and stays out of client bundles) and mounts
  `PortalI18nProvider initialLocale={locale}` — server and client agree on
  first paint, so there is no hydration mismatch.
- `language-toggle.tsx` (rendered in the shell and the gate) persists the
  choice to the cookie, flips the client context (every mounted view
  re-renders immediately), and calls `router.refresh()` so server components
  (e.g. translated `<title>` metadata via `generateMetadata`) follow.
- Without a provider, `usePortalT()` falls back to en — en is the default,
  and a missing provider can never crash the portal, only speak English.

## Adoption rules for (portal) views

- No raw literals in `(portal)` components: every payer-facing string comes
  from `usePortalT()` with a derived key (or `translate(...)` in server
  components).
- State/kind label unions are bound to the catalog with explicit
  `Record<EnumUnion, LocaleKey>` maps, so adding a wire enum value without a
  translation is a compile error at the map.
- Shared UI primitives (`components/ui/*`, e.g. the generic `Retry` button)
  are outside this lane and intentionally untouched.

## Adoption rules for (dashboard) + (auth) views (issue #180)

- Same pattern, same refusal: client components use `usePortalT()`; server
  components that render copy read the locale via `readPortalLocale()` and
  call `translate(PORTAL_DICTIONARIES[locale], key)`. The (dashboard) and
  (auth) layouts mount `PortalI18nProvider` from the same cookie, so one
  preference switches every surface at once.
- **en stays byte-identical to the pre-adoption copy.** The components'
  existing tests pin rendered strings; the catalog carried them over
  verbatim, and `portal-i18n.test.ts` now pins the highest-risk ones at the
  catalog level too (`adoption byte-identity` suite).
- **Wire enum badges stay wire values.** Machine-facing diagnostic badges
  (payment state/channel, receivable state, case priority/derivedStatus,
  action source, aging buckets, sort enums) render the raw contract values —
  an operator correlates them with logs and the /v1 spec. The unions that
  already had human label maps (case status via `TRANSITION_LABELS`, action
  types via `ACTION_TYPE_LABELS`) ARE adopted as
  `dashboard.collections.statusLabels` / `.actionTypeLabels`, bound in the
  views with `Record<EnumUnion, LocaleKey>` maps.
- Literal braces in copy (e.g. a `{actionId}` path in prose) conflict with
  the `{var}` placeholder grammar; such strings use the `:param` path style
  instead (`POST …/actions/:actionId/completions`).

## Adding a string (the workflow)

1. Add it to `en.ts` under the view's section.
2. `sw.ts` now fails to compile until you translate it — do so.
3. Use the new derived key in the view; typos cannot compile.
4. The parity test re-checks both catalogs at runtime.

## Files

| File | Role |
| --- | --- |
| `en.ts` | English catalog (`as const`, source of truth) |
| `sw.ts` | Kiswahili catalog (`satisfies Dictionary`) |
| `dictionary.ts` | `Dictionary`, `DictionaryKey`, `LocaleKey`, runtime flatten |
| `t.ts` | `translate()` + `MissingPortalStringError` (loud refusal) |
| `cookie.ts` | locale cookie constants, parsing, persistence (isomorphic) |
| `server.ts` | `readPortalLocale()` for server components (`next/headers`) |
| `context.tsx` | `PortalI18nProvider`, `usePortalT`, `usePortalI18n` |
| `language-toggle.tsx` | English ⇄ Kiswahili toggle (cookie + refresh) |
| `portal-i18n.test.ts` | parity, refusal (tsc + runtime), interpolation, cookie, #180 byte-identity |
| `sw-render.test.tsx` | the portal actually rendering in Kiswahili |
| `sw-render-auth.test.tsx` | the sign-in gate actually rendering in Kiswahili (#180) |
| `sw-render-dashboard.test.tsx` | dashboard views actually rendering in Kiswahili (#180) |
| `language-toggle.test.tsx` | toggle persistence + instant re-render |

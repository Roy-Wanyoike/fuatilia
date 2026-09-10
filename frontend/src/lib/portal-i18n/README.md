# Portal i18n (issue #149)

Type-safe en/sw dictionaries for the payer portal (`src/app/(portal)/**` only —
dashboard and auth lanes are untouched and keep their current copy).

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
| `portal-i18n.test.ts` | parity, refusal (tsc + runtime), interpolation, cookie |
| `sw-render.test.tsx` | the portal actually rendering in Kiswahili |
| `language-toggle.test.tsx` | toggle persistence + instant re-render |

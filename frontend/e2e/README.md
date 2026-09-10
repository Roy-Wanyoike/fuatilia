# Playwright smoke harness (issue #136)

Two end-to-end smoke journeys against the locally-started Next dev server:

| Journey  | Spec                    | Path                                                              |
| -------- | ----------------------- | ----------------------------------------------------------------- |
| portal   | `portal.spec.ts`        | paste access code → cookie → balance / invoices / statement views |
| collector| `collector.spec.ts`     | sign-in → dashboard overview renders                              |

The upstream /v1 API is **stubbed at the network layer** (`page.route` in
`stubs.ts`) — the only place mocks exist. The Next server is real: middleware
gate, route-group layouts, session/BFF routes and components all execute.
Payloads are annotated with the production wire types (type-only imports), so
contract drift in the stubs fails `tsc --noEmit`.

## Run

```sh
cd frontend
npm install                        # once
npx playwright install chromium    # once (browser download)
npx playwright test                # starts the dev server on :3100 itself
```

The `webServer` block in `playwright.config.ts` boots `next dev --port 3100`
with a fail-closed `API_BASE_URL`; nothing ever dials it because every /v1
read the journeys make is intercepted in the browser. Traces/screenshots for
failures land in `e2e/.artifacts/` (git-ignored).

## Lane notes

- This lane owns only `frontend/e2e/**`, `playwright.config.ts` and the
  `@playwright/test` devDependency — (dashboard)/(portal)/(auth) component
  files are read-only here.
- The e2e specs use the `*.spec.ts` suffix; vitest includes only
  `src/**/*.test.{ts,tsx}`, so the two runners cannot collide.

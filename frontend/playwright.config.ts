import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke harness (issue #136) — frontend/e2e lane.
 *
 * Two journeys run against the locally-started Next dev server:
 *   1. portal    — paste access code → session cookie → balance / invoices /
 *                  statement views render;
 *   2. collector — sign-in → dashboard renders.
 *
 * The backend API is STUBBED AT THE NETWORK LAYER with `page.route` (see
 * e2e/stubs.ts): every same-origin BFF/session request the browser makes is
 * fulfilled with contract-shaped envelopes, so no backend process is needed
 * and no mock exists outside test code. The Next server itself is real —
 * server components, middleware gate and route-group layouts all execute.
 *
 * Run (from frontend/):
 *   npx playwright install chromium   # once
 *   npx playwright test               # starts the dev server on :3100 itself
 */

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Dev-server on-demand compilation makes the first navigation slow; the
  // budget stays generous so a cold run never flakes on compile time.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: './e2e/.artifacts/test-results',
  use: {
    baseURL: BASE_URL,
    // Desktop viewport (≥ md) so the invoice list renders its table variant.
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // dev-server.cjs provisions a TS5 compiler for Next's dev-server
    // TypeScript verification (the repo's typescript@7 — typescript-go —
    // does not ship the classic lib/typescript.js API Next 15.5 requires;
    // see e2e/dev-server.cjs) and then boots `next dev` below.
    command: 'node e2e/dev-server.cjs',
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Upstream origin for the server-side BFF/session routes. Every /v1
      // read in these journeys is intercepted at the browser (page.route),
      // so nothing ever dials this address — it only keeps the dev server's
      // fail-closed configuration honest.
      API_BASE_URL: 'http://127.0.0.1:4599',
    },
  },
});

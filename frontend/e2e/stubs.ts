import type { Page, Route } from '@playwright/test';
import { SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import type { PaymentView, ReceivableView } from '../src/lib/api/wire-types';
import { PORTAL_SESSION_COOKIE_NAME } from '../src/lib/portal/session';

/**
 * Network-layer stubs for the Playwright smoke journeys (issue #136).
 *
 * This file is TEST CODE and is the only place mocks exist: every request
 * the browser makes to a same-origin session/BFF route is intercepted with
 * `page.route` and fulfilled with a contract-shaped envelope. The Next dev
 * server itself is real (server components, middleware gate, route-group
 * layouts all execute); only the upstream /v1 API is simulated, at the
 * exact seam the browser can observe.
 *
 * Payload shapes are annotated with the production wire types (type-only
 * imports — erased at runtime) so a drift from components.schemas fails
 * `tsc --noEmit` at authoring time, not mid-journey.
 */

/** Opaque session UUID (the bearerSession credential both journeys paste). */
export const SESSION_TOKEN = 'e2e1a7c5-9b3d-4e8f-a1c2-3d4e5f6a7b8c';
/** x-request-id echoed into every stubbed envelope. */
export const REQUEST_ID = 'e2e00000-0000-4000-8000-00000000e2ee';

// ---------------------------------------------------------------------------
// /v1 read-model rows (contract-shaped; the values the UI asserts on)
// ---------------------------------------------------------------------------

const receivableOpen: ReceivableView = {
  id: 'e2e-receivable-0002',
  invoiceId: 'INV-E2E-0002',
  customerId: 'e2e-customer-0001',
  currency: 'KES',
  original: { minor: 2_000_000, currency: 'KES' },
  applied: { minor: 0, currency: 'KES' },
  balance: { minor: 2_000_000, currency: 'KES' },
  state: 'open',
  overdue: false,
  openedAt: '2026-09-01T09:00:00.000Z',
  dueDate: '2026-09-30T00:00:00.000Z',
  settledAt: null,
  voidedAt: null,
  writeOff: null,
  uncollectibleReason: null,
  uncollectibleAt: null,
  recoveredAt: null,
  aging: { daysPastDue: 0, bucket: '0-30' },
};

const receivablePartiallyPaidOverdue: ReceivableView = {
  id: 'e2e-receivable-0001',
  invoiceId: 'INV-E2E-0001',
  customerId: 'e2e-customer-0001',
  currency: 'KES',
  original: { minor: 12_500_000, currency: 'KES' },
  applied: { minor: 5_000_000, currency: 'KES' },
  balance: { minor: 7_500_000, currency: 'KES' },
  state: 'partially_paid',
  overdue: true,
  openedAt: '2026-08-01T09:00:00.000Z',
  dueDate: '2026-08-15T00:00:00.000Z',
  settledAt: null,
  voidedAt: null,
  writeOff: null,
  uncollectibleReason: null,
  uncollectibleAt: null,
  recoveredAt: null,
  aging: { daysPastDue: 20, bucket: '0-30' },
};

const paymentAllocated: PaymentView = {
  id: 'e2e-payment-0001',
  channel: 'c2b',
  externalRef: 'SBX-E2E-QQ7ZKL',
  idempotencyKey: 'e2e-idem-0001',
  customerId: 'e2e-customer-0001',
  state: 'partially_allocated',
  currency: 'KES',
  requested: { minor: 5_000_000, currency: 'KES' },
  confirmed: { minor: 5_000_000, currency: 'KES' },
  unapplied: { minor: 1_250_000, currency: 'KES' },
  declaredRefs: ['INV-E2E-0001'],
  allocations: [
    {
      id: 'e2e-alloc-0001',
      receivableId: 'e2e-receivable-0001',
      amount: { minor: 3_750_000, currency: 'KES' },
      recordedAt: '2026-09-02T10:05:00.000Z',
    },
  ],
  refunds: [],
  initiatedAt: '2026-09-02T10:00:00.000Z',
  confirmedAt: '2026-09-02T10:01:30.000Z',
  failedAt: null,
  failureCode: null,
  reversedAt: null,
  reversalReason: null,
};

const paymentFailed: PaymentView = {
  id: 'e2e-payment-0002',
  channel: 'stk',
  externalRef: 'SBX-E2E-TT41QP',
  idempotencyKey: 'e2e-idem-0002',
  customerId: null,
  state: 'failed',
  currency: 'KES',
  requested: { minor: 3_000_000, currency: 'KES' },
  confirmed: null,
  unapplied: { minor: 0, currency: 'KES' },
  declaredRefs: [],
  allocations: [],
  refunds: [],
  initiatedAt: '2026-09-03T08:00:00.000Z',
  confirmedAt: null,
  failedAt: '2026-09-03T08:02:00.000Z',
  failureCode: 'UPSTREAM_BUSY',
  reversedAt: null,
  reversalReason: null,
};

/** GET /v1/receivables 200 envelope (success `{ data, meta }` discipline). */
const RECEIVABLES_LIST = {
  data: { receivables: [receivablePartiallyPaidOverdue, receivableOpen] },
  meta: { pagination: { nextCursor: null, total: 2 } },
} as const;

/** GET /v1/payments 200 envelope. */
const PAYMENTS_LIST = {
  data: { payments: [paymentFailed, paymentAllocated] },
  meta: { pagination: { nextCursor: null, total: 2 } },
} as const;

/** GET /v1/meta 200 envelope — every dashboard capability mounted. */
const META = {
  data: {
    name: 'Fuatilia',
    apiVersion: 'v1',
    capabilities: ['auth', 'collections', 'payments', 'receivables'],
  },
} as const;

/** GET /v1/health 200 envelope. */
const HEALTH = { data: { status: 'ok' } } as const;

// ---------------------------------------------------------------------------
// route helpers
// ---------------------------------------------------------------------------

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  await route.fulfill({
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': REQUEST_ID,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** The Set-Cookie the real session routes issue (the lib session contracts). */
function sessionCookie(name: string): string {
  return `${name}=${SESSION_TOKEN}; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict`;
}

function clearedCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

function refusalEnvelope(code: string, message: string): unknown {
  return { error: { code, message }, requestId: REQUEST_ID };
}

async function fulfillUnhandled(route: Route, lane: string): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  await fulfillJson(
    route,
    404,
    refusalEnvelope(
      'HTTP_ROUTE_NOT_FOUND',
      `e2e stub: unhandled ${lane} path ${pathname} — extend e2e/stubs.ts`,
    ),
  );
}

// ---------------------------------------------------------------------------
// journey 1 — portal (access code → cookie → balance / invoices / statement)
// ---------------------------------------------------------------------------

export interface SessionStubOptions {
  /** false ⇒ the session endpoint answers the API's 401 refusal envelope. */
  accessAccepted?: boolean;
}

export async function installPortalStubs(
  page: Page,
  options: SessionStubOptions = {},
): Promise<void> {
  const accessAccepted = options.accessAccepted ?? true;

  // The gate POSTs { code } to /api/portal/session; on success the route sets
  // the httpOnly SameSite=Strict portal cookie exactly like the real handler.
  await page.route('**/api/portal/session', (route) => {
    const method = route.request().method();
    if (method === 'DELETE') {
      void fulfillJson(route, 200, { data: { signedOut: true } }, {
        'set-cookie': clearedCookie(PORTAL_SESSION_COOKIE_NAME),
      });
      return;
    }
    if (!accessAccepted) {
      void fulfillJson(route, 401, refusalEnvelope(
        'HTTP_UNAUTHENTICATED',
        'the portal access code was not accepted — request a new code from the biller',
      ));
      return;
    }
    void fulfillJson(route, 200, { data: { accepted: true } }, {
      'set-cookie': sessionCookie(PORTAL_SESSION_COOKIE_NAME),
    });
  });

  // The dedicated portal BFF relay: /api/portal/v1/* (the browser client's
  // baseUrl) — contract envelopes only.
  await page.route('**/api/portal/v1/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/portal/v1/v1/receivables') {
      void fulfillJson(route, 200, RECEIVABLES_LIST);
      return;
    }
    if (pathname === '/api/portal/v1/v1/payments') {
      void fulfillJson(route, 200, PAYMENTS_LIST);
      return;
    }
    void fulfillUnhandled(route, 'portal BFF');
  });
}

// ---------------------------------------------------------------------------
// journey 2 — collector (sign-in → dashboard)
// ---------------------------------------------------------------------------

export async function installCollectorStubs(
  page: Page,
  options: SessionStubOptions = {},
): Promise<void> {
  const accessAccepted = options.accessAccepted ?? true;

  await page.route('**/api/auth/session', (route) => {
    const method = route.request().method();
    if (method === 'DELETE') {
      void fulfillJson(route, 200, { data: { signedOut: true } }, {
        'set-cookie': clearedCookie(SESSION_COOKIE_NAME),
      });
      return;
    }
    if (!accessAccepted) {
      void fulfillJson(route, 401, refusalEnvelope(
        'HTTP_UNAUTHENTICATED',
        'the session credential was not accepted — request a fresh session from your Fuatilia administrator',
      ));
      return;
    }
    void fulfillJson(route, 200, { data: { accepted: true } }, {
      'set-cookie': sessionCookie(SESSION_COOKIE_NAME),
    });
  });

  // The dashboard BFF relay (/api/v1/* → upstream /v1/*).
  await page.route('**/api/v1/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/v1/health') {
      void fulfillJson(route, 200, HEALTH);
      return;
    }
    if (pathname === '/api/v1/v1/meta') {
      void fulfillJson(route, 200, META);
      return;
    }
    if (pathname === '/api/v1/v1/receivables') {
      void fulfillJson(route, 200, RECEIVABLES_LIST);
      return;
    }
    if (pathname === '/api/v1/v1/payments') {
      void fulfillJson(route, 200, PAYMENTS_LIST);
      return;
    }
    void fulfillUnhandled(route, 'dashboard BFF');
  });
}

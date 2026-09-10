import { expect, type Page, test } from '@playwright/test';
import { PORTAL_SESSION_COOKIE_NAME } from '../src/lib/portal/session';
import { installPortalStubs, REQUEST_ID, SESSION_TOKEN } from './stubs';

/**
 * Journey 1 (issue #136): the payer portal.
 *
 * Paste access code → the session route sets the httpOnly
 * SameSite=Strict `fuatilia_portal_session` cookie → the server layout's
 * gate yields to the portal shell → balance / invoices / statement views
 * render over the (network-stubbed) /v1 read models.
 *
 * The upstream API is stubbed ONLY at the network layer (page.route in
 * e2e/stubs.ts); the Next server, middleware, layouts and components are
 * the real production tree.
 */

async function expectPortalCookieSet(page: Page): Promise<void> {
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === PORTAL_SESSION_COOKIE_NAME,
  );
  expect(cookie, 'the portal session cookie must be set after the code is accepted').toBeDefined();
  expect(cookie?.value).toBe(SESSION_TOKEN);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
}

test('gate refuses an access code the API does not accept (no cookie, no data)', async ({
  page,
}) => {
  await installPortalStubs(page, { accessAccepted: false });

  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Fuatilia payer portal' })).toBeVisible();

  await page.getByLabel('Portal access code').fill('not-the-real-code');
  await page.getByRole('button', { name: 'Open my account' }).click();

  const refused = page.getByTestId('access-refused');
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('This access code was not accepted');
  await expect(refused).toContainText('HTTP_UNAUTHENTICATED');
  await expect(refused).toContainText(`requestId: ${REQUEST_ID}`);

  const cookies = await page.context().cookies();
  expect(
    cookies.find((candidate) => candidate.name === PORTAL_SESSION_COOKIE_NAME),
    'a refused code must never set the session cookie',
  ).toBeUndefined();
});

test('pasting a valid access code unlocks balance, invoices and statement views', async ({
  page,
}) => {
  await installPortalStubs(page);

  // --- the gate: paste the access code once --------------------------------
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Fuatilia payer portal' })).toBeVisible();

  await page.getByLabel('Portal access code').fill(SESSION_TOKEN);
  await page.getByRole('button', { name: 'Open my account' }).click();

  // The (stubbed at the network layer) session route set the httpOnly cookie.
  await expectPortalCookieSet(page);

  // --- balance view ---------------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Your balance' })).toBeVisible();

  const outstanding = page.getByRole('region', { name: 'Outstanding', exact: true });
  await expect(outstanding).toContainText('left to pay across open invoices');
  await expect(outstanding).toContainText('KES 95,000.00');

  const overdue = page.getByRole('region', { name: 'Overdue', exact: true });
  await expect(overdue).toContainText('past the due date');
  await expect(overdue).toContainText('KES 75,000.00');

  const held = page.getByRole('region', { name: 'Held on account', exact: true });
  await expect(held).toContainText('paid but not yet applied to an invoice');
  await expect(held).toContainText('KES 12,500.00');

  // --- invoices view --------------------------------------------------------
  await page.goto('/portal/invoices');
  await expect(page.getByRole('heading', { name: 'Your invoices' })).toBeVisible();

  const invoiceTable = page.getByTestId('invoice-table');
  await expect(invoiceTable).toBeVisible();
  await expect(invoiceTable).toContainText('INV-E2E-0001');
  await expect(invoiceTable).toContainText('partially paid');
  await expect(invoiceTable).toContainText('KES 75,000.00');
  await expect(invoiceTable).toContainText('INV-E2E-0002');
  await expect(invoiceTable).toContainText('open');
  await expect(invoiceTable).toContainText('KES 20,000.00');
  await expect(page.getByRole('region', { name: 'Invoices', exact: true })).toContainText(
    '2 total',
  );

  // --- statement view -------------------------------------------------------
  await page.goto('/portal/statement');
  await expect(page.getByRole('heading', { name: 'Your statement' })).toBeVisible();

  const timeline = page.getByTestId('statement-timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('payment confirmed');
  await expect(timeline).toContainText('applied to invoice');
  await expect(timeline).toContainText('payment failed');
  await expect(timeline).toContainText('SBX-E2E-QQ7ZKL');
  await expect(timeline).toContainText('SBX-E2E-TT41QP');
});

import { expect, type Page, test } from '@playwright/test';
import { SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { installCollectorStubs, SESSION_TOKEN } from './stubs';

/**
 * Journey 2 (issue #136): the collector console.
 *
 * A dashboard route without the session cookie is redirected to /sign-in
 * by the middleware gate; pasting the administrator-issued session
 * credential sets the httpOnly SameSite=Strict `fuatilia_session` cookie
 * and lands the collector on the overview, which renders its headline
 * positions over the (network-stubbed) /v1 read models.
 *
 * The upstream API is stubbed ONLY at the network layer (page.route in
 * e2e/stubs.ts); the Next server, middleware gate, layouts and components
 * are the real production tree.
 */

async function expectSessionCookieSet(page: Page): Promise<void> {
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === SESSION_COOKIE_NAME,
  );
  expect(cookie, 'the session cookie must be set after sign-in succeeds').toBeDefined();
  expect(cookie?.value).toBe(SESSION_TOKEN);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
}

test('a dashboard route without a session cookie is redirected to sign-in', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('heading', { name: 'Sign in to Fuatilia' })).toBeVisible();
  await expect(page.getByLabel('Session credential')).toBeVisible();
});

test('sign-in refuses a credential the API does not accept (no cookie)', async ({ page }) => {
  await installCollectorStubs(page, { accessAccepted: false });

  await page.goto('/sign-in');
  await page.getByLabel('Session credential').fill(SESSION_TOKEN);
  await page.getByRole('button', { name: 'Open the console' }).click();

  const refused = page.getByTestId('access-refused');
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('This session credential was not accepted');
  await expect(refused).toContainText('HTTP_UNAUTHENTICATED');

  const cookies = await page.context().cookies();
  expect(
    cookies.find((candidate) => candidate.name === SESSION_COOKIE_NAME),
    'a refused credential must never set the session cookie',
  ).toBeUndefined();
});

test('signing in with the session credential opens the dashboard overview', async ({ page }) => {
  await installCollectorStubs(page);

  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to Fuatilia' })).toBeVisible();

  await page.getByLabel('Session credential').fill(SESSION_TOKEN);
  await page.getByRole('button', { name: 'Open the console' }).click();

  // The (stubbed at the network layer) session route set the httpOnly cookie
  // and the collector landed on the overview the middleware gate now allows.
  await expectSessionCookieSet(page);
  await expect(page).toHaveURL(/\/$/);

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Outstanding receivables' })).toContainText(
    'KES 95,000.00 open + partially paid balance',
  );
  await expect(page.getByRole('region', { name: 'Overdue', exact: true })).toContainText(
    'KES 75,000.00 past-due balance',
  );
  await expect(page.getByRole('region', { name: 'Unmatched cash', exact: true })).toContainText(
    'KES 12,500.00 confirmed but unapplied',
  );

  // The shell's capability awareness answers from GET /v1/meta + /v1/health.
  // The sr-only "API health:" prefix and the state label share ONE badge, so
  // the composed text is what the page exposes — and an 'unreachable' state
  // never satisfies this (its composed text is "API health: unreachable").
  await expect(page.getByText('API health: reachable')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

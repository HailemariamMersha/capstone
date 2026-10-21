import { test, expect, type Page } from '@playwright/test';
async function signedIn(page: Page, role: string) {
  await page.addInitScript(() =>
    localStorage.setItem(
      'sb-skymeasure-test-auth-token',
      JSON.stringify({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: {
          id: 'account-a',
          aud: 'authenticated',
          email: 'test@example.invalid',
        },
      }),
    ),
  );
  await page.route('**/api/v2/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const summary = {
      id: 'a'.repeat(32),
      participantId: 'b'.repeat(32),
      collectedAt: '2026-10-12T12:00:00Z',
      receivedAt: '2026-10-12T12:12:00Z',
      completedAt: '2026-10-12T12:13:00Z',
      collectorVersion: 'libraries-test',
      measurements: 1,
      failures: 0,
      receivedRecords: 2,
      expectedRecords: 2,
      uploadStatus: 'Uploaded',
    };
    if (path.endsWith('/profile'))
      return route.fulfill({ json: { role, participantId: 'b'.repeat(32) } });
    if (role === 'participant')
      return route.fulfill({
        status: 403,
        json: { detail: 'Researcher access required' },
      });
    if (path.endsWith('/overview'))
      return route.fulfill({
        json: {
          participants: 1,
          sessions: 1,
          measurements: 1,
          partialSessions: 0,
          failures: 0,
        },
      });
    if (url.searchParams.get('format') === 'csv')
      return route.fulfill({
        contentType: 'text/csv',
        body: 'measurement.id,sample.rttMs\r\na,0\r\n',
      });
    if (path.endsWith('/sessions'))
      return route.fulfill({ json: { items: [summary], total: 1 } });
    if (path.includes('/sessions/'))
      return route.fulfill({
        json: {
          session: {
            id: summary.id,
            startedAt: summary.collectedAt,
            config: { httpEnabled: false },
          },
          receipt: summary,
          measurements: [
            {
              id: 'm',
              type: 'udp_echo',
              success: true,
              value: 0,
              unit: 'ms',
              timestamp: summary.collectedAt,
              details: {
                samples: [
                  { sequence: 0, rttMs: 0 },
                  { sequence: 1, rttMs: null },
                ],
              },
            },
          ],
          events: [],
          snapshots: [],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
}
test('public registration does not unlock researcher routes', async ({
  page,
}) => {
  await signedIn(page, 'participant');
  await page.goto('/');
  await expect(
    page.getByText('Researcher access is required.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});
test('researcher sees received data, probes, missing values and downloads', async ({
  page,
}) => {
  await signedIn(page, 'researcher');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'A clearer view of connectivity.' }),
  ).toBeVisible();
  await expect(
    page.getByText('This workspace cannot see active phones', { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/overview.png', fullPage: true });
  await page.locator('tbody button').first().click();
  await expect(
    page.getByRole('heading', { name: 'Session evidence' }),
  ).toBeVisible();
  await expect(
    page.getByText('Unavailable', { exact: true }).first(),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Combined measurement / sample CSV' })
    .click();
  expect((await download).suggestedFilename()).toContain('combined.csv');
  await page.screenshot({
    path: 'test-results/session-detail.png',
    fullPage: true,
  });
});
test('signed-out and narrow layouts show a clear sign-in flow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Continue with Google' }),
  ).toBeVisible();
  await expect(
    page.getByText('Signing up does not grant access', { exact: false }),
  ).toBeVisible();
});

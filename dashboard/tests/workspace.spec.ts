import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  csvText,
  filterMeasurements,
  sampleRows,
  type Evidence,
} from '../lib/evidence';
async function signedIn(page: Page, role: string, measurements?: Evidence[]) {
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
          measurements: measurements ?? [
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
    page.getByRole('cell', { name: 'Unavailable', exact: true }).first(),
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

const mixedEvidence: Evidence[] = [
  {
    id: 'udp-parent',
    type: 'udp_echo',
    success: true,
    value: 12,
    unit: 'ms',
    targetHost: 'echo.example.invalid',
    timestamp: '2026-10-12T12:00:00Z',
    scheduledAt: '2026-10-12T12:00:00Z',
    details: {
      samples: Array.from({ length: 62 }, (_, i) => ({
        sequence: i,
        rttMs: i === 61 ? null : i,
        errorType: i === 61 ? 'timeout' : null,
      })),
    },
  },
  {
    id: 'icmp-parent',
    type: 'icmp_burst',
    success: true,
    value: 0,
    unit: 'ms',
    timestamp: '2026-10-12T12:01:00Z',
    targetHost: 'google.example.invalid',
    details: {
      samples: [
        {
          sequence: 0,
          rttMs: 0,
          ttl: 64,
          packet: {
            response: { icmpType: 0, icmpCode: 0, receivedSocketBytes: 72 },
          },
        },
      ],
    },
  },
  {
    id: 'http-parent',
    type: 'download',
    success: true,
    value: 12,
    unit: 'Mbps',
    timestamp: '2026-10-12T12:02:00Z',
    probeServer: '=untrusted-target',
    transferredBytes: 1048576,
  },
  {
    id: 'loaded-parent',
    type: 'loaded_download',
    success: true,
    value: 20,
    unit: 'ms',
    timestamp: '2026-10-12T12:03:00Z',
    details: {
      samples: [{ sequence: 0, rttMs: 20 }],
      baselineSamples: [
        { sequence: 0, rttMs: 0 },
        { sequence: 1, rttMs: null, errorType: 'timeout' },
      ],
    },
  },
  {
    id: 'tcp-parent',
    type: 'tcp_connect',
    success: false,
    value: null,
    unit: 'ms',
    timestamp: '2026-10-12T12:04:00Z',
    details: { samples: [{ sequence: 0, rttMs: null, errorType: 'network' }] },
  },
  {
    id: 'trace-parent',
    type: 'traceroute',
    success: true,
    value: 2,
    unit: 'hops',
    timestamp: '2026-10-12T12:05:00Z',
    route: {
      samples: [
        {
          hop: 1,
          sequence: 0,
          rttMs: 10,
          kind: 'host_unreachable',
          address: '192.0.2.1',
        },
        {
          hop: 2,
          sequence: 1,
          rttMs: 15,
          kind: 'port_unreachable',
          address: '192.0.2.2',
        },
      ],
    },
  },
];
async function openEvidence(page: Page) {
  await signedIn(page, 'researcher', mixedEvidence);
  await page.goto('/');
  await page.locator('tbody button').first().click();
  await expect(
    page.getByRole('heading', { name: 'Explore measurements' }),
  ).toBeVisible();
}
test('measurement filters retain failed samples inside successful bursts and reset pagination', async ({
  page,
}) => {
  await openEvidence(page);
  const samples = page.getByRole('region', {
    name: 'Individual samples',
    exact: true,
  });
  const measurements = page.getByRole('region', {
    name: 'Measurement results',
    exact: true,
  });
  await page
    .getByLabel('Measurement type', { exact: true })
    .selectOption('udp_echo');
  await samples.getByRole('button', { name: 'Next observations' }).click();
  await expect(samples.getByText('Page 2 of 2')).toBeVisible();
  await page.getByLabel('Whole-measurement outcome').selectOption('success');
  await page
    .getByLabel('Sample outcome', { exact: true })
    .selectOption('timeout');
  await expect(samples.locator('tbody tr')).toHaveCount(1);
  await expect(samples.locator('tbody')).toContainText('timeout');
  await expect(samples.locator('tbody')).toContainText('Unavailable');
  await expect(measurements.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByLabel('Sample outcome', { exact: true })).toHaveValue(
    'timeout',
  );
  await expect(samples.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(measurements.locator('tbody tr')).toHaveCount(6);
  await page.getByLabel('Search measurements').fill('NO-SUCH-TARGET');
  await expect(measurements.locator('tbody tr')).toHaveCount(0);
  await expect(
    samples.getByRole('button', { name: 'Download visible columns CSV' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page
    .getByLabel('Sample phase', { exact: true })
    .selectOption('baseline');
  await expect(samples.locator('tbody tr')).toHaveCount(2);
  await page
    .getByLabel('Sample outcome', { exact: true })
    .selectOption('response');
  await expect(samples.locator('tbody tr')).toHaveCount(1);
  await expect(samples.locator('tbody')).toContainText('0');
});
test('column selection, sorting and CSV apply to every filtered page', async ({
  page,
}) => {
  await openEvidence(page);
  const samples = page.getByRole('region', {
    name: 'Individual samples',
    exact: true,
  });
  await page
    .getByLabel('Measurement type', { exact: true })
    .selectOption('udp_echo');
  await samples.getByText('Choose columns', { exact: true }).click();
  await samples.getByLabel('Find a column').fill('TTL');
  await samples.getByRole('checkbox', { name: /^Reply TTL/ }).check();
  await samples.getByLabel('Find a column').fill('');
  await samples.getByRole('checkbox', { name: /^Sample phase/ }).uncheck();
  await expect(
    samples.getByRole('columnheader', { name: /Sample phase/ }),
  ).toHaveCount(0);
  await expect(
    samples.getByRole('columnheader', { name: /Reply TTL/ }),
  ).toBeVisible();
  await samples.getByRole('button', { name: /^Elapsed time/ }).click();
  const event = page.waitForEvent('download');
  await samples
    .getByRole('button', { name: 'Download visible columns CSV' })
    .click();
  const downloaded = await event;
  const content = await readFile((await downloaded.path())!, 'utf8');
  const lines = content.trimEnd().split('\r\n');
  expect(lines).toHaveLength(63); // All 62 samples, not only the visible 50.
  const header = lines[0].split(',');
  expect(header).toContain('replyTtl');
  expect(header).not.toContain('phase');
  expect(lines[1].split(',')[header.indexOf('rttMs')]).toBe('0');
  expect(lines.at(-1)!.split(',')[header.indexOf('rttMs')]).toBe('');
  await samples
    .getByRole('button', { name: 'Restore default columns' })
    .click();
  await expect(
    samples.getByRole('columnheader', { name: /Sample phase/ }),
  ).toBeVisible();
});
test('narrow screen supports filters and ICMP field selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEvidence(page);
  await page
    .getByLabel('Measurement type', { exact: true })
    .selectOption('icmp_burst');
  const samples = page.getByRole('region', {
    name: 'Individual samples',
    exact: true,
  });
  await samples.getByText('Choose columns', { exact: true }).click();
  await samples.getByLabel('Find a column').fill('ICMP');
  await samples.getByRole('checkbox', { name: /^ICMP code/ }).check();
  await expect(
    samples.getByRole('cell', { name: '0', exact: true }).first(),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: 'test-results/session-filters-mobile.png',
    fullPage: true,
  });
});
test('sample interpretation preserves zeros and qualifies traceroute responses', () => {
  const probes = sampleRows(mixedEvidence);
  expect(probes.find(s => s.parent === 'icmp-parent')?.icmpCode).toBe(0);
  expect(probes.find(s => s.parent === 'icmp-parent')?.address).toBeUndefined();
  expect(probes.find(s => s.kind === 'host_unreachable')?.outcome).toBe(
    'response',
  );
  expect(probes.find(s => s.errorType === 'timeout')?.outcome).toBe('timeout');
  expect(filterMeasurements(mixedEvidence, '', 'failure', '')).toHaveLength(1);
  expect(
    filterMeasurements(mixedEvidence, '', '', 'ECHO.EXAMPLE'),
  ).toHaveLength(1);
  expect(
    sampleRows([{ id: 'legacy', type: 'icmp_rtt', value: 0 }])[0].rttMs,
  ).toBe(0);
  expect(csvText(['zero', 'missing', 'untrusted'], [[0, null, '=1+1']])).toBe(
    "zero,missing,untrusted\r\n0,,'=1+1\r\n",
  );
});

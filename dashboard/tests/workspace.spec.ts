import { test, expect, type Page } from '@playwright/test';
import { sampleRows, csvText } from '../lib/evidence';
import {
  measurementFields,
  probeFields,
  scheduleFields,
  variableDefinition,
} from '../lib/variable-reference';
const id = 'a'.repeat(32),
  sid = 'b'.repeat(32),
  start = 1793534400000;
function trip(overrides: Record<string, unknown> = {}) {
  return {
    id,
    participantId: 'c'.repeat(32),
    flight: { flightNumber: 'TEST123', departure: 'DOH', arrival: 'JFK' },
    startedAt: start,
    endedAt: start + 3600000,
    state: 'completed',
    phase: 'finished',
    provider: 'TEST Etisalat',
    reason: 'participant_stop',
    groundTest: true,
    receivedAt: '2026-11-01T13:01:00Z',
    segmentCount: 4,
    receivedSegments: 4,
    completeSegments: 4,
    missingSegments: 0,
    receivedRecords: 435,
    expectedRegisteredRecords: 435,
    measurements: 41,
    failures: 1,
    uploadComplete: true,
    ...overrides,
  };
}
const protocol = {
  type: 'icmp_burst',
  attempts: 2,
  successful: 2,
  failed: 0,
  timeouts: 0,
  capped: 0,
  incompleteBursts: 0,
  reached: 0,
  sampleCount: 20,
  replies: 19,
  medianMs: 25,
  timingExcluded: 0,
};
function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...trip(),
    computedAt: start / 1000,
    dataRevision: 1,
    summary: {
      receivedSegments: 4,
      receivedRecords: 435,
      expectedRecords: 435,
      measurements: 41,
      failures: 1,
      protocols: [protocol],
    },
    health: {
      observedCollectionMs: 3300000,
      reportedDurationMs: 3600000,
      coverageIsEstimate: true,
      gapCount: 1,
      gapMs: 150000,
      uploadRetries: 2,
      skippedProbes: 3,
      timingExcluded: 1,
      powerObservations: [
        {
          at: start,
          percent: 90,
          screenInteractive: false,
          deviceIdle: true,
          batteryExempt: true,
        },
      ],
    },
    events: [
      {
        id: 'state',
        at: start,
        kind: 'provider_state',
        provider: 'TEST Etisalat',
        asnState: 'positive',
        phase: 'collecting',
      },
      {
        id: 'gap',
        at: start + 300000,
        end: start + 450000,
        kind: 'collector_gap',
        reason: 'late_control_wakeup',
        durationMs: 150000,
      },
      {
        id: 'upload',
        at: start + 900000,
        end: start + 925000,
        kind: 'upload_pause',
        reason: 'opportunity_finished',
      },
      { id: sid, at: start, end: start + 900000, kind: 'segment', index: 0 },
      {
        id: 'missing',
        at: start + 3000000,
        end: start + 3600000,
        kind: 'unreceived',
        reason: 'No received segment evidence for this interval',
      },
    ],
    segments: [{ index: 0, sessionId: sid, uploaded: true }],
    ...overrides,
  };
}
type Options = {
  role?: string;
  empty?: boolean;
  providerFailure?: boolean;
  tripChanges?: Record<string, unknown>;
  detailChanges?: Record<string, unknown>;
};
async function signedIn(page: Page, options: Options = {}) {
  const role = options.role ?? 'researcher';
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
    const u = new URL(route.request().url()),
      p = u.pathname;
    if (p.endsWith('/profile'))
      return route.fulfill({ json: { role, participantId: 'c'.repeat(32) } });
    if (role === 'participant')
      return route.fulfill({
        status: 403,
        json: { detail: 'Researcher access required' },
      });
    if (p.endsWith('/history-generation'))
      return route.fulfill({ json: { resetAt: 0 } });
    if (p.endsWith('/trip-overview'))
      return route.fulfill({
        json: {
          trips: options.empty ? 0 : 1,
          groundTests: options.empty ? 0 : 1,
          studyTrips: 0,
          incompleteUploads: 0,
        },
      });
    if (p.endsWith('/provider-results'))
      return options.providerFailure
        ? route.fulfill({ status: 503, json: { detail: 'busy' } })
        : route.fulfill({
            json: {
              computedAt: start / 1000,
              items: options.empty
                ? []
                : [
                    {
                      provider: 'TEST Etisalat',
                      asn: '5384',
                      groundTest: true,
                      protocol: 'icmp_burst',
                      target: 'google.com',
                      attempts: 2,
                      successful: 2,
                      probes: 20,
                      replies: 19,
                      medianRttMs: 25,
                      medianMbps: null,
                    },
                  ],
            },
          });
    if (p.endsWith('/trips'))
      return route.fulfill({
        json: {
          items: options.empty ? [] : [trip(options.tripChanges)],
          total: options.empty ? 0 : 41,
        },
      });
    if (p.endsWith('/detail'))
      return route.fulfill({ json: detail(options.detailChanges) });
    if (p.endsWith('/timeline'))
      return route.fulfill({
        json: {
          computedAt: start / 1000,
          clock: 'recorded_wall_clock_utc',
          series: [
            {
              type: 'icmp_burst',
              bucketMs: 1,
              points: [
                {
                  id: 'm',
                  at: start + 1000,
                  type: 'icmp_burst',
                  value: 0,
                  success: true,
                  timingValid: true,
                  target: 'google.com',
                },
              ],
            },
            {
              type: 'download',
              bucketMs: 1,
              points: [
                {
                  id: 'd',
                  at: start + 600000,
                  type: 'download',
                  value: null,
                  success: false,
                  timingValid: true,
                  error: 'timeout',
                  target: 'lab.invalid',
                },
              ],
            },
          ],
        },
      });
    if (p.endsWith('/evidence')) {
      const samples = u.searchParams.get('layer') === 'samples',
        events = u.searchParams.get('layer') === 'events';
      return route.fulfill({
        json: {
          total: 61,
          items: samples
            ? [
                {
                  timestamp: '2026-11-01T12:00:01Z',
                  protocol: 'icmp_burst',
                  sequence: 0,
                  rttMs: 0,
                  outcome: 'reply',
                  address: null,
                  hop: null,
                  phase: 'probe',
                  measurementId: 'm',
                },
              ]
            : events
            ? [
                {
                  timestamp: '2026-11-01T12:05:00Z',
                  kind: 'collector_gap',
                  details: { reason: 'late_control_wakeup' },
                },
              ]
            : [
                {
                  timestamp: '2026-11-01T12:00:01Z',
                  type: 'icmp_burst',
                  value: 0,
                  unit: 'ms',
                  success: true,
                  targetHost: 'google.com',
                  durationMs: 5,
                  transferredBytes: null,
                  errorType: null,
                  method: 'icmp_library',
                  id: 'm',
                },
              ],
        },
      });
    }
    if (p.endsWith('/export') || p.endsWith('/export-summary'))
      return route.fulfill({
        contentType:
          u.searchParams.get('format') === 'csv' || p.endsWith('export-summary')
            ? 'text/csv'
            : 'application/json',
        body:
          u.searchParams.get('format') === 'csv' || p.endsWith('export-summary')
            ? 'trip.id,sample.rttMs\r\na,0\r\n'
            : JSON.stringify({
                trip: trip(),
                segments: [],
                receipt: { uploadComplete: true },
              }),
      });
    if (p.endsWith('/trip-contributors'))
      return route.fulfill({
        json: {
          items: [
            {
              participantId: 'c'.repeat(32),
              trips: 1,
              latestCollection: start,
            },
          ],
        },
      });
    if (p.endsWith('/admin/payments'))
      return route.fulfill(
        role === 'administrator'
          ? {
              json: {
                total: 1,
                items: [
                  {
                    tripId: id,
                    participantId: 'c'.repeat(32),
                    netId: 'abc123',
                    flight: { flightNumber: 'TEST123' },
                    startedAt: start,
                    receivedAt: '2026-11-01T13:00:00Z',
                  },
                ],
              },
            }
          : { status: 403, json: { detail: 'Administrator access required' } },
      );
    if (p.endsWith('/admin/members'))
      return route.fulfill({
        json: { items: [{ participantId: 'c'.repeat(32), role }] },
      });
    if (p.includes('/research/sessions/'))
      return route.fulfill({
        json: {
          session: { id: sid },
          measurements: [],
          events: [],
          snapshots: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { detail: 'Unknown test endpoint' },
    });
  });
}
async function openTrip(page: Page, options: Options = {}) {
  await signedIn(page, options);
  await page.goto('/trips/' + id);
  await expect(
    page.getByRole('heading', { name: 'TEST123', exact: true }),
  ).toBeVisible();
}

test('public registration does not unlock researcher routes', async ({
  page,
}) => {
  await signedIn(page, { role: 'participant' });
  await page.goto('/');
  await expect(
    page.getByText('Researcher access is required.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Research workspace' }),
  ).toHaveCount(0);
});
test('signed-out narrow layouts show clear Google sign in', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Continue with Google' }),
  ).toBeVisible();
});
test('overview is trip-first without duplicated session/download navigation', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/');
  await expect(
    page.getByRole('table', { name: 'Received trips' }),
  ).toBeVisible();
  const nav = page.getByRole('navigation');
  await expect(
    nav.getByRole('link', { name: 'Trips', exact: true }),
  ).toBeVisible();
  for (const name of ['Sessions', 'Downloads'])
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(
    nav.getByRole('link', { name: 'Measurement guide', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('GPS-supported', { exact: false })).toHaveCount(
    0,
  );
  await expect(page.getByText('Latest confidence')).toHaveCount(0);
  await expect(
    page.getByText('Last updated', { exact: false }).first(),
  ).toBeVisible();
});
test('measurement guide stays accessible without trips and supports variable lookup', async ({
  page,
}) => {
  await signedIn(page, { empty: true });
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Measurement guide', exact: true })
    .click();
  await expect(page).toHaveURL('/guide');
  await expect(
    page.getByRole('heading', { name: 'Measurement guide', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Unavailable does not mean zero.', { exact: true }),
  ).toBeVisible();
  await page.getByText('M-Lab NDT7 speed test', { exact: true }).click();
  await expect(
    page.getByText(
      'ndt7-client-android 0.2.2-skymeasure.3 through the Android adapter',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByLabel('Search variables').fill('rttMs');
  await page.getByLabel('Variable table').selectOption('Samples');
  const variable = page
    .locator('details')
    .filter({ has: page.getByText('Samples · rttMs', { exact: true }) });
  await variable.locator('summary').click();
  await expect(
    variable.getByText('Why it may be empty', { exact: true }),
  ).toBeVisible();
  await expect(
    variable.getByText('sample.rttMs', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Measurement guide', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'All export column definitions' }),
  ).toHaveAttribute('href', '/measurements/columns.md');
});
test('guide shows real app requests and calculations without loading trip evidence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page, { empty: true });
  const recordRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/v2\/research\/(trips|sessions)(?:[/?]|$)/.test(request.url()))
      recordRequests.push(request.url());
  });
  await page.goto('/guide');
  for (const [name, implementation] of [
    ['ICMP echo', 'Pinger(host = host'],
    [
      'TCP connection',
      'socket.connect({ host, port, connectTimeout: timeoutMs }',
    ],
    ['HTTP latency', 'await response.text()'],
    ['Controlled download', 'fs.downloadFile({'],
    ['Controlled upload', '/api/v1/probe/upload?request='],
    [
      'M-Lab NDT7 speed test',
      'test.startTest(NDTTest.TestType.DOWNLOAD_AND_UPLOAD)',
    ],
  ]) {
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByLabel(`${name} app call`)).toContainText(
      implementation,
    );
  }
  await expect(
    page.getByRole('heading', { name: 'How summaries are calculated' }),
  ).toBeVisible();
  await page.getByLabel('Search variables').fill('port');
  await page.getByLabel('Variable table').selectOption('Measurements');
  const port = page
    .locator('details')
    .filter({ has: page.getByText('Measurements · port', { exact: true }) });
  await port.locator('summary').click();
  await expect(
    port.getByText(
      'measurement.details.targetPort ?? measurement.raw.request.port',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByLabel('Search variables').fill('details');
  await page.getByLabel('Variable table').selectOption('Events');
  const details = page
    .locator('details')
    .filter({ has: page.getByText('Events · details', { exact: true }) });
  await details.locator('summary').click();
  await expect(
    details.getByText('event.details', { exact: true }),
  ).toBeVisible();
  expect(recordRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
test('slow provider statistics never block the trip list', async ({ page }) => {
  await signedIn(page, { providerFailure: true });
  await page.goto('/');
  await expect(
    page.getByRole('table', { name: 'Received trips' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry provider results' }),
  ).toBeVisible();
});
test('trip filters are compact, paginated and represented in the URL', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/trips');
  await expect(
    page.getByRole('table', { name: 'Received trips' }),
  ).toBeVisible();
  await page.getByLabel('Search trips').fill('QR123');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/q=QR123/);
  await page.getByRole('button', { name: 'Next trips' }).click();
  await expect(page).toHaveURL(/page=1/);
  await page.getByLabel('Data type').selectOption('ground');
  await expect(page).toHaveURL(/kind=ground/);
  await expect(page).not.toHaveURL(/page=1/);
});
test('verified reset shows a clean empty state without fake data', async ({
  page,
}) => {
  await signedIn(page, { empty: true });
  await page.goto('/');
  await expect(page.getByText('No trips yet.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'TEST123', exact: true }),
  ).toHaveCount(0);
});
test('deep trip links expose network and collector health separately', async ({
  page,
}) => {
  await openTrip(page);
  await expect(
    page.getByRole('tab', { name: 'Network results' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Collector health' }).click();
  await expect(page.getByText('Skipped probe events')).toBeVisible();
  await expect(page.getByText('Live upload retries')).toBeVisible();
  await expect(
    page.getByText('Battery and Android power observations'),
  ).toBeVisible();
});
test('partial trips remain partial even when registered record counts match', async ({
  page,
}) => {
  await openTrip(page, {
    detailChanges: {
      ...trip({
        uploadComplete: false,
        segmentCount: 96,
        receivedSegments: 11,
        completeSegments: 11,
        missingSegments: 85,
      }),
      ...{
        summary: detail().summary,
        health: detail().health,
        events: detail().events,
        segments: detail().segments,
      },
    },
  });
  await expect(
    page.getByText('Upload incomplete', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('11/96 segments reconciled.', { exact: false }),
  ).toBeVisible();
});
test('timeline distinguishes recorded gaps from unreceived evidence', async ({
  page,
}) => {
  await openTrip(page);
  await expect(
    page.getByRole('region', { name: 'Whole-trip timeline' }),
  ).toBeVisible();
  await page.getByText('Inspect event intervals').click();
  await expect(
    page.getByRole('cell', { name: 'collector gap', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'unreceived', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('A gap does not prove the phone slept.', { exact: false }),
  ).toBeVisible();
});
test('evidence is loaded only on demand, preserves zero and has six default columns', async ({
  page,
}) => {
  let requests = 0;
  await openTrip(page);
  page.on('request', r => {
    if (r.url().includes('/evidence?')) requests++;
  });
  expect(requests).toBe(0);
  await page
    .getByRole('button', {
      name: 'Inspect individual probes, segments and raw evidence',
    })
    .click();
  const table = page.getByRole('table', {
    name: 'Trip observations',
    exact: true,
  });
  await expect(table).toBeVisible();
  expect(requests).toBe(1);
  await expect(table.getByRole('columnheader')).toHaveCount(6);
  await expect(
    table.getByRole('cell', { name: '0', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Find a column')).not.toBeVisible();
  await page.getByText('Customize columns', { exact: true }).click();
  await expect(page.getByLabel('Find a column')).toBeVisible();
});
test('sample outcome filters request only the selected server page', async ({
  page,
}) => {
  await openTrip(page);
  await page
    .getByRole('button', {
      name: 'Inspect individual probes, segments and raw evidence',
    })
    .click();
  await page.getByLabel('Evidence rows').selectOption('samples');
  await page.getByLabel('Evidence outcome').selectOption('timeout');
  const request = page.waitForRequest(
    r => r.url().includes('layer=samples') && r.url().includes('offset=50'),
  );
  await page.getByRole('button', { name: 'Next observations' }).click();
  expect((await request).url()).toContain('outcome=timeout');
});

test('trip summary and evidence keep app interruptions separate from failures', async ({
  page,
}) => {
  await openTrip(page, {
    detailChanges: {
      summary: {
        receivedSegments: 4,
        receivedRecords: 435,
        expectedRecords: 435,
        measurements: 183,
        failures: 1,
        interruptions: 4,
        protocols: [
          {
            ...protocol,
            attempts: 183,
            successful: 178,
            failed: 1,
            timeouts: 1,
            interrupted: 4,
          },
        ],
      },
    },
  });
  const summary = page.getByRole('region', {
    name: 'Trip measurement summary',
    exact: true,
  });
  await expect(
    summary.getByText('183 measurement rounds', { exact: false }),
  ).toContainText('1 failed · 4 interrupted');
  await expect(
    summary.getByRole('cell', {
      name: '1 timed out; 4 interrupted',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    summary.getByText('outcomes unavailable', { exact: false }),
  ).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'Inspect individual probes, segments and raw evidence',
    })
    .click();
  const request = page.waitForRequest(
    r =>
      r.url().includes('/evidence?') && r.url().includes('outcome=interrupted'),
  );
  await page.getByLabel('Evidence outcome').selectOption('interrupted');
  expect((await request).url()).toContain('layer=measurements');
});
test('column help describes units and missing values without a separate guide page', async ({
  page,
}) => {
  await openTrip(page);
  await page
    .getByRole('button', {
      name: 'Inspect individual probes, segments and raw evidence',
    })
    .click();
  await page.getByLabel('About Result', { exact: true }).click();
  await expect(
    page
      .getByRole('columnheader')
      .filter({ has: page.getByLabel('About Result', { exact: true }) })
      .locator('details[open] p'),
  ).toBeVisible();
  await expect(
    page
      .getByRole('columnheader')
      .filter({ has: page.getByLabel('About Result', { exact: true }) })
      .locator('details[open] p'),
  ).toBeVisible();
});
test('whole-trip downloads are actual JSON and combined CSV exports', async ({
  page,
}) => {
  await openTrip(page);
  await page.getByText('Download trip', { exact: true }).click();
  for (const [name, suffix] of [
    ['Complete original JSON', '.json'],
    ['Combined measurements / samples CSV', '.csv'],
  ]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`trip-${id}${suffix}`);
  }
});
test('route illustration uses public endpoints and does not claim a flown path', async ({
  page,
}) => {
  await openTrip(page);
  await expect(page.getByText('Reported route · DOH → JFK')).toBeVisible();
  await page.getByText('Reported route · DOH → JFK').click();
  await expect(
    page.getByRole('img', { name: /Illustration between reported airports/ }),
  ).toBeVisible();
  await expect(
    page.getByText('not a recorded flight path', { exact: false }),
  ).toBeVisible();
});
test('ambiguous route inputs stay textual without geocoding', async ({
  page,
}) => {
  await openTrip(page, {
    detailChanges: {
      ...detail(),
      flight: {
        flightNumber: 'TEST123',
        departure: 'Test origin',
        arrival: 'Test destination',
      },
    },
  });
  await expect(
    page.getByText('A map appears when both airport endpoints', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: /Illustration between reported airports/ }),
  ).toHaveCount(0);
});
test('researchers never request or see payment identifiers', async ({
  page,
}) => {
  let paymentRequests = 0;
  page.on('request', r => {
    if (r.url().includes('/admin/payments')) paymentRequests++;
  });
  await signedIn(page);
  await page.goto('/participants');
  await expect(
    page.getByRole('heading', { name: 'Participants and team' }),
  ).toBeVisible();
  expect(paymentRequests).toBe(0);
  await expect(
    page.getByRole('heading', { name: 'Payment reconciliation' }),
  ).toHaveCount(0);
  await expect(page.getByText('abc123')).toHaveCount(0);
});
test('administrators retain team and restricted payment access', async ({
  page,
}) => {
  await signedIn(page, { role: 'administrator' });
  await page.goto('/participants');
  await expect(
    page.getByRole('heading', { name: 'Research team access' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'abc123', exact: true }),
  ).toBeVisible();
});
for (const width of [390, 1280])
  test(`evidence scrolls horizontally without overflowing the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTrip(page);
    await page
      .getByRole('button', {
        name: 'Inspect individual probes, segments and raw evidence',
      })
      .click();
    await page.getByText('Customize columns', { exact: true }).click();
    await page.getByRole('button', { name: 'Show all columns' }).click();
    await page.getByRole('button', { name: 'Scroll columns right' }).click();
    const area = page.getByRole('region', {
      name: 'Trip observations scroll area',
    });
    expect(await area.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/trip-${width}.png`,
      fullPage: true,
    });
  });
test('sample interpretation retains zero, failures, and qualified traceroute labels', () => {
  const rows = sampleRows([
    {
      id: 'm',
      type: 'icmp_burst',
      details: {
        samples: [{ rttMs: 0 }, { rttMs: null, errorType: 'timeout' }],
      },
      route: { samples: [{ kind: 'host_unreachable', rttMs: 9 }] },
    },
  ]);
  expect(rows.map(r => r.outcome)).toEqual(['response', 'timeout', 'response']);
  expect(rows[0].rttMs).toBe(0);
  expect(csvText(['a'], [['=formula']])).toContain("'=formula");
  for (const group of [
    ['Measurements', measurementFields],
    ['Samples', probeFields],
    ['Scheduling', scheduleFields],
  ] as const) {
    for (const [key] of group[1]) {
      const d = variableDefinition(group[0], key);
      expect(d.units).toBeTruthy();
      expect(d.blank).toBeTruthy();
    }
  }
});

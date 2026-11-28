import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  access,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { PAPER_REGISTRY } from '../../src/measurements/paperSuite.ts';
import { sealEvidence, verifyEvidence } from './evidence.mjs';
import {
  packageEvidence,
  repetitionReport,
  sanitizeEvidence,
} from './package.mjs';

const AT = '2026-11-28T10:00:00.000Z';
function measurement(id, type, extra = {}) {
  return {
    id,
    sessionId: 'session',
    type,
    timestamp: AT,
    scheduledAt: AT,
    success: true,
    errorType: null,
    value: 0,
    unit: 'ms',
    targetHost: 'example.test',
    raw: { library: 'test-library', version: '1', callbacks: [] },
    ...extra,
  };
}
function session(measurements, source = 'app') {
  return {
    session: {
      id: 'session',
      startedAt: AT,
      endedAt: '2026-11-28T11:00:00.000Z',
      config: {
        collectionMode: source === 'mac' ? 'linux_baseline' : 'flight_auto',
        collectorVersion: 'fixture',
        measurementSuiteVersion: PAPER_REGISTRY.version,
        icmpHost: 'example.test',
        udpPort: 9876,
        tcpServerUrl: 'https://example.test',
      },
    },
    measurements,
    snapshots: [
      { id: 'snapshot', type: 'wifi', publicIp: '203.0.113.9', asn: 64512 },
    ],
    events: [],
  };
}
async function fixture(t, { appMeasurements, macMeasurements, rawPath } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'supervisor-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app.json'),
    mac = path.join(dir, 'mac'),
    out = path.join(dir, 'bundle');
  await mkdir(mac);
  await mkdir(path.join(mac, 'raw'));
  const route = {
    reached: false,
    stopReason: 'complete',
    samples: [
      {
        hop: 1,
        sequence: 0,
        address: '192.0.2.1',
        rttMs: 0,
        kind: 'reply',
        packet: {
          observedAtNs: '17958600000000000001',
          response: { receivedHex: '001122', receivedSocketBytes: 3 },
        },
      },
      { hop: 2, sequence: 0, address: null, rttMs: null, kind: 'timeout' },
    ],
  };
  const appRows = appMeasurements ?? [
    measurement('trace', 'traceroute', {
      targetId: 'facebook_domain',
      success: false,
      errorType: 'timeout',
      value: null,
      route,
      futureCollectorField: { enabled: false, ns: '99999999999999999999' },
    }),
    measurement('icmp', 'icmp_burst', {
      details: {
        complete: true,
        samples: Array.from({ length: 10 }, (_, i) => ({
          sequence: i,
          rttMs: i,
          raw: { callbacks: [{ value: { sequence: i } }] },
        })),
      },
    }),
    measurement('cdn', 'cdn_fetch', {
      targetId: 'google',
      paper: {
        headers: { 'content-length': '89501' },
        bodyBytes: 89501,
        totalMs: 0,
        sha256: 'example',
      },
    }),
    measurement('down', 'ndt7_download', {
      reference: { clientBytes: 1024, elapsedSeconds: 1 },
    }),
    measurement('up', 'ndt7_upload', {
      reference: { serverBytes: 1024, elapsedSeconds: 1 },
    }),
  ];
  const macRows = macMeasurements ?? [
    measurement('trace', 'traceroute', {
      targetId: 'facebook_domain',
      success: false,
      errorType: 'timeout',
      value: null,
      route,
    }),
    measurement('down', 'ndt7_download', { unit: 'Mbps' }),
    measurement('up', 'ndt7_upload', { unit: 'Mbps' }),
  ];
  for (const m of macRows) {
    const pair = m.type.startsWith('ndt7_'),
      name = rawPath ?? `raw/${pair ? 'down' : m.id}.json`;
    m.raw = { ...m.raw, request: { outputFile: name } };
    if (!rawPath)
      await writeFile(
        path.join(mac, name),
        JSON.stringify({
          measurementId: pair ? 'down' : m.id,
          type: pair ? 'ndt7_download' : m.type,
          runs: [
            {
              argv: ['example-tool', '--target', 'example.test'],
              stdout: 'header\nraw output\n',
              stderr: 'warning\n',
              code: 0,
              outputCapture: { stdoutTruncated: true, stderrTruncated: false },
            },
          ],
        }),
      );
  }
  await writeFile(
    app,
    JSON.stringify({
      trip: { flight: { flightNumber: 'PRIVATE' } },
      segments: [session(appRows)],
    }),
  );
  await writeFile(
    path.join(mac, 'baseline.json'),
    JSON.stringify({ sessions: [session(macRows, 'mac')] }),
  );
  await writeFile(
    path.join(mac, 'run.json'),
    JSON.stringify({
      environment: { platform: 'darwin', versions: { curl: 'fixture' } },
      config: {
        collectorVersion: 'fixture',
        validationMode: 'paired_full_shared_load',
      },
    }),
  );
  await sealEvidence(mac);
  return { app, mac, out, dir, appRows, macRows };
}

test('packages all observations, hops, callbacks and original raw commands in a self-contained verified ZIP', async t => {
  const f = await fixture(t);
  const appBefore = await readFile(f.app),
    macBefore = await readFile(path.join(f.mac, 'baseline.json'));
  const result = await packageEvidence(f);
  assert.deepEqual(result.measurements, { app: 5, mac: 3 });
  const trace = JSON.parse(
    await readFile(path.join(f.out, 'traceroute_app.json'), 'utf8'),
  );
  assert.deepEqual(trace.measurements, [f.appRows[0]]);
  assert.equal(
    trace.measurements[0].route.samples[0].packet.observedAtNs,
    '17958600000000000001',
  );
  assert.equal(trace.measurements[0].value, null);
  assert.equal(trace.measurements[0].route.samples[0].rttMs, 0);
  assert.equal(trace.measurements[0].futureCollectorField.enabled, false);
  assert.equal(trace.metadata.sessions[0].snapshots[0].publicIp, '203.0.113.9');
  const icmp = JSON.parse(
    await readFile(path.join(f.out, 'icmp_app.json'), 'utf8'),
  );
  assert.equal(icmp.measurements[0].details.samples.length, 10);
  const macTrace = JSON.parse(
    await readFile(path.join(f.out, 'traceroute_mac.json'), 'utf8'),
  );
  assert.equal(
    macTrace.commandOutputs['raw/trace.json'].runs[0].stdout,
    'header\nraw output\n',
  );
  assert.equal(macTrace.metadata.coverage.truncatedCommandStreams, 1);
  const mlab = JSON.parse(
    await readFile(path.join(f.out, 'mlab_mac.json'), 'utf8'),
  );
  assert.equal(mlab.measurements.length, 2);
  assert.equal(Object.keys(mlab.commandOutputs).length, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(f.out, 'udp_app.json'), 'utf8'))
      .metadata.measurementCount,
    0,
  );
  assert.equal((await verifyEvidence(f.out)).ok, true);
  assert.equal((await verifyEvidence(f.mac)).ok, true);
  assert.deepEqual(await readFile(f.app), appBefore);
  assert.deepEqual(
    await readFile(path.join(f.mac, 'baseline.json')),
    macBefore,
  );
  assert.equal((await stat(f.out)).mode & 0o077, 0);
  assert.equal((await stat(result.archive)).mode & 0o077, 0);
  const zip = unzipSync(new Uint8Array(await readFile(result.archive)));
  assert.equal(
    Object.keys(zip).filter(n => /_(app|mac)\.json$/.test(n)).length,
    14,
  );
  for (const [name, bytes] of Object.entries(zip))
    assert.deepEqual(
      Buffer.from(bytes),
      await readFile(path.join(f.out, name)),
    );
  assert.equal(
    JSON.parse(strFromU8(zip['manifest.json'])).kind,
    'supervisor-test-evidence',
  );
  assert.equal(Object.hasOwn(zip, '.evidence-lock'), false);
  const manifest = JSON.parse(
    await readFile(path.join(f.out, 'manifest.json'), 'utf8'),
  );
  assert.equal(JSON.stringify(manifest).includes(f.dir), false);
  await assert.rejects(packageEvidence(f), /already exists/);
});

test('counts complete executions per target, not samples; keeps failures and separates interruptions', () => {
  const records = [
    measurement('a', 'traceroute', {
      targetId: 'fixed_ip_control',
      route: { samples: Array(30).fill({ hop: 1 }) },
    }),
    measurement('b', 'traceroute', {
      targetId: 'fixed_ip_control',
      success: false,
      errorType: 'timeout',
    }),
    measurement('c', 'traceroute', {
      targetId: 'fixed_ip_control',
      success: false,
      errorType: 'cancelled',
    }),
    measurement('d', 'icmp_burst', {
      details: { samples: Array(10).fill({ rttMs: 1 }) },
    }),
    measurement('e', 'udp_echo', {
      details: { samples: Array(20).fill({ rttMs: 1 }) },
    }),
    measurement('f', 'cdn_fetch', {
      targetId: 'google',
      resolvedAddress: '192.0.2.2',
    }),
    measurement('g', 'cdn_fetch', {
      targetId: 'google',
      resolvedAddress: '192.0.2.3',
    }),
  ];
  const r = repetitionReport(
    { app: [session(records)], mac: [session([], 'mac')] },
    15,
  );
  const get = (testName, target) =>
    r.groups.find(
      g =>
        g.source === 'app' &&
        g.test === testName &&
        (!target || g.target === target),
    );
  assert.deepEqual(
    [
      get('traceroute', 'fixed_ip_control').completed,
      get('traceroute', 'fixed_ip_control').failed,
      get('traceroute', 'fixed_ip_control').interrupted,
      get('traceroute', 'fixed_ip_control').remaining,
    ],
    [2, 1, 1, 13],
  );
  assert.equal(get('icmp').completed, 1);
  assert.equal(get('udp').completed, 1);
  assert.equal(get('cdn', 'google').completed, 2);
  assert.deepEqual(get('cdn', 'google').resolvedIpCounts, {
    '192.0.2.2': 1,
    '192.0.2.3': 1,
  });
  assert.equal(get('cdn', 'jquery').remaining, 15);
  assert.equal(get('traceroute', 'facebook_domain').completed, 0);
});

test('M-Lab counts genuinely linked pairs and reports unmatched or interrupted directions', () => {
  const records = [
    measurement('d1', 'ndt7_download'),
    measurement('u1', 'ndt7_upload'),
    measurement('d2', 'ndt7_download', { scheduledAt: '2026-11-28T10:10:00Z' }),
    measurement('u2', 'ndt7_upload', {
      scheduledAt: '2026-11-28T10:10:00Z',
      success: false,
      errorType: 'cancelled',
    }),
    measurement('orphan', 'ndt7_download', { scheduledAt: null }),
    measurement('missing', 'ndt7_upload', {
      scheduledAt: '2026-11-28T10:20:00Z',
    }),
  ];
  const r = repetitionReport({ app: [session(records)] }, 15).groups.find(
    g => g.test === 'mlab',
  );
  assert.equal(r.measurements, 6);
  assert.equal(r.completed, 1);
  assert.equal(r.succeeded, 1);
  assert.equal(r.interrupted, 1);
  assert.equal(r.unpairedDirections, 2);
  assert.equal(r.remaining, 14);
});

test('a mixed-destination burst remains one execution with both destination IPs visible', () => {
  const m = measurement('mixed', 'icmp_burst', {
    details: {
      samples: [
        { packet: { resolvedAddress: '192.0.2.1' } },
        { packet: { resolvedAddress: '192.0.2.2' } },
      ],
    },
  });
  const row = repetitionReport({ app: [session([m])] }, 15).groups.find(
    g => g.test === 'icmp',
  );
  assert.equal(row.completed, 1);
  assert.equal(row.mixedDestinationMeasurements, 1);
  assert.deepEqual(row.resolvedIpCounts, { '192.0.2.1': 1, '192.0.2.2': 1 });
});

test('redacts identities, auth fields, URL credentials, JSON/JSONL and header text without changing technical values', () => {
  const redactions = [];
  const value = {
    ownerId: 'private-owner',
    netId: 'private-netid',
    flight: { route: 'private-route' },
    publicIp: '203.0.113.1',
    port: 0,
    nullable: null,
    ns: '99999999999999999999',
    future: { keep: false },
    raw: {
      request: {
        Authorization: 'Bearer credential',
        target:
          'https://user:password@example.test/a?access_token=private-token&n=7',
        argv: ['{"token":"argv-secret","n":0}'],
      },
      stdout: '{"refresh_token":"refresh-secret","n":0}\n{"result":null}\n',
      stderr: 'Cookie: private-cookie\nnormal line\n',
    },
  };
  const clean = sanitizeEvidence(value, redactions);
  assert.equal(clean.ownerId, undefined);
  assert.equal(clean.netId, undefined);
  assert.equal(clean.flight, undefined);
  for (const k of ['publicIp', 'port', 'nullable', 'ns', 'future'])
    assert.deepEqual(clean[k], value[k]);
  const encoded = JSON.stringify(clean);
  for (const secret of [
    'private-owner',
    'private-netid',
    'private-route',
    'credential',
    'private-token',
    'refresh-secret',
    'argv-secret',
    'private-cookie',
  ])
    assert.equal(encoded.includes(secret), false, secret);
  assert.equal(clean.raw.request.target.includes('n=7'), true);
  assert.ok(redactions.length >= 7);
  const untouched = '{"bytes":0,"elapsedNs":"99999999999999999999"}\n';
  assert.equal(sanitizeEvidence({ stdout: untouched }, []).stdout, untouched);
  const truncated = '{"access_token":"truncated-secret"}\n{"partial":';
  assert.equal(
    sanitizeEvidence({ stdout: truncated }, []).stdout.includes(
      'truncated-secret',
    ),
    false,
  );
  assert.equal(
    sanitizeEvidence(JSON.parse('{"__proto__":{"custom":true}}'), []).__proto__
      .custom,
    true,
  );
  assert.equal({}.custom, undefined);
});

test('unknown measurement types and missing values survive; bundle secrets are removed everywhere', async t => {
  const record = measurement('future', 'future_protocol', {
    value: null,
    ownerId: 'owner-secret',
    raw: {
      callbacks: [
        { value: { Authorization: 'Bearer auth-secret', futureNumber: 0 } },
      ],
    },
  });
  const f = await fixture(t, { appMeasurements: [record] });
  const result = await packageEvidence(f);
  const file = JSON.parse(
    await readFile(path.join(f.out, 'other_app.json'), 'utf8'),
  );
  assert.equal(file.measurements.length, 1);
  assert.equal(file.measurements[0].value, null);
  assert.equal(file.measurements[0].raw.callbacks[0].value.futureNumber, 0);
  const zip = unzipSync(new Uint8Array(await readFile(result.archive)));
  for (const bytes of Object.values(zip))
    for (const secret of ['owner-secret', 'auth-secret'])
      assert.equal(strFromU8(bytes).includes(secret), false);
  assert.ok(
    JSON.parse(strFromU8(zip['redactions.json'])).entries.some(e =>
      e.path.includes('Authorization'),
    ),
  );
});

for (const rawPath of [
  '../outside.json',
  '/tmp/outside.json',
  'raw/missing.json',
])
  test(`refuses unsafe or missing command evidence: ${rawPath}`, async t => {
    const f = await fixture(t, { rawPath });
    await assert.rejects(packageEvidence(f), /escapes|ENOENT/);
    await assert.rejects(access(f.out));
  });

test('refuses changed and symlinked Mac sources before creating output', async t => {
  const f = await fixture(t);
  await symlink(f.app, path.join(f.mac, 'raw', 'extra-link.json'));
  await assert.rejects(packageEvidence(f), /integrity verification failed/);
  await assert.rejects(access(f.out));
});

test('refuses command records assigned to an unrelated measurement', async t => {
  const f = await fixture(t);
  const file = path.join(f.mac, 'raw', 'trace.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.measurementId = 'unrelated-id';
  await writeFile(file, JSON.stringify(raw));
  await sealEvidence(f.mac);
  await assert.rejects(
    packageEvidence(f),
    /belongs to a different measurement/,
  );
  await assert.rejects(access(f.out));
});

test('refuses duplicate records, conflicting exports and mismatched parent IDs', async t => {
  const f = await fixture(t, {
    appMeasurements: [
      measurement('same', 'icmp_burst'),
      measurement('same', 'icmp_burst'),
    ],
  });
  await assert.rejects(packageEvidence(f), /duplicate measurement ID/);
  const first = session([measurement('one', 'icmp_burst')]);
  await writeFile(
    f.app,
    JSON.stringify({
      segments: [
        first,
        { ...first, measurements: [measurement('two', 'udp_echo')] },
      ],
    }),
  );
  await assert.rejects(packageEvidence(f), /Conflicting exports/);
  first.measurements[0].sessionId = 'wrong';
  await writeFile(f.app, JSON.stringify(first));
  await assert.rejects(packageEvidence(f), /different parent session/);
});

test('refuses malformed measurements, invalid minimums and writes inside the source run', async t => {
  const f = await fixture(t, { appMeasurements: [{ type: 'icmp_burst' }] });
  await assert.rejects(packageEvidence(f), /without an ID or type/);
  await assert.rejects(
    packageEvidence({ ...f, minimumRepeats: 0 }),
    /positive safe integer/,
  );
  await assert.rejects(
    packageEvidence({ ...f, minimumRepeats: 1.2 }),
    /positive safe integer/,
  );
  await assert.rejects(
    packageEvidence({ ...f, out: path.join(f.mac, 'bundle') }),
    /separate from/,
  );
});

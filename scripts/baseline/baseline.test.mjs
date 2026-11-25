import { PILOT_TRIP_POLICY, PAPER_TRIP_POLICY } from '../../src/trips/model.ts';
import { COLLECTOR_POLICY } from '../../src/trips/scheduler.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pairedTimes, QUALIFICATION_MS, runSchedule } from './schedule.mjs';
import * as tools from './tools.mjs';
import { clockTime, createOutput, duration, envValues, isTunnel, parseRoute } from './run.mjs';
import { protocolSummary, wilson } from './summary.mjs';
import { compare, loadSessions, markdown, readInputs } from './compare.mjs';

const fixture = name =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
const T0 = Date.parse('2026-11-21T00:00:00Z');

/** Time advances only when every task is waiting. */
function virtualClock() {
  let t = T0;
  let timers = [];
  let suspended = 0;
  const clock = {
    now: () => t,
    mono: () => t - T0 - suspended,
    suspend(ms) {
      t += ms;
      suspended += ms;
    },
    wait: (ms, signal) =>
      new Promise(resolve => {
        if (signal?.aborted) return resolve();
        const timer = { at: t + Math.max(0, ms), resolve };
        timers.push(timer);
        signal?.addEventListener('abort', () => {
          timers = timers.filter(x => x !== timer);
          resolve();
        });
      }),
    async drive(promise) {
      let done = false;
      const settled = promise.finally(() => (done = true));
      settled.catch(() => {});
      while (!done) {
        for (let i = 0; i < 3 && !done; i++) await new Promise(r => setImmediate(r));
        if (done) break;
        assert.ok(timers.length, 'schedule stalled with no timers');
        const next = timers.reduce((a, b) => (b.at < a.at ? b : a));
        timers = timers.filter(x => x !== next);
        t = Math.max(t, next.at);
        next.resolve();
      }
      return settled;
    },
  };
  return clock;
}
// Typical durations from saved phone exports.
const TYPICAL = {
  icmp_burst: 3542, udp_echo: 7839, tcp_connect: 41, traceroute: 3457,
  cdn_fetch: 800, dns_resolver:200, download: 41633, upload: 4478, ndt7_download: 21000, control_gateway: 2600, control_icmp: 5400, control_tcp: 600,
};
async function simulate(options, hooks = {}) {
  const clock = virtualClock();
  const log = { saved: [], controls: [], events: [], segments: 0, closed: 0, overlap: false };
  let active = 0;
  const trip = await clock.drive(
    runSchedule(
      {
        clock,
        run: async (type, { signal }) => {
          if (active++) log.overlap = true;
          const before = clock.now();
          await clock.wait(hooks.duration?.(type, before - T0) ?? TYPICAL[type], signal);
          await hooks.after?.(type, clock);
          active--;
          const base = { type, value: 1, unit: 'ms', success: !signal.aborted, errorType: signal.aborted ? 'cancelled' : null, durationMs: clock.now() - before };
          const result = { ...base, ...hooks.result?.(type, base) };
          return type === 'ndt7_download' ? [result, { ...result, type: 'ndt7_upload' }] : result;
        },
        identity: async () => true,
        sink: {
          openSegment: async () => void log.segments++,
          closeSegment: async () => void log.closed++,
          event: async (kind, details) => void log.events.push({ kind, details, at: clock.now() - T0 }),
          save: async (m, control) => void (control ? log.controls : log.saved).push(m),
        },
      },
      { policy:PILOT_TRIP_POLICY, random: () => 0.5, ...options },
    ),
  );
  return { ...log, trip };
}
const count = (rows, type) => rows.filter(m => m.type === type).length;
const start = m => Date.parse(m.scheduling.startedAt) - T0;

test('a simulated overnight trip matches the recorded phone trip', async () => {
  // Phone: 11 h 17 min 56 s; 675 ICMP, UDP and TCP; 46 traceroutes; 46 segments.
  const r = await simulate(
    { durationMs: (11 * 3600 + 17 * 60 + 56) * 1000, controls: true, mlab: true,
      policy: { ...PILOT_TRIP_POLICY, version:'flight-pilot-hourly-2026-11-20', downloadBytes:5000000, downloadTimeoutMs:undefined },
      collectorPolicy:{ ...COLLECTOR_POLICY, version:'collector-scheduler-2026-11-08', boundaryGraceMs:0 } },
    // Both of that trip's downloads timed out, at 90 s each.
    {
      duration: type => (type === 'download' ? 90000 : undefined),
      result: type => (type === 'download' ? { success: false, errorType: 'timeout' } : {}),
    },
  );
  for (const type of ['icmp_burst', 'udp_echo', 'tcp_connect']) assert.equal(count(r.saved, type), 675, type);
  assert.equal(count(r.saved, 'traceroute'), 46);
  assert.equal(r.segments, 46);
  assert.equal(r.closed, 46);
  assert.equal(r.overlap, false);
  assert.equal(count(r.saved, 'download'), 2);
  assert.ok(r.events.some(e => e.kind === 'transfer_disabled' && e.details.type === 'download'));
});

test('first hour follows the app order and timing', async () => {
  const r = await simulate({ durationMs: 3600000, controls: false, mlab: true });
  const first = type => start(r.saved.find(m => m.type === type)) - QUALIFICATION_MS;
  // Probes may begin up to the app's one-second tolerance early.
  for (const [type, at] of [['icmp_burst', 1000], ['udp_echo', 10000], ['tcp_connect', 20000], ['traceroute', 60000]])
    assert.ok(first(type) >= at - 1000 && first(type) <= at + 5000, `${type} ${first(type)}`);
  assert.ok(first('ndt7_download') >= 60000 && first('ndt7_download') <= 181000 + 12000);
  assert.ok(first('download') >= 299000 && first('download') <= 330000, String(first('download')));
  assert.ok(first('upload') > first('download'));
  assert.equal(count(r.saved, 'download'), 1);
});

for (const hours of [14, 24]) test(`${hours}-hour new-policy scheduling preserves boundaries and ten transfer slots`, async () => {
  const r = await simulate({ durationMs: hours * 3600000, controls: false, mlab: true, uploadPauseMs: 22000 });
  assert.equal(r.overlap, false);
  // A final short segment may retain control events at Stop; it must not
  // create an additional measurement window or discard those events.
  assert.ok(r.segments >= hours * 4 && r.segments <= hours * 4 + 1);
  assert.equal(r.closed, r.segments);
  assert.equal(count(r.saved, 'ndt7_download'), 1);
  assert.equal(count(r.saved, 'ndt7_upload'), 1);
  assert.equal(count(r.saved, 'download'), 10);
  assert.equal(count(r.saved, 'upload'), 10);
  assert.equal(r.trip.policy.downloadBytes, 500000);
  const pauses = r.events.filter(e => e.kind === 'upload_pause');
  for (let i = 0; i < pauses.length; i++) {
    const started = Date.parse(pauses[i].details.startedAt) - T0;
    assert.ok(started >= (i + 1) * 900000 && started <= (i + 1) * 900000 + 10000, String(started));
  }
});

test('upload gaps stop probing for the configured time every fifteen minutes', async () => {
  const r = await simulate({ durationMs: 3600000, controls: true, uploadPauseMs: 22000 });
  const gaps = r.events.filter(e => e.kind === 'upload_pause').map(e => e.details);
  assert.equal(gaps.filter(g => g.durationMs > 0).length, 3);
  for (const gap of gaps) {
    assert.equal(gap.simulated, true);
    assert.ok(gap.durationMs === 22000 || gap.durationMs === 0);
    const [a, b] = [Date.parse(gap.startedAt), Date.parse(gap.endedAt)];
    for (const m of [...r.saved, ...r.controls])
      assert.ok(Date.parse(m.scheduling.callbackAt) <= a || Date.parse(m.scheduling.startedAt) >= b);
  }
});

test('work exceeding boundary grace is interrupted and kept', async () => {
  // Qualifying at 44 s puts a slow ICMP burst across the 900 s boundary.
  const r = await simulate(
    { durationMs: 1100000, paired: { qualifiedAt: T0 + 44000, transferAt: T0 + 3600000 } },
    { duration: (type, at) => (type === 'icmp_burst' && at > 880000 && at < 890000 ? 34000 : undefined) },
  );
  const cancelled = r.saved.filter(m => m.errorType === 'interrupted' && m.interruptionReason === 'segment_boundary');
  assert.equal(cancelled.length, 1);
  assert.equal(Date.parse(cancelled[0].scheduling.callbackAt) - T0, 910000);
  assert.equal(r.events.filter(e => e.kind === 'upload_pause').length, 1);
  assert.equal(r.overlap, false);
});

test('late slots are skipped, not replayed', async () => {
  const r = await simulate({ durationMs: 900000, policy: { ...PILOT_TRIP_POLICY, downloadBytes: 5000000, downloadTimeoutMs: 90000 } }, { duration: type => (type === 'download' ? 88000 : undefined) });
  assert.ok(r.events.some(e => e.kind === 'probe_skipped' && e.details.reason === 'busy_deadline'));
  const times = r.saved.filter(m => m.type === 'icmp_burst').map(start);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] > 20000);
});

test('control probes never delay an app probe', async () => {
  const withControls = await simulate({ durationMs: 3 * 3600000, controls: true, mlab: true }, { duration: type => ({ control_gateway: 24900, control_icmp: 24900, control_tcp: 10900 })[type] });
  const without = await simulate({ durationMs: 3 * 3600000, controls: false, mlab: true });
  // At worst-case durations the lab probe gives up its slot; normally all run nearly every minute.
  assert.ok(count(withControls.controls, 'control_gateway') > 140, String(count(withControls.controls, 'control_gateway')));
  const typical = await simulate({ durationMs: 3 * 3600000, controls: true });
  for (const type of ['control_gateway', 'control_icmp', 'control_tcp'])
    assert.ok(count(typical.controls, type) > 160, `${type} ${count(typical.controls, type)}`);
  const starts = r => r.saved.map(m => [m.type, m.scheduledAt, Math.round(start(m) / 1500)]);
  assert.deepEqual(starts(withControls).map(x => x.slice(0, 2)), starts(without).map(x => x.slice(0, 2)));
  const late = r => Math.max(...r.saved.map(m => m.scheduling.latenessMs));
  assert.ok(late(withControls) - late(without) <= 1500, `${late(withControls)} vs ${late(without)}`);
});

test('a sleeping computer is recorded as a gap and its timing is rejected', async () => {
  let slept = false;
  const r = await simulate({ durationMs: 1500000 }, {
    after: (type, clock) => {
      if (type === 'icmp_burst' && !slept && clock.now() - T0 > 300000) {
        slept = true;
        clock.suspend(400000);
      }
    },
  });
  const bad = r.saved.filter(m => !m.scheduling.timingValid);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].success, false);
  assert.equal(bad[0].errorType, 'interrupted');
  assert.ok(r.events.some(e => e.kind === 'collector_gap'));
});

test('paired mode stays clear of the phone heavy tests', () => {
  for (const lag of [0, 5000, 45000, 200000, 400000, 3500000, 7000000]) {
    const p = pairedTimes(T0, T0 + lag);
    assert.ok(p.qualifiedAt >= T0 + lag);
    assert.equal((p.qualifiedAt - T0) % 60000, 30000);
    const phase = (p.transferAt - T0 - 300000) % 3600000;
    assert.ok(phase >= 150000 && phase <= 3450000, `lag ${lag} phase ${phase}`);
  }
  const prompt = pairedTimes(T0, T0 + 5000);
  assert.equal(prompt.mlabDueAt, T0 + 225000);
  assert.equal(prompt.transferAt, T0 + 450000);
});

test('ping output', () => {
  const parse = (name, stderr = '') => tools.parsePing({ stdout: name ? fixture(name) : '', stderr });
  assert.deepEqual(
    [parse('ping-linux-ok.txt').rttMs, parse('ping-linux-ok.txt').ttl, parse('ping-linux-ok.txt').replyBytes, parse('ping-linux-ok.txt').address],
    [23.4, 116, 72, '142.250.200.46'],
  );
  assert.equal(parse('ping-macos-ok.txt').rttMs, 0.446);
  for (const name of ['ping-linux-timeout.txt', 'ping-macos-timeout.txt']) {
    assert.equal(parse(name).errorType, 'timeout');
    assert.ok(parse(name).address);
  }
  assert.equal(parse('ping-linux-unreachable.txt').errorType, 'network');
  assert.equal(parse(null, 'ping: cannot resolve nosuch.invalid: Unknown host').errorType, 'network');
  assert.ok(tools.pingArgs('x', 'linux').includes('-4'));
  assert.equal(tools.pingArgs('x', 'linux')[tools.pingArgs('x', 'linux').indexOf('-W') + 1], '2');
  assert.equal(tools.pingArgs('x', 'darwin')[tools.pingArgs('x', 'darwin').indexOf('-W') + 1], '2000');
  assert.equal(tools.pingArgs('x', 'darwin')[tools.pingArgs('x', 'darwin').indexOf('-i') + 1], '0.1');
});

test('ICMP burst keeps partial loss and cancellation', async () => {
  const replies = ['ping-linux-ok.txt', 'ping-linux-timeout.txt'];
  let n = 0;
  const run = async () => ({ stdout: fixture(replies[n++ % 2]), stderr: '', stoppedBy: null, spawnError: null, durationMs: 1, argv: [] });
  const result = await tools.icmpBurst('google.com', { signal: new AbortController().signal, run, wait: async () => {} });
  assert.equal(result.fields.success, true);
  assert.equal(result.fields.details.nonResponsePercent, 50);
  assert.equal(result.fields.details.summary.successiveDifferenceMs, null);
  const abort = new AbortController();
  n = 0;
  const stopped = await tools.icmpBurst('google.com', {
    signal: abort.signal,
    run: async () => (n === 3 && abort.abort(), run()),
    wait: async () => {},
  });
  assert.equal(stopped.fields.errorType, 'cancelled');
  assert.equal(stopped.fields.details.complete, false);
  assert.equal(stopped.fields.details.nonResponsePercent, null);
  assert.equal(stopped.fields.details.samples.length, 4);
});

test('traceroute output on both platforms', () => {
  const linux = tools.parseTraceroute({ stdout: fixture('trace-linux.txt'), stderr: '' });
  assert.equal(linux.target, '142.250.200.46');
  assert.deepEqual(linux.samples.map(s => s.hop), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
  assert.deepEqual(linux.samples.filter(s => s.hop === 3).map(s => [s.address, s.kind]), [
    ['10.20.0.1', 'time_exceeded'], ['10.20.0.5', 'time_exceeded'], [null, 'timeout'],
  ]);
  assert.deepEqual(linux.samples.filter(s => s.hop === 4).map(s => s.kind), ['icmp_error', 'icmp_error', 'timeout']);
  assert.ok(linux.samples.filter(s => s.hop === 5).every(s => s.kind === 'port_unreachable'));
  const mac = tools.parseTraceroute({ stdout: fixture('trace-macos.txt'), stderr: fixture('trace-macos.stderr.txt') });
  assert.equal(mac.target, '142.250.200.46');
  assert.deepEqual(mac.samples.map(s => s.hop), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  assert.equal(mac.samples[7].address, '10.20.0.5');
});

test('traceroute timeout keeps partial hops', async () => {
  const run = async () => ({ stdout: fixture('trace-linux.txt').split('\n').slice(0, 4).join('\n'), stderr: '', stoppedBy: 'timeout', spawnError: null, durationMs: 45000, argv: [] });
  const { fields } = await tools.traceroute('google.com', { signal: new AbortController().signal, run });
  assert.equal(fields.success, false);
  assert.equal(fields.errorType, 'timeout');
  assert.equal(fields.route.samples.length, 9);
  assert.equal(fields.route.complete, false);
});

const curlJson = overrides => JSON.stringify({
  exitcode: 0, http_code: 200, http_version: '1.1', remote_ip: '203.0.113.5', size_download: 5000000, size_upload: 0, errormsg: null,
  time_namelookup: 0.01, time_connect: 0.05, time_appconnect: 0.1, time_pretransfer: 0.1, time_starttransfer: 0.2, time_total: 4, ...overrides,
});
test('TCP value is lookup plus handshake, and survives a later TLS failure', async () => {
  const run = async () => ({ stdout: curlJson({ exitcode: 35, http_code: 0 }), stderr: '', stoppedBy: null, durationMs: 900, argv: [] });
  const { fields } = await tools.tcpConnect('https://google.com', { signal: new AbortController().signal, timeoutMs: 10000, run });
  assert.equal(fields.success, true);
  assert.equal(fields.value, 50);
  assert.ok(Math.abs(fields.baseline.handshakeMs - 40) < 1e-9);
  const failed = await tools.tcpConnect('https://google.com', {
    signal: new AbortController().signal, timeoutMs: 10000,
    run: async () => ({ stdout: curlJson({ exitcode: 28, remote_ip: '', time_connect: 0 }), stderr: '', stoppedBy: null, durationMs: 10000, argv: [] }),
  });
  assert.equal(failed.fields.errorType, 'timeout');
  assert.equal(failed.fields.value, null);
});

test('transfers reject captive portals and keep partial bytes', async () => {
  const { writeFile } = await import('node:fs/promises');
  const go = (json, headers, stoppedBy = null, body = 'x') =>
    tools.transfer('download', 'https://probe.example', 5000000, 'id', {
      signal: new AbortController().signal, timeoutMs: 90000,
      run: async (_, args) => {
        await writeFile(args[args.indexOf('-D') + 1], headers);
        await writeFile(args[args.indexOf('-o') + 1], body);
        return { stdout: json, stderr: '', stoppedBy, durationMs: 4000, argv: [] };
      },
    });
  const good = 'HTTP/1.1 200 OK\r\nX-Capstone-Probe: 1\r\nX-Probe-Region: lab\r\n\r\n';
  const ok = (await go(curlJson(), good)).fields;
  assert.equal(ok.value, 10);
  assert.equal(ok.probeRegion, 'lab');
  assert.equal((await go(curlJson(), 'HTTP/1.1 200 OK\r\nServer: portal\r\n\r\n')).fields.errorType, 'invalid_response');
  const partial = (await go(curlJson({ exitcode: 28, size_download: 904960, errormsg: 'timed out' }), good)).fields;
  assert.equal(partial.errorType, 'timeout');
  assert.equal(partial.transferredBytes, 904960);
  assert.equal(partial.value, null);
});

test('NDT7 uses client bytes for download and receiver bytes for upload', async () => {
  const run = async () => ({ stdout: fixture('ndt7.jsonl'), stderr: '', stoppedBy: null, spawnError: null, durationMs: 21000, argv: [] });
  const { pair } = await tools.ndt7('v0.10.1', { signal: new AbortController().signal, timeoutMs: 60000, run });
  assert.deepEqual(pair.map(p => p.value), [100, 50]);
  assert.equal(pair[1].reference.serverCounterSource, 'tcp_info');
  const { pair: none } = await tools.ndt7('v', { signal: new AbortController().signal, timeoutMs: 1, run: async () => ({ stdout: '', stderr: '', stoppedBy: 'timeout', spawnError: null, durationMs: 1, argv: [] }) });
  assert.ok(none.every(p => !p.success && p.errorType === 'timeout'));
});

test('a missing tool is reported, not thrown', async () => {
  const r = await tools.exec('no-such-tool-xyz', []);
  assert.equal(r.spawnError, 'ENOENT');
});

test('settings', () => {
  assert.equal(duration('20m'), 1200000);
  assert.throws(() => duration('20'));
  assert.deepEqual(envValues('SECRET=x\nSKYMEASURE_PROBE_URL="https://a"\n', ['SKYMEASURE_PROBE_URL']), { SKYMEASURE_PROBE_URL: 'https://a' });
  assert.ok(['utun6', 'tun0', 'wg0', 'ppp0'].every(isTunnel));
  assert.ok(!['en0', 'wlan0', 'eth0', 'lo0'].some(isTunnel));
  const now = new Date(2026, 10, 23, 0, 2, 0);
  assert.equal(clockTime('23:59:30', now), new Date(2026, 10, 22, 23, 59, 30).getTime());
});

test('loss counts only answered or timed-out probes', () => {
  const m = (samples, extra = {}) => ({ type: 'icmp_burst', success: true, details: { samples, complete: true }, scheduling: { timingValid: true }, ...extra });
  const s = protocolSummary('icmp_burst', [
    m([{ sequence: 0, rttMs: 10, errorType: null }, { sequence: 1, rttMs: null, errorType: 'timeout' }, { sequence: 2, rttMs: null, errorType: 'cancelled' }]),
    m([{ sequence: 0, rttMs: 9999, errorType: null }], { scheduling: { timingValid: false } }),
  ]);
  assert.equal(s.lossPercent, 50);
  assert.equal(s.medianMs, 10);
  assert.equal(s.timingExcluded, 1);
  const [low, high] = wilson(0, 100);
  assert.ok(low === 0 && high > 3 && high < 4);
});

function session(id, offsetMs, rtt, { ip = '198.51.100.7', target = '142.250.200.46', phone = false } = {}) {
  const measurements = Array.from({ length: 30 }, (_, i) => {
    const at = new Date(T0 + offsetMs + i * 60000).toISOString();
    return {
      id: `${id}-${i}`, sessionId: id, type: 'icmp_burst', timestamp: at, success: true, value: rtt + (i % 3), unit: 'ms',
      method: phone ? 'icmp_echo_burst' : 'baseline_ping_burst', scheduling: { startedAt: at, timingValid: true, latenessMs: 0 },
      details: { complete: true, samples: [{ sequence: 0, timestamp: at, rttMs: rtt + (i % 3), errorType: null, ...(phone ? { packet: { resolvedAddress: target } } : { resolvedAddress: target }) }] },
    };
  });
  return { session: { id, config: { collectionMode: phone ? 'flight_auto' : 'linux_baseline' } }, measurements, events: [], snapshots: [{ id: `${id}-s`, publicIp: ip, asn: 5384 }] };
}
test('comparison pairs nearby bursts and reports phone minus baseline', () => {
  const r = compare([session('p', 0, 30, { phone: true })], [session('b', 30000, 25)], []);
  assert.equal(r.paired.icmp_burst.pairs, 30);
  assert.equal(r.paired.icmp_burst.medianDifferenceMs, 5);
  assert.equal(r.comparability.publicIp, 'match');
  assert.equal(r.comparability.asn, 'match');
  assert.equal(r.comparability.googleTargets, 'match');
});
test('comparison flags different networks, targets and missing overlap', () => {
  const r = compare(
    [session('p', 0, 30, { phone: true })],
    [session('b', 86400000, 25, { ip: '203.0.113.9', target: '142.250.1.1' })], [],
  );
  assert.equal(r.comparability.publicIp, 'mismatch');
  assert.equal(r.comparability.googleTargets, 'mismatch');
  assert.equal(r.comparability.overlapMinutes, 0);
  assert.equal(r.paired.icmp_burst.pairs, 0);
  assert.ok(r.flags.length >= 3);
});
test('a baseline file is not accepted as phone evidence', () => {
  assert.throws(() => loadSessions([session('b', 0, 1)], 'phone'));
  assert.throws(() => loadSessions([session('p', 0, 1, { phone: true })], 'baseline'));
});
test('raw baseline evidence is written with private directory and file permissions', async () => {
  const { mkdtemp, mkdir, chmod, stat, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'baseline-private-'));
  const outputDirectory = path.join(directory, 'run');
  try {
    await mkdir(outputDirectory, { mode: 0o755 });
    await chmod(outputDirectory, 0o755);
    const output = await createOutput(outputDirectory, { runId: 'test', config: {}, environment: {} });
    const raw = await output.saveRaw('a'.repeat(32), 'icmp_burst', [{ stdout: 'reference output' }]);
    await output.event('example', {});
    assert.equal((await stat(outputDirectory)).mode & 0o077, 0);
    assert.equal((await stat(path.join(outputDirectory, raw))).mode & 0o077, 0);
    assert.equal((await stat(path.join(outputDirectory, 'journal.jsonl'))).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});
test('a whole run folder loads, including its summary and controls, and renders', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'baseline-test-'));
  try {
    await writeFile(path.join(dir, 'segment-000.json'), JSON.stringify(session('b', 30000, 25)));
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ segments: 2 }));
    await writeFile(path.join(dir, 'control.json'), JSON.stringify({ measurements: [] }));
    const loaded = await readInputs([dir]);
    assert.equal(loaded.length, 1);
    const text = markdown(compare([session('p', 0, 30, { phone: true })], loaded, []));
    assert.ok(text.includes('| icmp_burst | 30 |'));
    assert.ok(!text.includes('undefined') && !text.includes('NaN'));
    assert.ok(!text.includes('198.51.100.7'));
    await assert.rejects(readInputs([path.join(dir, 'summary.json')]));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('router discovery on both platforms, and a silent router is not probed', async () => {
  assert.deepEqual(parseRoute('   route to: 142.250.1.1\n    gateway: 192.168.1.1\n  interface: en0\n'), { interface: 'en0', gateway: '192.168.1.1' });
  assert.deepEqual(parseRoute('142.250.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.5 uid 1000 \n    cache \n'), { interface: 'wlan0', gateway: '192.168.1.1' });
  assert.deepEqual(parseRoute('127.0.0.1 dev lo src 127.0.0.1 uid 1000 \n'), { interface: 'lo', gateway: null });
  assert.equal(parseRoute('    gateway: link#12\n  interface: en0\n').gateway, null);
  const r = await simulate({ durationMs: 1800000, controls: ['control_icmp', 'control_tcp'] });
  assert.equal(count(r.controls, 'control_gateway'), 0);
  assert.ok(count(r.controls, 'control_icmp') > 20);
});

for (const hours of [14,24]) test(`paper suite ${hours}h has no controlled transfers or catch-up duplication`, async () => {
  const r=await simulate({durationMs:hours*3600000,policy:PAPER_TRIP_POLICY});
  assert.equal(r.overlap,false);
  assert.equal(r.saved.some(m=>['download','upload'].includes(m.type)),false);
  assert.ok(r.saved.filter(m=>m.type==='cdn_fetch').length > 100);
  assert.equal(r.trip.transferPairs,0);
});

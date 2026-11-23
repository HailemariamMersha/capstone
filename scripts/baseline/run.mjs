#!/usr/bin/env node
/** Baseline runner. See docs/measurements/validation.md. Nothing is uploaded. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COLLECTOR_POLICY } from '../../src/trips/scheduler.ts';
import { HOURLY_TRANSFER_POLICY, PILOT_TRIP_POLICY, PROVIDERS } from '../../src/trips/model.ts';
import * as tools from './tools.mjs';
import { CONTROLS, DEFAULT_UPLOAD_PAUSE_MS, pairedTimes, realClock, runSchedule } from './schedule.mjs';
import { SUMMARY_SCHEMA, summarize } from './summary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOOGLE = 'google.com';
const VERSION = 'baseline-1';
const HELP = `Usage: npm run baseline:run -- [options]

  --duration 1h              how long to run (s, m or h)
  --check                    run the preflight checks only
  --phone-qualified-at TIME  paired mode: HH:MM:SS or ISO time the phone began collecting
  --accept-mlab              include one NDT7 pair. Publishes your public IP and results
                             to M-Lab and can use about 300 MiB.
  --upload-pause 22s         length of the simulated upload gap
  --no-control               skip the extra router and lab-server probes
  --pcap                     also capture probe packets with tcpdump (needs root)
  --probe-url, --udp-host, --udp-port, --env FILE, --out DIR
  --allow-vpn                testing only; results are marked not comparable`;

export function duration(text) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(text ?? '');
  if (!match) throw new Error(`Use a duration such as 90s, 20m or 1h (got ${text}).`);
  return Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
}
export function clockTime(text, now = new Date()) {
  const match = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/.exec(text);
  if (!match) {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) throw new Error('Use HH:MM:SS or an ISO time.');
    return at;
  }
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  // Just after midnight, a late-evening time means yesterday.
  if (at - now > 12 * 3600000) at.setDate(at.getDate() - 1);
  return at.getTime();
}
/** Reads only the named public keys; everything else in the file is ignored. */
export function envValues(text, keys) {
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && keys.includes(match[1])) found[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return found;
}
export const isTunnel = name => /^(utun|tun|tap|ppp|ipsec|wg|gpd|cscotun|tailscale|zt|nordlynx|proton)/i.test(name ?? '');

async function routeTo(address) {
  const darwin = process.platform === 'darwin';
  const result = darwin
    ? await tools.exec('route', ['-n', 'get', address], { timeoutMs: 5000 })
    : await tools.exec('ip', ['-4', 'route', 'get', address], { timeoutMs: 5000 });
  return parseRoute(result.stdout);
}
/** macOS `route get` and Linux `ip route get`. No gateway means the target is on-link. */
export function parseRoute(text) {
  return {
    interface: (/interface:\s*(\S+)/.exec(text) ?? /\bdev (\S+)/.exec(text))?.[1] ?? null,
    gateway: (/gateway:\s*([0-9.]+)\s/.exec(text) ?? /\bvia ([0-9.]+)\s/.exec(text))?.[1] ?? null,
  };
}
async function isWifi(name) {
  if (process.platform !== 'darwin') return existsSync(`/sys/class/net/${name}/wireless`);
  const { stdout } = await tools.exec('networksetup', ['-listallhardwareports'], { timeoutMs: 5000 });
  return new RegExp(`Hardware Port: Wi-Fi\\nDevice: ${name}\\n`).test(stdout);
}
async function firstLine(command, args) {
  const r = await tools.exec(command, args, { timeoutMs: 5000 });
  return r.spawnError ? null : (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 160);
}
async function clockState() {
  if (process.platform === 'darwin') {
    const r = await tools.exec('sntp', ['-t', '3', 'time.apple.com'], { timeoutMs: 6000 });
    const offset = /([+-]\d+\.\d+)\s+\+\/-/.exec(r.stdout)?.[1];
    return offset ? { source: 'sntp', offsetSeconds: Number(offset), ok: Math.abs(Number(offset)) < 1 } : { source: 'sntp', ok: null };
  }
  const r = await tools.exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeoutMs: 5000 });
  return { source: 'timedatectl', ok: r.spawnError ? null : r.stdout.trim() === 'yes' };
}

export async function preflight(settings) {
  const problems = [];
  const warnings = [];
  const versions = {
    ping: process.platform === 'darwin' ? `macOS ${os.release()} ping` : await firstLine('ping', ['-V']),
    traceroute: process.platform === 'darwin' ? `macOS ${os.release()} traceroute` : await firstLine('traceroute', ['--version']),
    curl: await firstLine('curl', ['--version']),
    python3: await firstLine('python3', ['--version']),
  };
  for (const tool of ['traceroute', 'curl', 'python3', 'ping'])
    if (!versions[tool]) problems.push(`${tool} is not installed.`);
  if (process.platform !== 'darwin') {
    if (versions.ping && !/iputils/i.test(versions.ping)) problems.push('ping must be the iputils version.');
    if (versions.traceroute && !/Modern traceroute/i.test(versions.traceroute))
      problems.push('traceroute must be the "Modern traceroute for Linux" package, not inetutils or busybox.');
  }
  if (settings.mlab) {
    const r = await tools.exec('ndt7-client', ['-h'], { timeoutMs: 5000 });
    if (r.spawnError)
      problems.push('ndt7-client is not installed: go install github.com/m-lab/ndt7-client-go/cmd/ndt7-client@v0.10.1');
    versions.ndt7 = process.env.NDT7_CLIENT_VERSION ?? 'unrecorded';
  }
  const probeHost = new URL(settings.probeUrl).hostname;
  const targets = {};
  const interfaces = new Set();
  for (const [name, host] of [['google', GOOGLE], ['probe', probeHost], ['udp', settings.udpHost]]) {
    const address = net.isIP(host) ? host : await dns.lookup(host, { family: 4 }).then(r => r.address, () => null);
    if (!address) {
      problems.push(`Cannot resolve ${name} target.`);
      continue;
    }
    const { interface: via, gateway } = await routeTo(address);
    targets[name] = { host, address, interface: via, gateway };
    if (via) interfaces.add(via);
    // Split tunnels can carry only some targets, so each one is checked.
    if (isTunnel(via))
      (settings.allowVpn ? warnings : problems).push(
        `A VPN or tunnel (${via}) carries the ${name} target. Turn it off: the app also refuses to measure over a VPN.`,
      );
  }
  const external = [...interfaces].filter(i => !/^lo/.test(i));
  if (external.length > 1) warnings.push(`Targets use different interfaces: ${external.join(', ')}.`);
  const wifi = external.length === 1 && (await isWifi(external[0]));
  if (!wifi) warnings.push('The route is not a single Wi-Fi interface, so it may differ from the phone.');
  // A router may ignore pings. Probing it anyway would use up the other controls' time.
  const gateway = targets.google?.gateway ?? null;
  let gatewayAnswers = false;
  if (settings.controls && gateway && !isTunnel(targets.google.interface))
    for (let i = 0; i < 3 && !gatewayAnswers; i++)
      gatewayAnswers = tools.parsePing(await tools.exec('ping', tools.pingArgs(gateway), { timeoutMs: 5000 })).rttMs !== null;
  if (settings.controls && !gatewayAnswers)
    warnings.push('The local router does not answer pings, so the router probe is off.');
  const clock = await clockState();
  if (clock.ok !== true)
    warnings.push(
      clock.ok === false ? 'The computer clock is not synchronised; matching with the phone will be unreliable.' : 'Clock synchronisation could not be checked.',
    );
  const context = await tools.fetchContext(settings.probeUrl, { timeoutMs: COLLECTOR_POLICY.identityTimeoutMs });
  const probe = await tools.probeRegion(settings.probeUrl, { timeoutMs: COLLECTOR_POLICY.identityTimeoutMs });
  if (!probe.ok) problems.push('The probe server did not answer as a SkyMeasure probe server.');
  if (!context.value) problems.push('The probe server did not return a valid /api/v1/context reply.');
  return {
    problems,
    warnings,
    environment: {
      platform: process.platform,
      release: os.release(),
      node: process.version,
      versions,
      targets,
      interface: external[0] ?? null,
      gateway,
      gatewayAnswers,
      wifi,
      clock,
      publicIp: context.value?.publicIp ?? null,
      asn: context.value?.asn ?? null,
      provider: PROVIDERS[context.value?.asn] ?? null,
      probeRegion: probe.region,
      vpnAllowed: settings.allowVpn,
    },
  };
}

/** Writes phone-shaped segments, plus an append-only journal in case of a crash. */
export async function createOutput(directory, { runId, config, environment }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(path.join(directory, 'raw'), { recursive: true, mode: 0o700 });
  const all = [];
  const controls = [];
  const pauses = [];
  let segment = null;
  let pending = [];
  let snapshot = null;
  const journal = row => appendFile(path.join(directory, 'journal.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const writeJson = async (name, value) => {
    const file = path.join(directory, name);
    await writeFile(`${file}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  const id = () => randomBytes(16).toString('hex');
  const event = (kind, details) => ({ id: id(), timestamp: new Date().toISOString(), kind, details });
  const attachSnapshot = () => {
    if (segment && snapshot && !segment.snapshots.some(s => s.id === snapshot.id)) segment.snapshots.push(snapshot);
  };
  return {
    newId: id,
    all,
    controls,
    get snapshot() {
      return snapshot;
    },
    get sessionId() {
      return segment?.session.id;
    },
    setContext(value) {
      snapshot = {
        id: id(),
        timestamp: new Date().toISOString(),
        type: environment.wifi ? 'wifi' : 'other',
        isConnected: true,
        ssid: null,
        bssid: null,
        publicIp: value.publicIp ?? null,
        asn: value.asn ?? null,
        publicIpObservedAt: new Date().toISOString(),
        batteryPercent: null,
        isCharging: null,
        isInternetReachable: true,
        popCode: value.popCode ?? null,
        reverseDns: value.reverseDns ?? null,
      };
      attachSnapshot();
    },
    async openSegment(index) {
      const at = new Date().toISOString();
      segment = {
        schemaVersion: 3,
        session: {
          id: id(),
          state: 'active',
          startedAt: at,
          endedAt: null,
          lastObservedAt: at,
          resumedFromId: null,
          config: { ...config, segmentIndex: index },
          measurementCount: 0,
        },
        measurements: [],
        events: pending,
        snapshots: [],
      };
      pending = [];
      attachSnapshot();
    },
    async event(kind, details) {
      const row = event(kind, details);
      if (kind === 'upload_pause') pauses.push(details);
      (segment ? segment.events : pending).push(row);
      await journal({ event: row });
    },
    async save(measurement, isControl) {
      if (isControl) controls.push(measurement);
      else {
        all.push(measurement);
        segment.measurements.push(measurement);
        attachSnapshot();
      }
      await journal({ measurement, control: isControl });
    },
    async saveRaw(measurementId, type, runs) {
      const file = `raw/${measurementId}.json`;
      await writeFile(path.join(directory, file), JSON.stringify({ type, runs }, null, 1), { mode: 0o600 });
      return file;
    },
    async closeSegment(reason) {
      if (!segment) return;
      const at = new Date().toISOString();
      segment.session.state = 'completed';
      segment.session.endedAt = segment.session.lastObservedAt = at;
      segment.session.measurementCount = segment.measurements.length;
      segment.events.push(event('session_ended', { reason }));
      const name = `segment-${String(segment.session.config.segmentIndex).padStart(3, '0')}.json`;
      await writeJson(name, segment);
      segment = null;
      await writeJson('control.json', { runId, note: 'Extra router and lab-server probes; the app does not run these.', measurements: controls });
    },
    async finish(trip) {
      // Events after the last close (an interrupted gap) would otherwise be lost.
      if (pending.length) await writeJson('trailing-events.json', pending);
      await writeJson('summary.json', {
        schema: SUMMARY_SCHEMA,
        source: 'baseline',
        runId,
        startedAt: new Date(trip.startedAt).toISOString(),
        endedAt: new Date(trip.endedAt).toISOString(),
        reason: trip.reason,
        segments: trip.segmentCount,
        uploadPauses: pauses.length,
        transferPairs: trip.transferPairs,
        mlab: trip.mlab?.status ?? 'not_requested',
        config,
        environment,
        measurements: all.length,
        failures: all.filter(m => m.success === false).length,
        protocols: summarize(all),
        controls: summarize(controls),
      });
    },
  };
}

export function createRunner(settings, output, versions) {
  return async (type, { timeoutMs, signal }) => {
    const id = output.newId();
    const sessionId = output.sessionId;
    const networkSnapshot = output.snapshot;
    const probe = {
      icmp_burst: () => tools.icmpBurst(GOOGLE, { signal }),
      udp_echo: () => tools.udpEcho(settings.udpHost, settings.udpPort, id, { signal }),
      tcp_connect: () => tools.tcpConnect(`https://${GOOGLE}`, { signal, timeoutMs }),
      traceroute: () => tools.traceroute(GOOGLE, { signal }),
      download: () => tools.transfer('download', settings.probeUrl, PILOT_TRIP_POLICY.downloadBytes, id, { signal, timeoutMs }),
      upload: () => tools.transfer('upload', settings.probeUrl, PILOT_TRIP_POLICY.uploadBytes, id, { signal, timeoutMs }),
      ndt7_download: () => tools.ndt7(versions.ndt7, { signal, timeoutMs }),
      control_gateway: () => tools.icmpBurst(settings.gateway, { signal }),
      control_icmp: () => tools.icmpBurst(settings.udpHost, { signal }),
      control_tcp: () => tools.tcpConnect(settings.probeUrl, { signal, timeoutMs }),
    }[type];
    const methods = {
      icmp_burst: 'baseline_ping_burst',
      udp_echo: 'baseline_udp_echo_python',
      tcp_connect: 'baseline_curl_tcp_connect',
      traceroute: 'baseline_udp_traceroute',
      download: 'baseline_curl_download',
      upload: 'baseline_curl_upload',
      ndt7_download: 'baseline_ndt7_client',
      control_gateway: 'baseline_ping_burst',
      control_icmp: 'baseline_ping_burst',
      control_tcp: 'baseline_curl_tcp_connect',
    };
    const toolName = { icmp_burst: 'ping', control_icmp: 'ping', control_gateway: 'ping', udp_echo: 'python3', traceroute: 'traceroute', ndt7_download: 'ndt7' }[type] ?? 'curl';
    const result = await probe();
    const outputFile = await output.saveRaw(id, type, result.runs);
    const finishRow = (fields, rowId) => ({
      id: rowId,
      sessionId,
      type,
      errorMessage: null,
      httpStatus: null,
      probeServer: fields.targetHost ?? '',
      probeRegion: null,
      networkSnapshot,
      method: methods[type],
      ...fields,
      raw: {
        library: toolName,
        version: versions[toolName] ?? 'unrecorded',
        source: 'terminal_tool_output',
        request: { argv: result.runs[0]?.argv ?? [], commands: result.runs.length, outputFile },
        callbacks: [],
        unavailable: ['clientIpPacketCapture', 'hardwareTransmitTimestamp'],
      },
      state: 'completed',
    });
    if (result.pair) return result.pair.map((fields, i) => finishRow(fields, i ? output.newId() : id));
    return finishRow({ ...result.fields, type }, id);
  };
}

function background(command, args) {
  const child = spawn(command, args, { stdio: 'ignore' });
  const state = { failed: false };
  child.on('error', () => (state.failed = true));
  child.on('exit', code => {
    if (code) state.failed = true;
  });
  return { state, stop: () => child.kill('SIGINT') };
}

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      check: { type: 'boolean' },
      duration: { type: 'string', default: '1h' },
      'upload-pause': { type: 'string', default: `${DEFAULT_UPLOAD_PAUSE_MS / 1000}s` },
      'phone-qualified-at': { type: 'string' },
      'accept-mlab': { type: 'boolean', default: false },
      'no-control': { type: 'boolean', default: false },
      'allow-vpn': { type: 'boolean', default: false },
      pcap: { type: 'boolean', default: false },
      'probe-url': { type: 'string' },
      'udp-host': { type: 'string' },
      'udp-port': { type: 'string' },
      env: { type: 'string', default: path.join(root, '.env.skymeasure.local') },
      out: { type: 'string' },
    },
  });
  if (values.help) return console.log(HELP);
  const publicConfig = JSON.parse(await readFile(path.join(root, 'src/config/public.json'), 'utf8'));
  const env = envValues(await readFile(values.env, 'utf8').catch(() => ''), ['SKYMEASURE_PROBE_URL', 'SKYMEASURE_UDP_IPV4']);
  const settings = {
    probeUrl: (values['probe-url'] ?? env.SKYMEASURE_PROBE_URL ?? '').replace(/\/$/, ''),
    udpHost: values['udp-host'] ?? env.SKYMEASURE_UDP_IPV4,
    udpPort: Number(values['udp-port'] ?? publicConfig.udpPort),
    mlab: values['accept-mlab'],
    allowVpn: values['allow-vpn'],
    controls: !values['no-control'],
  };
  if (!settings.probeUrl || net.isIPv4(settings.udpHost ?? '') === false)
    throw new Error('Set SKYMEASURE_PROBE_URL and SKYMEASURE_UDP_IPV4 in .env.skymeasure.local, or pass --probe-url and --udp-host.');
  const durationMs = duration(values.duration);
  const uploadPauseMs = duration(values['upload-pause']);
  const phoneAt = values['phone-qualified-at'] ? clockTime(values['phone-qualified-at']) : null;

  console.log('Checking network and tools...');
  const { problems, warnings, environment } = await preflight(settings);
  for (const text of warnings) console.log(`  warning: ${text}`);
  for (const text of problems) console.log(`  problem: ${text}`);
  if (problems.length) {
    process.exitCode = 1;
    return console.log('Not started. Fix the problems above and try again.');
  }
  console.log(`  ok: ${environment.interface ?? 'local'}, AS${environment.asn ?? 'unknown'}, probe region ${environment.probeRegion}`);
  if (values.check) return;

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const directory = path.resolve(values.out ?? path.join(root, 'build/baseline', runId));
  if (existsSync(path.join(directory, 'summary.json')) || existsSync(path.join(directory, 'journal.jsonl')))
    throw new Error(`Output already exists: ${directory}`);
  const now = Date.now();
  const paired = phoneAt === null ? undefined : pairedTimes(phoneAt, now);
  const config = {
    collectionMode: 'linux_baseline',
    collectorVersion: VERSION,
    collectorPolicy: COLLECTOR_POLICY,
    flightPolicy: PILOT_TRIP_POLICY,
    transferSchedule: HOURLY_TRANSFER_POLICY,
    tripId: `baseline-${runId}`,
    groundTest: true,
    durationMs,
    uploadPauseMs,
    uploadSimulation: 'pause_only',
    controls: settings.controls
      ? Object.keys(CONTROLS).filter(type => type !== 'control_gateway' || environment.gatewayAnswers)
      : [],
    pairing: paired ? { phoneQualifiedAt: new Date(phoneAt).toISOString(), ...paired } : null,
    icmpHost: GOOGLE,
    tcpServerUrl: `https://${GOOGLE}`,
    tracerouteHost: GOOGLE,
    tracerouteMaxHops: tools.TRACE.maxHops,
    serverUrl: settings.probeUrl,
    udpHost: settings.udpHost,
    udpPort: settings.udpPort,
    probeRegion: environment.probeRegion,
  };
  const output = await createOutput(directory, { runId, config, environment });
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ runId, config, environment, warnings }, null, 1));
  settings.gateway = environment.gateway;
  const run = createRunner(settings, output, environment.versions);

  const helpers = [];
  helpers.push(
    process.platform === 'darwin'
      ? background('caffeinate', ['-i', '-w', String(process.pid)])
      : background('systemd-inhibit', ['--what=sleep:idle', '--who=skymeasure-baseline', '--why=Network baseline', 'sleep', String(Math.ceil(durationMs / 1000) + 600)]),
  );
  if (values.pcap) {
    // Includes other traffic matching this protocol filter, notably all ICMP.
    // Keep captures private and use a researcher-controlled reference computer.
    const capture = background('tcpdump', [
      '-i', environment.interface ?? 'any', '-s', '200', '-U', '-w', path.join(directory, 'probes.pcap'),
      `icmp or (udp and host ${settings.udpHost}) or (udp and dst portrange 33434-33534)`,
    ]);
    helpers.push(capture);
    await realClock.wait(1500);
    if (capture.state.failed) console.log('  warning: tcpdump could not start (run with sudo). Continuing without a capture.');
  }

  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'])
    process.once(name, () => {
      console.log('\nStopping and saving...');
      stop.abort();
    });
  console.log(`Running for ${values.duration}${paired ? ', paired with the phone' : ''}. Output: ${directory}`);
  const describe = m =>
    m.success ? `${m.value.toFixed(m.unit === 'hops' ? 0 : 1)} ${m.unit}` : `failed (${m.errorType})`;
  try {
    const trip = await runSchedule(
      {
        clock: realClock,
        run,
        identity: async ({ timeoutMs, signal }) => {
          const { value } = await tools.fetchContext(settings.probeUrl, { timeoutMs, signal });
          await output.event('baseline_identity', { received: !!value, asn: value?.asn ?? null });
          if (value) output.setContext(value);
          return !!value;
        },
        sink: {
          openSegment: output.openSegment,
          closeSegment: output.closeSegment,
          event: async (kind, details) => {
            if (kind === 'upload_pause') console.log(`${new Date().toLocaleTimeString()}  upload gap  ${(details.durationMs / 1000).toFixed(1)} s`);
            await output.event(kind, details);
          },
          save: async (m, isControl) => {
            console.log(`${new Date().toLocaleTimeString()}  ${m.type.padEnd(14)} ${describe(m)}`);
            await output.save(m, isControl);
          },
        },
      },
      { durationMs, uploadPauseMs, mlab: settings.mlab, controls: config.controls, paired, signal: stop.signal },
    );
    await output.finish(trip);
    console.log(`Finished (${trip.reason}). Summary: ${path.join(directory, 'summary.json')}`);
  } finally {
    for (const helper of helpers) helper.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });

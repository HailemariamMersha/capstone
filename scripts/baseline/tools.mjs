/** Standard terminal tools and their output parsers. Linux (iputils) and macOS. */
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import {
  PAPER_REGISTRY,
  PAPER_CDN_LIMIT,
  PAPER_DNS_LIMIT,
} from '../../src/measurements/paperSuite.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latencySummary } from '../../src/measurements/statistics.ts';
import {
  ICMP_SAMPLE_COUNT,
  SAMPLE_INTERVAL_MS,
  UDP_PACKET_BYTES,
  UDP_SAMPLE_COUNT,
} from '../../src/measurements/diagnosticConfig.ts';
import {
  PROBE_API_PATH,
  PROBE_PROTOCOL_HEADER,
  PROBE_PROTOCOL_VERSION,
} from '../../src/api/probeProtocol.ts';
import { realClock } from './schedule.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT = 8 * 1024 * 1024;
export const TRACE = {
  maxHops: 20,
  perHop: 3,
  port: 33434,
  packetBytes: 60,
  deadlineMs: 45000,
};
export const ICMP_TIMEOUT_MS = 2000;

/** Runs one tool. Never rejects: failures are part of the evidence. */
export function exec(command, args, { signal, timeoutMs, input } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let stoppedBy = null;
    let spawnError = null;
    let killTimer;
    if (signal?.aborted)
      return resolve({
        code: null,
        stdout,
        stderr,
        stoppedBy: 'cancelled',
        spawnError,
        startedAt,
        durationMs: 0,
        argv: [command, ...args],
      });
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Parsers need untranslated output; proxies would change the measured path.
      env: {
        PATH: `${process.env.PATH ?? ''}:/usr/sbin:/sbin`,
        HOME: process.env.HOME ?? '',
        LC_ALL: 'C',
      },
    });
    const kill = reason => {
      stoppedBy ??= reason;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const cancel = () => kill('cancelled');
    signal?.addEventListener('abort', cancel);
    const timer = timeoutMs
      ? setTimeout(() => kill('timeout'), timeoutMs)
      : undefined;
    child.stdout.on('data', d => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.on('data', d => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => {
      spawnError = error.code ?? String(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      resolve({
        code,
        stdout,
        stderr,
        stoppedBy,
        spawnError,
        startedAt,
        durationMs: performance.now() - started,
        argv: [command, ...args],
      });
    });
  });
}

// ---- ping -----------------------------------------------------------------

export function pingArgs(host, platform = process.platform) {
  return platform === 'darwin'
    ? // macOS adds the send interval (1 s by default) to the wait, so a lost echo would
      // take 3 s instead of the app's 2 s. 0.1 s is the shortest interval without root.
      [
        '-n',
        '-c',
        '1',
        '-i',
        '0.1',
        '-s',
        '64',
        '-m',
        '64',
        '-W',
        String(ICMP_TIMEOUT_MS),
        host,
      ]
    : [
        '-4',
        '-n',
        '-c',
        '1',
        '-s',
        '64',
        '-t',
        '64',
        '-W',
        String(ICMP_TIMEOUT_MS / 1000),
        host,
      ];
}
export function parsePing({ stdout, stderr }) {
  const address =
    /^PING\s+\S+\s+\((?:[^()\s]*\()?([0-9.]+)\)/m.exec(stdout)?.[1] ?? null;
  const reply =
    /^(\d+) bytes from (?:\S+ \()?([0-9.]+)\)?: icmp_seq=\d+ ttl=(\d+) time=([0-9.]+) ms/m.exec(
      stdout,
    );
  if (reply)
    return {
      address: address ?? reply[2],
      replyFrom: reply[2],
      replyBytes: Number(reply[1]),
      ttl: Number(reply[3]),
      rttMs: Number(reply[4]),
      errorType: null,
      errorMessage: null,
    };
  const problem =
    stderr.trim() || /^.*[Uu]nreachable.*$/m.exec(stdout)?.[0] || '';
  const sent = /1 packets transmitted/.test(stdout);
  const timeout = sent && !problem;
  return {
    address,
    replyFrom: null,
    replyBytes: null,
    ttl: null,
    rttMs: null,
    errorType: timeout ? 'timeout' : 'network',
    errorMessage: timeout
      ? null
      : problem.slice(0, 300) || 'No usable ping output.',
  };
}

export async function icmpBurst(
  host,
  { signal, run = exec, wait = realClock.wait },
) {
  const started = performance.now();
  const samples = [];
  const runs = [];
  for (
    let sequence = 0;
    sequence < ICMP_SAMPLE_COUNT && !signal.aborted;
    sequence++
  ) {
    const timestamp = new Date().toISOString();
    const outcome = await run('ping', pingArgs(host), {
      signal,
      timeoutMs: ICMP_TIMEOUT_MS + 3000,
    });
    runs.push(outcome);
    const parsed = parsePing(outcome);
    const cancelled =
      outcome.stoppedBy === 'cancelled' && parsed.rttMs === null;
    const errorType = cancelled
      ? 'cancelled'
      : outcome.spawnError
      ? 'network'
      : outcome.stoppedBy === 'timeout' && parsed.rttMs === null
      ? // Our own limit, e.g. slow DNS: no completed echo attempt to classify as loss.
        'network'
      : parsed.errorType;
    samples.push({
      sequence,
      timestamp,
      rttMs: parsed.rttMs,
      errorType,
      ttl: parsed.ttl,
      durationMs: outcome.durationMs,
      errorMessage: outcome.spawnError ?? parsed.errorMessage,
      resolvedAddress: parsed.address,
    });
    if (sequence + 1 < ICMP_SAMPLE_COUNT)
      await wait(SAMPLE_INTERVAL_MS, signal);
  }
  const summary = latencySummary(samples);
  const complete = !signal.aborted && samples.length === ICMP_SAMPLE_COUNT;
  const valid = samples.every(
    s => s.errorType === null || s.errorType === 'timeout',
  );
  const success = complete && valid && summary.replies > 0;
  return {
    runs,
    fields: {
      timestamp: samples[0]?.timestamp,
      durationMs: performance.now() - started,
      value: success ? summary.medianMs : null,
      unit: 'ms',
      success,
      errorType: signal.aborted
        ? 'cancelled'
        : success
        ? null
        : valid
        ? 'timeout'
        : 'network',
      errorMessage: success ? null : 'ICMP burst incomplete or unavailable.',
      requestedBytes: ICMP_SAMPLE_COUNT * 64 * 2,
      transferredBytes: null,
      targetHost: host,
      details: {
        protocolVersion: 1,
        samples,
        summary,
        requestedCount: ICMP_SAMPLE_COUNT,
        complete,
        nonResponsePercent:
          complete && valid
            ? (100 * (ICMP_SAMPLE_COUNT - summary.replies)) / ICMP_SAMPLE_COUNT
            : null,
      },
    },
  };
}

// ---- UDP echo -------------------------------------------------------------

export async function udpEcho(host, port, nonce, { signal, run = exec }) {
  const timestamp = new Date().toISOString();
  const outcome = await run(
    'python3',
    [
      path.join(here, 'udp_burst.py'),
      '--host',
      host,
      '--port',
      String(port),
      '--nonce',
      nonce,
    ],
    { signal, timeoutMs: 15000 },
  );
  let value = null;
  try {
    value = JSON.parse(outcome.stdout);
  } catch {
    /* Reported below; raw output is retained. */
  }
  const cancelled = signal.aborted || value?.cancelled === true;
  const errorType = cancelled
    ? 'cancelled'
    : !value
    ? 'invalid_response'
    : value.error
    ? 'network'
    : null;
  const samples = (value?.samples ?? []).map(s => ({
    ...s,
    errorType: s.rttMs === null ? errorType ?? 'timeout' : null,
  }));
  const summary = latencySummary(samples);
  const sentCount = value?.sentCount ?? 0;
  const complete = errorType === null && sentCount === UDP_SAMPLE_COUNT;
  const success = complete && summary.replies > 0;
  return {
    runs: [outcome],
    fields: {
      timestamp,
      durationMs: value?.durationMs ?? outcome.durationMs,
      value: success ? summary.medianMs : null,
      unit: 'ms',
      success,
      errorType: errorType ?? (success ? null : 'timeout'),
      errorMessage: success
        ? null
        : value?.error ?? outcome.stderr.slice(0, 300) ?? null,
      requestedBytes: UDP_SAMPLE_COUNT * UDP_PACKET_BYTES * 2,
      transferredBytes: null,
      targetHost: host,
      details: {
        protocolVersion: 1,
        samples,
        summary,
        requestedCount: UDP_SAMPLE_COUNT,
        sentCount,
        complete,
        duplicateCount: value?.duplicateCount ?? 0,
        reorderedCount: value?.reorderedCount ?? 0,
        targetPort: port,
        lossPercent: complete
          ? (100 * (sentCount - summary.replies)) / sentCount
          : null,
      },
    },
  };
}

// ---- curl -----------------------------------------------------------------

// -q must be first: a user's ~/.curlrc must not change a measurement.
const CURL = ['-q', '-4', '-sS', '--noproxy', '*', '--http1.1'];
const curlError = code =>
  code === 28
    ? 'timeout'
    : [6, 7, 35, 52, 55, 56].includes(code)
    ? 'network'
    : 'invalid_response';

/** curl -w '%{json}' is the last line of stdout when the body goes elsewhere. */
export function parseCurl(stdout) {
  try {
    const v = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1));
    const ms = key => (typeof v[key] === 'number' ? v[key] * 1000 : null);
    return {
      exitCode: v.exitcode,
      httpStatus: v.http_code || null,
      httpVersion: v.http_version || null,
      remoteAddress: v.remote_ip || null,
      downloadedBytes: v.size_download ?? null,
      uploadedBytes: v.size_upload ?? null,
      errorMessage: v.errormsg ?? null,
      phasesMs: {
        dns: ms('time_namelookup'),
        connect: ms('time_connect'),
        tls: ms('time_appconnect'),
        requestSent: ms('time_pretransfer'),
        firstByte: ms('time_starttransfer'),
        total: ms('time_total'),
      },
    };
  } catch {
    return null;
  }
}

export async function tcpConnect(url, { signal, timeoutMs, run = exec }) {
  const target = new URL(url);
  const timestamp = new Date().toISOString();
  const seconds = String(timeoutMs / 1000);
  // curl has no connect-only mode, so it also sends one HEAD request. time_connect is
  // recorded when the TCP handshake completes, before TLS, so that does not affect it.
  const outcome = await run(
    'curl',
    [
      ...CURL,
      '-I',
      '-o',
      os.devNull,
      '--connect-timeout',
      seconds,
      '--max-time',
      seconds,
      '-w',
      '%{json}',
      url,
    ],
    { signal, timeoutMs: timeoutMs + 1500 },
  );
  const parsed = parseCurl(outcome.stdout);
  const connect = parsed?.phasesMs.connect;
  // A later TLS or HTTP failure does not undo a completed TCP handshake.
  const success = !!parsed?.remoteAddress && connect > 0;
  const errorType = success
    ? null
    : outcome.stoppedBy === 'cancelled'
    ? 'cancelled'
    : outcome.stoppedBy === 'timeout' || parsed?.exitCode === 28
    ? 'timeout'
    : 'network';
  const value = success ? connect : null;
  const samples = [{ sequence: 0, timestamp, rttMs: value, errorType }];
  return {
    runs: [outcome],
    resolvedAddress: parsed?.remoteAddress ?? null,
    fields: {
      timestamp,
      durationMs: success ? connect : outcome.durationMs,
      value,
      unit: 'ms',
      success,
      errorType,
      errorMessage: success ? null : parsed?.errorMessage ?? outcome.spawnError,
      requestedBytes: 0,
      transferredBytes: 0,
      targetHost: target.hostname,
      baseline: {
        resolvedAddress: parsed?.remoteAddress ?? null,
        // Comparable with the app's value: name lookup plus handshake.
        resolutionMs: success ? parsed.phasesMs.dns : null,
        // Handshake only; the app cannot separate this.
        handshakeMs: success ? connect - parsed.phasesMs.dns : null,
      },
      details: {
        protocolVersion: 1,
        samples,
        summary: latencySummary(samples),
        targetPort: Number(
          target.port || (target.protocol === 'https:' ? 443 : 80),
        ),
      },
    },
  };
}

export function parseHeaders(text) {
  // Last block wins: earlier blocks are interim (1xx) responses.
  const block =
    text
      .trim()
      .split(/\r?\n\r?\n/)
      .pop() ?? '';
  return Object.fromEntries(
    block
      .split(/\r?\n/)
      .slice(1)
      .map(line => [
        line.slice(0, line.indexOf(':')).trim().toLowerCase(),
        line.slice(line.indexOf(':') + 1).trim(),
      ]),
  );
}

export async function transfer(
  type,
  serverUrl,
  bytes,
  requestId,
  { signal, timeoutMs, run = exec },
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'skymeasure-baseline-'),
  );
  const headerFile = path.join(directory, 'headers');
  const bodyFile = path.join(directory, 'body');
  const payloadFile = path.join(directory, 'payload');
  try {
    const upload = type === 'upload';
    if (upload)
      // Prepared before timing, as in the app. Base64 text is ASCII and incompressible enough.
      await writeFile(
        payloadFile,
        randomBytes(bytes).toString('base64').slice(0, bytes),
      );
    const timestamp = new Date().toISOString();
    const url = `${serverUrl}${PROBE_API_PATH}/${
      upload ? 'upload' : `download/${bytes}`
    }?request=${requestId}`;
    const outcome = await run(
      'curl',
      [
        ...CURL,
        '--connect-timeout',
        '10',
        '--max-time',
        String(timeoutMs / 1000),
        // RNFS gives up after 30 s without data.
        ...(upload ? [] : ['--speed-limit', '1', '--speed-time', '30']),
        '-H',
        'Connection: close',
        '-H',
        'Cache-Control: no-cache',
        ...(upload
          ? [
              '-H',
              'Content-Type: application/octet-stream',
              '-H',
              'Expect:',
              '--data-binary',
              `@${payloadFile}`,
            ]
          : ['-H', 'Accept-Encoding: identity']),
        '-D',
        headerFile,
        '-o',
        bodyFile,
        '-w',
        '%{json}',
        url,
      ],
      { signal, timeoutMs: timeoutMs + 1500 },
    );
    const parsed = parseCurl(outcome.stdout);
    const headers = parseHeaders(
      await readFile(headerFile, 'utf8').catch(() => ''),
    );
    let errorType = null;
    let errorMessage = null;
    const fail = (kind, message) => {
      if (!errorType) [errorType, errorMessage] = [kind, message];
    };
    if (outcome.stoppedBy === 'cancelled')
      fail('cancelled', 'Transfer cancelled.');
    else if (outcome.stoppedBy === 'timeout')
      fail('timeout', `Transfer exceeded ${timeoutMs} ms.`);
    else if (!parsed)
      fail(
        'network',
        outcome.spawnError ??
          (outcome.stderr.slice(0, 300) || 'No curl result.'),
      );
    else if (parsed.exitCode !== 0)
      fail(curlError(parsed.exitCode), parsed.errorMessage);
    else if (parsed.httpStatus < 200 || parsed.httpStatus >= 300)
      fail('http', `Probe server returned HTTP ${parsed.httpStatus}.`);
    else if (
      headers[PROBE_PROTOCOL_HEADER.toLowerCase()] !== PROBE_PROTOCOL_VERSION
    )
      fail(
        'invalid_response',
        'Response is not from the expected probe server.',
      );
    else if (
      headers['content-encoding'] &&
      headers['content-encoding'] !== 'identity'
    )
      fail(
        'invalid_response',
        'Compressed responses are not valid throughput payloads.',
      );
    else if (upload) {
      let received = null;
      try {
        received = JSON.parse(await readFile(bodyFile, 'utf8')).receivedBytes;
      } catch {
        /* Falls through to the mismatch below. */
      }
      if (received !== bytes)
        fail(
          'invalid_response',
          'Server did not acknowledge the complete upload.',
        );
    } else if (parsed.downloadedBytes !== bytes)
      fail('invalid_response', 'Download size differs from the request.');
    const success = errorType === null;
    const durationMs = parsed?.phasesMs.total || outcome.durationMs;
    const observedBytes = upload
      ? success
        ? bytes
        : null
      : parsed?.downloadedBytes ?? null;
    return {
      runs: [outcome],
      fields: {
        timestamp,
        durationMs,
        value: success ? (bytes * 8) / (durationMs * 1000) : null,
        unit: 'Mbps',
        success,
        errorType,
        errorMessage,
        httpStatus: parsed?.httpStatus ?? null,
        requestedBytes: bytes,
        transferredBytes: observedBytes,
        probeServer: serverUrl,
        probeRegion: headers['x-probe-region'] ?? null,
        targetHost: new URL(serverUrl).hostname,
        baseline: {
          resolvedAddress: parsed?.remoteAddress ?? null,
          httpVersion: parsed?.httpVersion ?? null,
          phasesMs: parsed?.phasesMs ?? null,
        },
        transfer: {
          stage: success ? 'completed' : 'failed',
          observedBytes,
          bytesScope: upload
            ? success
              ? 'server_acknowledged_payload'
              : 'unavailable'
            : 'download_file_written',
          timeoutMs,
          // For uploads curl's first-byte time is not the response header time.
          ...(!upload && parsed?.phasesMs.firstByte
            ? { headersAfterMs: parsed.phasesMs.firstByte }
            : {}),
          wallDurationMs: outcome.durationMs,
        },
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function fetchContext(
  serverUrl,
  { signal, timeoutMs, run = exec },
) {
  const outcome = await run(
    'curl',
    [
      ...CURL,
      '--max-time',
      String(timeoutMs / 1000),
      '-H',
      'Cache-Control: no-cache',
      '-H',
      'Connection: close',
      '-i',
      `${serverUrl}/api/v1/context`,
    ],
    { signal, timeoutMs: timeoutMs + 1000 },
  );
  const split = outcome.stdout.search(/\r?\n\r?\n/);
  if (outcome.code !== 0 || split < 0) return { outcome, value: null };
  const headers = parseHeaders(outcome.stdout.slice(0, split));
  try {
    const value = JSON.parse(outcome.stdout.slice(split).trim());
    const ok =
      headers[PROBE_PROTOCOL_HEADER.toLowerCase()] === PROBE_PROTOCOL_VERSION;
    return { outcome, value: ok ? value : null };
  } catch {
    return { outcome, value: null };
  }
}

/** The region label is on probe responses, not on the context reply. */
export async function probeRegion(serverUrl, { timeoutMs, run = exec }) {
  const outcome = await run(
    'curl',
    [
      ...CURL,
      '--max-time',
      String(timeoutMs / 1000),
      '-i',
      `${serverUrl}${PROBE_API_PATH}/ping`,
    ],
    { timeoutMs: timeoutMs + 1000 },
  );
  const headers = parseHeaders(outcome.stdout.split(/\r?\n\r?\n/)[0]);
  return {
    ok:
      outcome.code === 0 &&
      headers[PROBE_PROTOCOL_HEADER.toLowerCase()] === PROBE_PROTOCOL_VERSION,
    region: headers['x-probe-region'] ?? null,
  };
}

// ---- traceroute -----------------------------------------------------------

export function tracerouteArgs(host, platform = process.platform) {
  return [
    ...(platform === 'darwin' ? [] : ['-4', '-N', '1']),
    '-n',
    '-m',
    String(TRACE.maxHops),
    '-q',
    String(TRACE.perHop),
    '-w',
    '1',
    '-p',
    String(TRACE.port),
    host,
    String(TRACE.packetBytes),
  ];
}

/**
 * macOS prints the header on stderr and continues a hop with a new router on an
 * indented line; Linux prints the header on stdout and keeps each hop on one line.
 */
export function parseTraceroute({ stdout, stderr }) {
  const target =
    /^traceroute to \S+ \(([0-9.]+)\)/m.exec(`${stderr}\n${stdout}`)?.[1] ??
    null;
  const samples = [];
  let hop = 0;
  let address = null;
  for (const line of stdout.split(/\r?\n/)) {
    const start = /^\s*(\d+)\s\s(.*)$/.exec(line);
    const continued = hop > 0 && /^\s{4,}\d+\.\d+\.\d+\.\d+\s/.test(line);
    if (!start && !continued) continue;
    if (start) {
      hop = Number(start[1]);
      address = null;
    }
    const tokens = (start ? start[2] : line).trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(token)) address = token;
      else if (token === '*')
        samples.push({ hop, address: null, rttMs: null, kind: 'timeout' });
      else if (/^[0-9.]+$/.test(token) && tokens[i + 1] === 'ms') {
        i++;
        samples.push({
          hop,
          address,
          rttMs: Number(token),
          kind: address === target ? 'port_unreachable' : 'time_exceeded',
        });
      } else if (token.startsWith('!') && samples.length) {
        const last = samples[samples.length - 1];
        last.annotation = token;
        last.kind =
          token === '!H'
            ? 'host_unreachable'
            : token === '!N'
            ? 'network_unreachable'
            : 'icmp_error';
      }
    }
  }
  return { target, samples };
}

export async function traceroute(host, { signal, run = exec }) {
  const timestamp = new Date().toISOString();
  const outcome = await run('traceroute', tracerouteArgs(host), {
    signal,
    timeoutMs: TRACE.deadlineMs,
  });
  const parsed = parseTraceroute(outcome);
  const samples = parsed.samples.map((s, sequence) => ({
    sequence,
    remote: parsed.target,
    probeBytes: TRACE.packetBytes - 28,
    overheadBytes: 28,
    icmpType: null,
    icmpCode: null,
    ...s,
  }));
  const terminal = samples.filter(s => s.kind === 'port_unreachable');
  const reachedHop = terminal.length
    ? Math.min(...terminal.map(s => s.hop))
    : null;
  const reason =
    outcome.stoppedBy ??
    (outcome.spawnError || (outcome.code !== 0 && !samples.length)
      ? 'network'
      : 'complete');
  const errorType =
    reason !== 'complete' ? reason : reachedHop === null ? 'timeout' : null;
  return {
    runs: [outcome],
    fields: {
      timestamp,
      durationMs: outcome.durationMs,
      value: errorType ? null : reachedHop,
      unit: 'hops',
      success: !errorType,
      errorType,
      errorMessage: !errorType
        ? null
        : reason === 'complete'
        ? 'Destination not reached within the hop limit; missing replies can reflect filtering.'
        : outcome.spawnError ??
          (outcome.stderr.trim().slice(0, 300) ||
            `Traceroute ended: ${reason}.`),
      requestedBytes: TRACE.maxHops * TRACE.perHop * 32 * 2,
      transferredBytes: null,
      targetHost: host,
      baseline: { resolvedAddress: parsed.target },
      route: {
        library: 'traceroute',
        protocol: 'udp',
        maxHops: TRACE.maxHops,
        probesPerHop: TRACE.perHop,
        probeBytes: TRACE.packetBytes - 28,
        timeoutPerProbeMs: 1000,
        deadlineMs: TRACE.deadlineMs,
        reached: reachedHop !== null,
        reachedHop,
        complete: reason === 'complete',
        stopReason: reason,
        samples,
      },
    },
  };
}

// ---- M-Lab NDT7 -----------------------------------------------------------

/** Output of the official client with -format=json (one JSON object per line). */
export function parseNdt7(stdout) {
  const result = {};
  for (const direction of ['download', 'upload'])
    result[direction] = {
      host: null,
      complete: false,
      failure: null,
      client: null,
      server: null,
    };
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const value = event?.Value;
    const entry = result[value?.Test];
    if (!entry) continue;
    if (event.Key === 'connected') entry.host = value.Server ?? null;
    else if (event.Key === 'complete') entry.complete = true;
    else if (event.Key === 'error') entry.failure = value.Failure ?? 'unknown';
    else if (event.Key === 'measurement') {
      const app = value.AppInfo;
      const tcp = value.TCPInfo;
      if (value.Origin === 'client' && app)
        entry.client = { bytes: app.NumBytes, seconds: app.ElapsedTime / 1e6 };
      // Same preference as the phone: application counters, then TCP receiver counters.
      if (value.Origin === 'server' && app?.NumBytes > 0)
        entry.server = {
          bytes: app.NumBytes,
          seconds: app.ElapsedTime / 1e6,
          source: 'app_info',
        };
      else if (
        value.Origin === 'server' &&
        tcp?.BytesReceived > 0 &&
        entry.server?.source !== 'app_info'
      )
        entry.server = {
          bytes: tcp.BytesReceived,
          seconds: tcp.ElapsedTime / 1e6,
          source: 'tcp_info',
        };
    }
  }
  return result;
}

export async function ndt7(version, { signal, timeoutMs, run = exec }) {
  const timestamp = new Date().toISOString();
  const outcome = await run('ndt7-client', ['-format=json'], {
    signal,
    timeoutMs,
  });
  const parsed = parseNdt7(outcome.stdout);
  return {
    runs: [outcome],
    pair: ['download', 'upload'].map(direction => {
      const r = parsed[direction];
      const counter = direction === 'download' ? r.client : r.server;
      const success =
        r.complete && !r.failure && counter?.bytes > 0 && counter.seconds > 0;
      const stopReason = success
        ? 'complete'
        : outcome.stoppedBy ??
          (r.failure || outcome.spawnError ? 'network' : 'invalid_response');
      return {
        timestamp,
        type: `ndt7_${direction}`,
        durationMs: (r.client?.seconds ?? r.server?.seconds ?? 0) * 1000,
        value: success ? (counter.bytes * 8) / counter.seconds / 1e6 : null,
        unit: 'Mbps',
        success,
        errorType: success ? null : stopReason,
        errorMessage: success
          ? null
          : `NDT7 reference: ${r.failure ?? outcome.spawnError ?? stopReason}.`,
        requestedBytes: null,
        transferredBytes: r.client?.bytes ?? null,
        probeServer: r.host ? `wss://${r.host}/ndt/v7/${direction}` : '',
        targetHost: r.host ?? undefined,
        reference: {
          library: 'ndt7-client-go',
          version,
          source: direction === 'download' ? 'client' : 'server',
          stopReason,
          byteThreshold: null,
          clientBytes: r.client?.bytes ?? null,
          serverBytes: r.server?.bytes ?? null,
          elapsedSeconds: counter?.seconds ?? null,
          accounting: 'last_client_sample',
          ...(r.server ? { serverCounterSource: r.server.source } : {}),
        },
      };
    }),
  };
}

/** Independent curl phases are cumulative; differences are explicitly named. */
export function paperCurlPhases(parsed) {
  const p = parsed?.phasesMs ?? {};
  const diff = (a, b) =>
    typeof a === 'number' && typeof b === 'number' ? Math.max(0, a - b) : null;
  return {
    dnsLookupMs: p.dns ?? null,
    tcpConnectMs: diff(p.connect, p.dns),
    tlsHandshakeMs: diff(p.tls, p.connect),
    responseHeadersAfterMs: p.firstByte ?? null,
    bodyReadMs: diff(p.total, p.firstByte),
    totalMs: p.total ?? null,
  };
}
export async function paperHttp(job, { signal, run = exec }) {
  const cdn = PAPER_REGISTRY.cdns.find(c => c.id === job.targetId);
  const nonce = randomBytes(16).toString('hex');
  const url =
    job.type === 'cdn_fetch'
      ? cdn.url
      : `https://${nonce}.${PAPER_REGISTRY.resolverDomain}/`;
  const limit = job.type === 'cdn_fetch' ? PAPER_CDN_LIMIT : PAPER_DNS_LIMIT;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skymeasure-paper-'));
  const bodyFile = path.join(directory, 'body'),
    headersFile = path.join(directory, 'headers');
  try {
    const outcome = await run(
      'curl',
      [
        '--ipv4',
        '--http1.1',
        '--noproxy',
        '*',
        '--silent',
        '--show-error',
        '--max-time',
        String(job.timeoutMs / 1000),
        '--max-filesize',
        String(limit),
        '-H',
        'Accept-Encoding: identity',
        '-D',
        headersFile,
        '-o',
        bodyFile,
        '-w',
        '%{json}',
        url,
      ],
      { signal, timeoutMs: job.timeoutMs + 2000 },
    );
    const parsed = parseCurl(outcome.stdout);
    const body = await readFile(bodyFile).catch(() => null),
      data = body?.subarray(0, limit);
    const allHeaders = parseHeaders(
      await readFile(headersFile, 'utf8').catch(() => ''),
    );
    const headers = Object.fromEntries(
      Object.entries(allHeaders)
        .filter(([k]) =>
          [
            'cache-control',
            'age',
            'expires',
            'via',
            'x-cache',
            'cf-cache-status',
            'cf-ray',
            'x-served-by',
            'content-type',
            'content-length',
            'etag',
            'last-modified',
          ].includes(k),
        )
        .map(([k, v]) => [k, String(v).slice(0, 1024)]),
    );
    const bodyComplete = outcome.code === 0 && (body?.length ?? 0) <= limit;
    const sha256 = data
      ? createHash('sha256').update(data).digest('hex')
      : null;
    const contentMatches =
      job.type === 'cdn_fetch'
        ? bodyComplete &&
          data?.length === PAPER_REGISTRY.content.bytes &&
          sha256 === PAPER_REGISTRY.content.sha256
        : null;
    let response = null;
    if (job.type === 'dns_resolver' && bodyComplete)
      try {
        response = JSON.parse(data.toString('utf8'));
      } catch {}
    const resolverStatus =
      typeof response?.status === 'string' ? response.status : null;
    const resolver = net.isIP(response?.resolver ?? '')
      ? response.resolver
      : null;
    const success =
      bodyComplete &&
      parsed?.httpStatus === 200 &&
      (job.type === 'cdn_fetch'
        ? contentMatches
        : ['ok', 'unconfigured'].includes(resolverStatus));
    const paper = {
      suiteVersion: PAPER_REGISTRY.version,
      provider: cdn?.id,
      url: cdn?.url,
      bodyBytes: data?.length ?? null,
      byteLimit: limit,
      bodyComplete,
      contentMatches,
      sha256,
      ...paperCurlPhases(parsed),
      remoteAddress: parsed?.remoteAddress ?? null,
      httpVersion: parsed?.httpVersion ?? null,
      headers,
      ...(job.type === 'dns_resolver'
        ? {
            configuredDnsServers: dns.getServers(),
            observedResolverIp: resolver,
            resolverStatus,
            resolverUnavailableReason: resolver
              ? null
              : 'endpoint_did_not_report_resolver_ip',
          }
        : {}),
    };
    return {
      fields: {
        type: job.type,
        targetId: job.targetId,
        targetMode: 'hostname',
        targetHost: cdn?.url ?? PAPER_REGISTRY.resolverDomain,
        resolvedAddress: parsed?.remoteAddress ?? null,
        roundId: job.roundId,
        success,
        value: success && job.type === 'cdn_fetch' ? paper.totalMs : null,
        unit: 'ms',
        durationMs: outcome.durationMs,
        httpStatus: parsed?.httpStatus ?? null,
        transferredBytes: paper.bodyBytes,
        errorType: success
          ? null
          : outcome.stoppedBy === 'cancelled'
          ? 'cancelled'
          : outcome.code
          ? curlError(outcome.code)
          : 'invalid_response',
        paper,
      },
      runs: [outcome],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function paperTrace(job, { signal, run = exec }) {
  const spec = PAPER_REGISTRY.traces.find(t => t.id === job.targetId);
  const started = performance.now();
  let address = spec.host,
    resolutionMs = null;
  try {
    if (spec.mode === 'hostname') {
      address = (await dns.lookup(spec.host, { family: 4 })).address;
      resolutionMs = performance.now() - started;
    }
    const result = await traceroute(address, { signal, run });
    return {
      ...result,
      fields: {
        ...result.fields,
        targetId: spec.id,
        targetMode: spec.mode,
        targetHost: spec.host,
        resolvedAddress: address,
        resolutionMs,
        roundId: job.roundId,
      },
    };
  } catch {
    return {
      fields: {
        type: 'traceroute',
        targetId: spec.id,
        targetHost: spec.host,
        targetMode: spec.mode,
        roundId: job.roundId,
        success: false,
        value: null,
        unit: 'hops',
        durationMs: performance.now() - started,
        errorType: 'network',
        errorMessage: 'Reference hostname resolution failed',
      },
      runs: [],
    };
  }
}

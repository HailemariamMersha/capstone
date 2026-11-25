#!/usr/bin/env node
/** Phone export(s) against a baseline run. Reports differences; sets no pass/fail limits. */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  median,
  protocolSummary,
  quantile,
  summarize,
  usable,
} from './summary.mjs';
import {
  createPrivateDirectory,
  csv,
  sealEvidence,
  verifyEvidence,
  writePrivate,
} from './evidence.mjs';

/** Interleaved bursts are 30 s apart; beyond this they are not the same minute. */
export const PAIR_WINDOW_MS = 45000;
const PAIRED_TYPES = ['icmp_burst', 'udp_echo', 'tcp_connect'];
const isBaseline = s => s.session?.config?.collectionMode === 'linux_baseline';

export function loadSessions(values, role) {
  const found = new Map();
  for (const value of values) {
    if (!value?.session?.id || !Array.isArray(value.measurements))
      throw new Error(
        'Expected session JSON with session.id and measurements.',
      );
    if (isBaseline(value) !== (role === 'baseline'))
      throw new Error(
        `A ${role} input has the wrong kind of data (${
          value.session.config?.collectionMode ?? 'unlabelled'
        }).`,
      );
    const previous = found.get(value.session.id);
    if (previous && !isDeepStrictEqual(previous, value))
      throw new Error(
        `Conflicting exports for session ${value.session.id}. Choose one authoritative export.`,
      );
    found.set(value.session.id, value);
  }
  if (!found.size) throw new Error(`No ${role} sessions found.`);
  return [...found.values()];
}
const startOf = m => Date.parse(m.scheduling?.startedAt ?? m.timestamp);
const values = (sessions, key) =>
  new Set(
    sessions.flatMap(s =>
      (s.snapshots ?? []).map(n => n[key]).filter(v => v != null),
    ),
  );
const match = (a, b) =>
  !a.size || !b.size
    ? 'unknown'
    : [...a].every(v => b.has(v)) && [...b].every(v => a.has(v))
    ? 'match'
    : [...a].some(v => b.has(v))
    ? 'partial'
    : 'mismatch';
/** A burst involving multiple resolved destinations cannot be compared as one target. */
export function endpointOf(m) {
  const callbacks = (m.raw?.callbacks ?? []).map(c => c.value ?? {});
  const addresses = [
    ...new Set(
      [
        m.resolvedAddress,
        m.baseline?.resolvedAddress,
        m.raw?.request?.host,
        m.targetHost,
        ...callbacks.map(c => c.remoteAddress),
        ...(m.details?.samples ?? []).flatMap(s => [
          s.resolvedAddress,
          s.packet?.resolvedAddress,
        ]),
      ].filter(a => typeof a === 'string' && net.isIP(a)),
    ),
  ];
  const ports = [
    ...new Set(
      [
        m.details?.targetPort,
        m.raw?.request?.port,
        ...callbacks.map(c => c.remotePort),
      ].filter(p => Number.isInteger(p) && p > 0 && p <= 65535),
    ),
  ];
  const protocol = { icmp_burst: 'icmp', udp_echo: 'udp', tcp_connect: 'tcp' }[
    m.type
  ];
  const reason =
    addresses.length > 1
      ? 'mixed_target_addresses'
      : !addresses.length
      ? 'unknown_target'
      : protocol !== 'icmp' && ports.length !== 1
      ? 'unknown_or_mixed_port'
      : null;
  return {
    protocol,
    address: addresses.length === 1 ? addresses[0] : null,
    port: protocol === 'icmp' ? null : ports.length === 1 ? ports[0] : null,
    reason,
  };
}
const targetOf = m => endpointOf(m).address;
const sameEndpoint = (p, b) => {
  const a = endpointOf(p),
    c = endpointOf(b);
  return (
    !a.reason &&
    !c.reason &&
    a.protocol === c.protocol &&
    a.address === c.address &&
    a.port === c.port
  );
};
const sameObservedNetwork = (p, b) =>
  ['publicIp', 'asn'].every(key => {
    const a = p.networkSnapshot?.[key],
      c = b.networkSnapshot?.[key];
    return a == null || c == null || a === c;
  });
const targets = measurements =>
  new Set(
    measurements
      .filter(m => m.type === 'icmp_burst')
      .map(targetOf)
      .filter(Boolean),
  );

/** One-to-one nearest pairs, so no burst is counted twice. */
export function pairUp(phone, baseline, compatible = sameEndpoint) {
  const candidates = phone
    .flatMap((p, i) =>
      baseline
        .map((b, j) => ({ i, j, gap: Math.abs(startOf(p) - startOf(b)) }))
        .filter(c => c.gap <= PAIR_WINDOW_MS && compatible(p, baseline[c.j])),
    )
    .sort((a, b) => a.gap - b.gap);
  const usedPhone = new Set();
  const usedBaseline = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedPhone.has(c.i) || usedBaseline.has(c.j)) continue;
    usedPhone.add(c.i);
    usedBaseline.add(c.j);
    pairs.push([phone[c.i], baseline[c.j]]);
  }
  return pairs;
}
const HEAVY_TYPES = [
  'cdn_fetch',
  'download',
  'upload',
  'ndt7_download',
  'ndt7_upload',
];
const endOf = m => {
  const callback = Date.parse(m.scheduling?.callbackAt);
  return Number.isFinite(callback)
    ? callback
    : startOf(m) + Math.max(0, m.durationMs ?? 0);
};
const overlaps = (a, b) => startOf(a) < endOf(b) && startOf(b) < endOf(a);

function pairedResult(type, phone, baseline, environment, comparability) {
  const excluded = [],
    eligible = { phone: [], baseline: [] };
  const source = {
    phone: phone.filter(m => m.type === type),
    baseline: baseline.filter(m => m.type === type),
  };
  const contextReason = environment.vpnAllowed
    ? 'baseline_vpn'
    : environment.wifi === false
    ? 'baseline_not_wifi'
    : environment.clock?.ok === false
    ? 'clock_not_synchronised'
    : comparability.publicIp === 'mismatch' || comparability.asn === 'mismatch'
    ? 'different_network'
    : null;
  const exclude = (m, role, reason) =>
    excluded.push({
      role,
      measurementId: m.id ?? null,
      sessionId: m.sessionId ?? null,
      type,
      startedAt: m.scheduling?.startedAt ?? m.timestamp ?? null,
      ...endpointOf(m),
      reason,
      valueMs: m.value ?? null,
      rawFile: m.raw?.request?.outputFile ?? null,
    });
  for (const [role, rows] of Object.entries(source)) {
    const other = role === 'phone' ? baseline : phone;
    for (const m of rows) {
      const reason = !m.success
        ? 'unsuccessful_attempt'
        : !usable(m)
        ? 'invalid_clock_domain'
        : !Number.isFinite(m.value)
        ? 'unavailable_value'
        : !Number.isFinite(startOf(m))
        ? 'invalid_timestamp'
        : endpointOf(m).reason ??
          contextReason ??
          (other.some(x => HEAVY_TYPES.includes(x.type) && overlaps(m, x))
            ? 'other_device_heavy_overlap'
            : null);
      if (reason) exclude(m, role, reason);
      else eligible[role].push(m);
    }
  }
  const pairs = pairUp(
    eligible.phone,
    eligible.baseline,
    (p, b) => sameEndpoint(p, b) && sameObservedNetwork(p, b),
  );
  const used = new Set(pairs.flat());
  for (const [role, rows] of Object.entries(eligible))
    for (const m of rows) {
      if (used.has(m)) continue;
      const peers = eligible[role === 'phone' ? 'baseline' : 'phone'];
      const nearby = peers.filter(
        x => Math.abs(startOf(x) - startOf(m)) <= PAIR_WINDOW_MS,
      );
      exclude(
        m,
        role,
        nearby.some(x => sameEndpoint(m, x) && sameObservedNetwork(m, x))
          ? 'reference_already_paired'
          : nearby.some(x => sameEndpoint(m, x))
          ? 'different_network'
          : nearby.length
          ? 'different_destination'
          : 'no_eligible_reference_within_window',
      );
    }
  const d = pairs.map(([p, b]) => p.value - b.value).sort((a, b) => a - b);
  const n = d.length;
  const mean = n ? d.reduce((a, b) => a + b, 0) / n : null;
  const sd =
    n > 1
      ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : null;
  return {
    pairs: n,
    sameTargetPairs: n,
    excludedCounts: Object.fromEntries(
      ['phone', 'baseline'].map(role => [
        role,
        excluded.filter(x => x.role === role).length,
      ]),
    ),
    excluded,
    records: pairs.map(([p, b]) => ({
      type,
      protocol: endpointOf(p).protocol,
      address: targetOf(p),
      port: endpointOf(p).port,
      phoneMeasurementId: p.id ?? null,
      baselineMeasurementId: b.id ?? null,
      phoneSessionId: p.sessionId ?? null,
      baselineSessionId: b.sessionId ?? null,
      phoneStartedAt: p.scheduling?.startedAt ?? p.timestamp,
      baselineStartedAt: b.scheduling?.startedAt ?? b.timestamp,
      separationMs: Math.abs(startOf(p) - startOf(b)),
      phoneValueMs: p.value,
      baselineValueMs: b.value,
      differenceMs: p.value - b.value,
      baselineRawFile: b.raw?.request?.outputFile ?? null,
    })),
    medianDifferenceMs: n
      ? (d[Math.floor((n - 1) / 2)] + d[Math.floor(n / 2)]) / 2
      : null,
    meanDifferenceMs: mean,
    sdDifferenceMs: sd,
    limitsOfAgreementMs:
      sd === null ? null : [mean - 1.96 * sd, mean + 1.96 * sd],
    middleHalfMs: n ? [quantile(d, 0.25), quantile(d, 0.75)] : null,
  };
}
const lateness = rows => {
  const list = rows
    .map(m => m.scheduling?.latenessMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: list.length,
    medianMs: quantile(list, 0.5),
    p95Ms: quantile(list, 0.95),
    maxMs: list[list.length - 1] ?? null,
  };
};
const span = rows => {
  const t = rows.map(startOf).filter(Number.isFinite);
  return t.length ? [Math.min(...t), Math.max(...t)] : null;
};

/** Target-aware paper medians; no pooled multi-CDN completion-time statistic. */
export function paperComparisons(rows) {
  const groups = new Map();
  for (const m of rows.filter(r =>
    ['cdn_fetch', 'dns_resolver', 'traceroute'].includes(r.type),
  )) {
    const key = `${m.type}:${m.targetId ?? m.targetHost ?? 'unknown'}`;
    const group = groups.get(key) ?? {
      type: m.type,
      targetId: m.targetId ?? null,
      target: m.targetHost ?? null,
      attempts: 0,
      successful: 0,
      resolvedAddresses: new Set(),
      phaseValues: {},
      resolvers: new Set(),
    };
    group.attempts++;
    group.successful += m.success === true;
    if (m.resolvedAddress) group.resolvedAddresses.add(m.resolvedAddress);
    if (m.paper?.observedResolverIp)
      group.resolvers.add(m.paper.observedResolverIp);
    if (m.success && usable(m))
      for (const field of [
        'dnsLookupMs',
        'tcpConnectMs',
        'tlsHandshakeMs',
        'responseHeadersAfterMs',
        'bodyReadMs',
        'totalMs',
      ]) {
        const value = m.paper?.[field];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          (group.phaseValues[field] ??= []).push(value);
      }
    groups.set(key, group);
  }
  return [...groups.values()].map(g => ({
    ...g,
    resolvedAddresses: [...g.resolvedAddresses],
    resolvers: [...g.resolvers],
    phaseValues: undefined,
    medianPhasesMs: Object.fromEntries(
      Object.entries(g.phaseValues).map(([k, v]) => [k, median(v)]),
    ),
  }));
}

export function compare(
  phoneSessions,
  baselineSessions,
  controls,
  environment = {},
) {
  const phone = phoneSessions.flatMap(s => s.measurements);
  const baseline = baselineSessions.flatMap(s => s.measurements);
  const [p, b] = [span(phone), span(baseline)];
  const overlap =
    p && b
      ? Math.max(0, Math.min(p[1], b[1]) - Math.max(p[0], b[0])) / 60000
      : 0;
  const comparability = {
    overlapMinutes: overlap,
    // Compared, never printed: a public address identifies the network's owner.
    publicIp: match(
      values(phoneSessions, 'publicIp'),
      values(baselineSessions, 'publicIp'),
    ),
    asn: match(values(phoneSessions, 'asn'), values(baselineSessions, 'asn')),
    googleTargets: match(targets(phone), targets(baseline)),
    baselineVpn: environment.vpnAllowed ?? false,
    baselineWifi: environment.wifi ?? null,
    clockOk: environment.clock?.ok ?? null,
  };
  const flags = [];
  if (!overlap)
    flags.push(
      'The two runs do not overlap in time. Differences may be changes in the network.',
    );
  if (comparability.publicIp !== 'match')
    flags.push(
      `Public addresses: ${comparability.publicIp}. They may be on different networks.`,
    );
  if (comparability.asn !== 'match')
    flags.push(`Provider ASN: ${comparability.asn}.`);
  if (comparability.googleTargets !== 'match')
    flags.push(
      `Google addresses: ${comparability.googleTargets}. Only pairs with a verified identical destination contribute to differences.`,
    );
  if (comparability.baselineVpn)
    flags.push('The baseline ran with --allow-vpn. It is not comparable.');
  if (comparability.baselineWifi === false)
    flags.push('The baseline did not use Wi-Fi.');
  if (comparability.clockOk !== true)
    flags.push(
      'The baseline clock was not confirmed as synchronised; pairing may be off.',
    );
  const types = [...new Set([...phone, ...baseline].map(m => m.type))].sort();
  return {
    schema: 'skymeasure-comparison-2',
    paper: Object.fromEntries(
      ['phone', 'baseline'].map(role => [
        role,
        paperComparisons(role === 'phone' ? phone : baseline),
      ]),
    ),
    comparability,
    flags,
    phone: Object.fromEntries(types.map(t => [t, protocolSummary(t, phone)])),
    baseline: Object.fromEntries(
      types.map(t => [t, protocolSummary(t, baseline)]),
    ),
    controls: summarize(controls),
    paired: Object.fromEntries(
      PAIRED_TYPES.map(t => [
        t,
        pairedResult(t, phone, baseline, environment, comparability),
      ]),
    ),
    scheduling: Object.fromEntries(
      types.map(t => [
        t,
        {
          phone: lateness(phone.filter(m => m.type === t)),
          baseline: lateness(baseline.filter(m => m.type === t)),
        },
      ]),
    ),
    transfers: Object.fromEntries(
      ['phone', 'baseline'].map(role => [
        role,
        (role === 'phone' ? phone : baseline)
          .filter(m => m.type === 'download' || m.type === 'upload')
          .map(m => ({
            type: m.type,
            startedAt: m.scheduling?.startedAt ?? m.timestamp,
            success: m.success,
            errorType: m.errorType,
            mbps: m.value,
            seconds: m.durationMs / 1000,
            headersSeconds:
              m.transfer?.headersAfterMs != null
                ? m.transfer.headersAfterMs / 1000
                : null,
            observedBytes: m.transfer?.observedBytes ?? null,
            phasesMs: m.baseline?.phasesMs ?? null,
          })),
      ]),
    ),
  };
}

const f = (v, digits = 1, unit = '') =>
  typeof v === 'number' && Number.isFinite(v)
    ? `${v.toFixed(digits)}${unit}`
    : '-';
const range = (pair, digits = 1) =>
  pair ? `${f(pair[0], digits)} to ${f(pair[1], digits)}` : '-';
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
export function markdown(r) {
  const types = Object.keys(r.phone);
  const side = (name, s, type) => [
    type,
    name,
    `${s.successful}/${s.attempts}`,
    s.sampleCount && s.lossPercent !== null
      ? `${f(s.lossPercent, 2, '%')} (${range(s.lossInterval95, 2)})`
      : '-',
    s.medianMs !== null
      ? f(s.medianMs, 1, ' ms')
      : f(s.medianValue, 1, ` ${s.unit ?? ''}`),
    s.p95Ms !== null ? f(s.p95Ms, 1, ' ms') : '-',
  ];
  const control = t => r.controls.find(c => c.type === t);
  return `# Phone against baseline

A different device on the same network: a plausibility check, not same-device ground truth.
No pass or fail limits are applied.

## Can these runs be compared?

${
  r.flags.length
    ? r.flags.map(x => `- ${x}`).join('\n')
    : '- No problems found.'
}

Overlap: ${f(r.comparability.overlapMinutes, 1)} minutes.

## Results

${table(
  [
    'Measurement',
    'Source',
    'Succeeded',
    'Loss (95% interval)',
    'Median',
    'p95',
  ],
  types.flatMap(t => [
    side('phone', r.phone[t], t),
    side('baseline', r.baseline[t], t),
  ]),
)}

Loss intervals treat probes as independent. Losses cluster in time, so the true uncertainty is wider.
Attempts interrupted by a clock gap are excluded from timing.

## Same minute, phone minus baseline

${table(
  [
    'Measurement',
    'Pairs',
    'Same target',
    'Excluded phone / baseline',
    'Median difference',
    'Middle half',
    'Limits of agreement',
  ],
  Object.entries(r.paired).map(([t, v]) => [
    t,
    v.pairs,
    v.sameTargetPairs,
    `${v.excludedCounts.phone} / ${v.excludedCounts.baseline}`,
    f(v.medianDifferenceMs, 1, ' ms'),
    range(v.middleHalfMs),
    range(v.limitsOfAgreementMs),
  ]),
)}

Positive means the phone reported a larger value. Each pair is at most 45 s apart, with the same protocol, verified destination IP and (for TCP/UDP) port. ICMP/UDP use burst medians; TCP uses connection duration including resolution/callback scope.

Unknown or mixed destinations, failed/interrupted attempts, invalid clocks, known network/VPN mismatches and observations overlapping the other device's heavy test are excluded. Unknown network/clock context remains a limitation, not proof of comparability.
See [individual paired observations](paired.csv), [every excluded measurement and reason](excluded.csv), and [saved input sessions and provenance](inputs.json).

## Is UDP slow, or is the server far away?

${table(
  ['Path', 'Median', 'p95'],
  [
    [
      'Phone UDP to lab',
      f(r.phone.udp_echo?.medianMs, 1, ' ms'),
      f(r.phone.udp_echo?.p95Ms, 1, ' ms'),
    ],
    [
      'Baseline UDP to lab',
      f(r.baseline.udp_echo?.medianMs, 1, ' ms'),
      f(r.baseline.udp_echo?.p95Ms, 1, ' ms'),
    ],
    [
      'Control ICMP to lab',
      f(control('control_icmp')?.medianMs, 1, ' ms'),
      f(control('control_icmp')?.p95Ms, 1, ' ms'),
    ],
    [
      'Control TCP to probe server (with lookup)',
      f(control('control_tcp')?.medianMs, 1, ' ms'),
      f(control('control_tcp')?.p95Ms, 1, ' ms'),
    ],
  ],
)}

If all rows are close, the delay is the path to the server. If only the phone row is high, suspect the phone's UDP library.
If both UDP rows are high but the controls are not, suspect UDP handling on the path or server.

## Where is packet loss?

${table(
  ['Path', 'Answered', 'Loss (95% interval)', 'Median'],
  [
    ['Baseline to local router', control('control_gateway')],
    ['Baseline to Google', r.baseline.icmp_burst],
    ['Baseline to lab, ICMP', control('control_icmp')],
    ['Baseline to lab, UDP', r.baseline.udp_echo],
    ['Phone to Google', r.phone.icmp_burst],
    ['Phone to lab, UDP', r.phone.udp_echo],
  ].map(([name, s]) => [
    name,
    s ? `${s.replies}/${s.sampleCount}` : '-',
    s && s.lossPercent !== null
      ? `${f(s.lossPercent, 2, '%')} (${range(s.lossInterval95, 2)})`
      : '-',
    f(s?.medianMs, 1, ' ms'),
  ]),
)}

If the router row loses about as much as the rest, suspect the Wi-Fi or this computer. If the router row is clean, the loss is beyond it.
Routers may give pings to themselves low priority, so loss or delay at the router alone is not proof of a Wi-Fi fault.

## Controlled transfers

${table(
  [
    'Source',
    'Direction',
    'Outcome',
    'Mbps',
    'Seconds',
    'Headers after',
    'DNS / connect / TLS',
  ],
  ['phone', 'baseline'].flatMap(role =>
    r.transfers[role].map(x => [
      role,
      x.type,
      x.success ? 'ok' : x.errorType,
      f(x.mbps, 2),
      f(x.seconds),
      f(x.headersSeconds, 1, ' s'),
      x.phasesMs
        ? [x.phasesMs.dns, x.phasesMs.connect, x.phasesMs.tls]
            .map(v => f(v, 0))
            .join(' / ') + ' ms'
        : '-',
    ]),
  ),
)}

Phase times are cumulative from the start of the request.

## Paper-suite targets

CDN phase medians remain separated by provider. curl uses cumulative first-byte timing where OkHttp records headers-end; these are close but distinct callback scopes. Compare the same resolved IP where possible. DNS discovery is not DNS RTT.

${table(
  [
    'Source',
    'Test',
    'Target',
    'Completed',
    'DNS ms',
    'TCP ms',
    'TLS ms',
    'Total ms',
  ],
  Object.entries(r.paper ?? {}).flatMap(([side, rows]) =>
    rows.map(g => [
      side,
      g.type,
      g.targetId ?? g.target,
      `${g.successful}/${g.attempts}`,
      f(g.medianPhasesMs.dnsLookupMs),
      f(g.medianPhasesMs.tcpConnectMs),
      f(g.medianPhasesMs.tlsHandshakeMs),
      f(g.medianPhasesMs.totalMs),
    ]),
  ),
)}

## Scheduling (actual minus planned start)

${table(
  ['Measurement', 'Phone median / p95 / max', 'Baseline median / p95 / max'],
  types.map(t => [
    t,
    ...['phone', 'baseline'].map(
      s =>
        ['medianMs', 'p95Ms', 'maxMs']
          .map(k => f(r.scheduling[t][s][k], 0))
          .join(' / ') + ' ms',
    ),
  ]),
)}
`;
}

export async function readInputs(inputs, provenance = []) {
  const result = [];
  for (const input of inputs) {
    const info = await stat(input);
    const files = info.isDirectory()
      ? (await readdir(input))
          .sort()
          .filter(n => n.endsWith('.json'))
          .map(n => path.join(input, n))
      : [input];
    for (const file of files) {
      const bytes = await readFile(file);
      const value = JSON.parse(bytes.toString('utf8'));
      // A run summary has a numeric `segments` count, so only arrays are lists of sessions.
      const list = [value, value.sessions, value.segments].find(
        Array.isArray,
      ) ?? [value];
      const sessions = list.filter(
        v => v?.session?.id && Array.isArray(v.measurements),
      );
      // Directories can hold other JSON; a file named explicitly must be usable.
      if (!sessions.length && !info.isDirectory())
        throw new Error(`No session evidence in ${file}`);
      if (sessions.length)
        provenance.push({
          path: path.resolve(file),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      result.push(...sessions);
    }
  }
  return result;
}

export async function saveComparison(directory, result, inputs) {
  await createPrivateDirectory(directory);
  const paired = Object.values(result.paired).flatMap(v => v.records);
  const excluded = Object.values(result.paired).flatMap(v => v.excluded);
  await writePrivate(directory, 'comparison.json', result);
  await writePrivate(directory, 'comparison.md', markdown(result));
  await writePrivate(
    directory,
    'paired.csv',
    csv(
      [
        'type',
        'protocol',
        'address',
        'port',
        'phoneMeasurementId',
        'baselineMeasurementId',
        'phoneSessionId',
        'baselineSessionId',
        'phoneStartedAt',
        'baselineStartedAt',
        'separationMs',
        'phoneValueMs',
        'baselineValueMs',
        'differenceMs',
        'baselineRawFile',
      ],
      paired,
    ),
  );
  await writePrivate(
    directory,
    'excluded.csv',
    csv(
      [
        'role',
        'measurementId',
        'sessionId',
        'type',
        'startedAt',
        'protocol',
        'address',
        'port',
        'reason',
        'valueMs',
        'rawFile',
      ],
      excluded,
    ),
  );
  // Preserve the exact parsed sessions used for the computation, including unfamiliar fields.
  // Original command-output files remain in the identified baseline run folder.
  await writePrivate(directory, 'inputs.json', {
    schema: 'skymeasure-comparison-inputs-1',
    ...inputs,
  });
  await sealEvidence(directory, {
    kind: 'comparison',
    schemaVersion: result.schema,
  });
}
async function main() {
  const { values: v } = parseArgs({
    options: {
      phone: { type: 'string', multiple: true },
      baseline: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (v.help || !v.phone?.length || !v.baseline || !v.out) {
    console.log(
      'Usage: npm run baseline:compare -- --phone EXPORT_OR_FOLDER [--phone ...] --baseline build/baseline/RUN --out NEW_FOLDER',
    );
    if (!v.help) process.exitCode = 1;
    return;
  }
  const sources = { phone: [], baseline: [] };
  const phone = loadSessions(await readInputs(v.phone, sources.phone), 'phone');
  const baseline = loadSessions(
    (await readInputs([v.baseline], sources.baseline)).filter(isBaseline),
    'baseline',
  );
  const readOptional = async (name, fallback) =>
    existsSync(path.join(v.baseline, name))
      ? JSON.parse(await readFile(path.join(v.baseline, name), 'utf8'))
      : fallback;
  const { measurements: controls } = await readOptional('control.json', {
    measurements: [],
  });
  const run = await readOptional('run.json', { environment: {} });
  const environment = run.environment ?? {};
  let integrity = 'historical_or_unfinished';
  if (existsSync(path.join(v.baseline, 'manifest.json'))) {
    const check = await verifyEvidence(v.baseline);
    if (!check.ok)
      throw new Error(
        'Baseline integrity verification failed. Run baseline:verify to inspect changed or missing files.',
      );
    integrity = 'verified';
  }
  const result = compare(phone, baseline, controls, environment);
  if (integrity !== 'verified')
    result.flags.push(
      'This baseline has no final integrity manifest; it is historical or unfinished.',
    );
  if (run.status && !['complete', 'stopped'].includes(run.status))
    result.flags.push(
      `Baseline status is ${run.status}; these are partial observations.`,
    );
  await saveComparison(v.out, result, {
    sources,
    baselineDirectory: path.resolve(v.baseline),
    phoneSessions: phone,
    baselineSessions: baseline,
    controls,
    environment,
    baselineStatus: run.status ?? 'historical_unknown',
    baselineIntegrity: integrity,
  });
  for (const flag of result.flags) console.log(`  warning: ${flag}`);
  console.log(`Wrote ${path.join(v.out, 'comparison.md')}`);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });

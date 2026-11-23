#!/usr/bin/env node
/** Phone export(s) against a baseline run. Reports differences; sets no pass/fail limits. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { median, protocolSummary, quantile, summarize, usable } from './summary.mjs';

/** Interleaved bursts are 30 s apart; beyond this they are not the same minute. */
export const PAIR_WINDOW_MS = 45000;
const PAIRED_TYPES = ['icmp_burst', 'udp_echo', 'tcp_connect'];
const isBaseline = s => s.session?.config?.collectionMode === 'linux_baseline';

export function loadSessions(values, role) {
  const found = new Map();
  for (const value of values) {
    if (!value?.session?.id || !Array.isArray(value.measurements))
      throw new Error('Expected session JSON with session.id and measurements.');
    if (isBaseline(value) !== (role === 'baseline'))
      throw new Error(`A ${role} input has the wrong kind of data (${value.session.config?.collectionMode ?? 'unlabelled'}).`);
    found.set(value.session.id, value);
  }
  if (!found.size) throw new Error(`No ${role} sessions found.`);
  return [...found.values()];
}
const startOf = m => Date.parse(m.scheduling?.startedAt ?? m.timestamp);
const values = (sessions, key) =>
  new Set(sessions.flatMap(s => (s.snapshots ?? []).map(n => n[key]).filter(v => v != null)));
const match = (a, b) => (!a.size || !b.size ? 'unknown' : [...a].every(v => b.has(v)) && [...b].every(v => a.has(v)) ? 'match' : [...a].some(v => b.has(v)) ? 'partial' : 'mismatch');
const targetOf = m => {
  const s = m.details?.samples?.find(x => x.packet?.resolvedAddress ?? x.resolvedAddress);
  return s?.packet?.resolvedAddress ?? s?.resolvedAddress ?? m.baseline?.resolvedAddress ?? null;
};
const targets = measurements => new Set(measurements.filter(m => m.type === 'icmp_burst').map(targetOf).filter(Boolean));

/** One-to-one nearest pairs, so no burst is counted twice. */
export function pairUp(phone, baseline) {
  const candidates = phone
    .flatMap((p, i) => baseline.map((b, j) => ({ i, j, gap: Math.abs(startOf(p) - startOf(b)) })).filter(c => c.gap <= PAIR_WINDOW_MS))
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
function pairedResult(type, phone, baseline) {
  const good = list => list.filter(m => m.type === type && m.success && usable(m) && Number.isFinite(m.value));
  const pairs = pairUp(good(phone), good(baseline));
  const d = pairs.map(([p, b]) => p.value - b.value).sort((a, b) => a - b);
  const n = d.length;
  const mean = n ? d.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  return {
    pairs: n,
    sameTargetPairs: pairs.filter(([p, b]) => targetOf(p) && targetOf(p) === targetOf(b)).length,
    medianDifferenceMs: n ? median(d.map(v => v + 1e9)) - 1e9 : null,
    meanDifferenceMs: mean,
    sdDifferenceMs: sd,
    limitsOfAgreementMs: sd === null ? null : [mean - 1.96 * sd, mean + 1.96 * sd],
    middleHalfMs: n ? [quantile(d, 0.25), quantile(d, 0.75)] : null,
  };
}
const lateness = rows => {
  const list = rows.map(m => m.scheduling?.latenessMs).filter(Number.isFinite).sort((a, b) => a - b);
  return { count: list.length, medianMs: quantile(list, 0.5), p95Ms: quantile(list, 0.95), maxMs: list[list.length - 1] ?? null };
};
const span = rows => {
  const t = rows.map(startOf).filter(Number.isFinite);
  return t.length ? [Math.min(...t), Math.max(...t)] : null;
};

export function compare(phoneSessions, baselineSessions, controls, environment = {}) {
  const phone = phoneSessions.flatMap(s => s.measurements);
  const baseline = baselineSessions.flatMap(s => s.measurements);
  const [p, b] = [span(phone), span(baseline)];
  const overlap = p && b ? Math.max(0, Math.min(p[1], b[1]) - Math.max(p[0], b[0])) / 60000 : 0;
  const comparability = {
    overlapMinutes: overlap,
    // Compared, never printed: a public address identifies the network's owner.
    publicIp: match(values(phoneSessions, 'publicIp'), values(baselineSessions, 'publicIp')),
    asn: match(values(phoneSessions, 'asn'), values(baselineSessions, 'asn')),
    googleTargets: match(targets(phone), targets(baseline)),
    baselineVpn: environment.vpnAllowed ?? false,
    baselineWifi: environment.wifi ?? null,
    clockOk: environment.clock?.ok ?? null,
  };
  const flags = [];
  if (!overlap) flags.push('The two runs do not overlap in time. Differences may be changes in the network.');
  if (comparability.publicIp !== 'match') flags.push(`Public addresses: ${comparability.publicIp}. They may be on different networks.`);
  if (comparability.asn !== 'match') flags.push(`Provider ASN: ${comparability.asn}.`);
  if (comparability.googleTargets !== 'match') flags.push(`Google addresses: ${comparability.googleTargets}. Use the same-target pair count for ICMP.`);
  if (comparability.baselineVpn) flags.push('The baseline ran with --allow-vpn. It is not comparable.');
  if (comparability.baselineWifi === false) flags.push('The baseline did not use Wi-Fi.');
  if (comparability.clockOk !== true) flags.push('The baseline clock was not confirmed as synchronised; pairing may be off.');
  const types = [...new Set([...phone, ...baseline].map(m => m.type))].sort();
  return {
    schema: 'skymeasure-comparison-1',
    comparability,
    flags,
    phone: Object.fromEntries(types.map(t => [t, protocolSummary(t, phone)])),
    baseline: Object.fromEntries(types.map(t => [t, protocolSummary(t, baseline)])),
    controls: summarize(controls),
    paired: Object.fromEntries(PAIRED_TYPES.map(t => [t, pairedResult(t, phone, baseline)])),
    scheduling: Object.fromEntries(types.map(t => [t, { phone: lateness(phone.filter(m => m.type === t)), baseline: lateness(baseline.filter(m => m.type === t)) }])),
    transfers: Object.fromEntries(
      ['phone', 'baseline'].map(role => [
        role,
        (role === 'phone' ? phone : baseline)
          .filter(m => m.type === 'download' || m.type === 'upload')
          .map(m => ({
            type: m.type, startedAt: m.scheduling?.startedAt ?? m.timestamp, success: m.success, errorType: m.errorType, mbps: m.value,
            seconds: m.durationMs / 1000, headersSeconds: m.transfer?.headersAfterMs != null ? m.transfer.headersAfterMs / 1000 : null,
            observedBytes: m.transfer?.observedBytes ?? null, phasesMs: m.baseline?.phasesMs ?? null,
          })),
      ]),
    ),
  };
}

const f = (v, digits = 1, unit = '') => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '-');
const range = (pair, digits = 1) => (pair ? `${f(pair[0], digits)} to ${f(pair[1], digits)}` : '-');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
export function markdown(r) {
  const types = Object.keys(r.phone);
  const side = (name, s, type) => [
    type, name, `${s.successful}/${s.attempts}`,
    s.sampleCount && s.lossPercent !== null ? `${f(s.lossPercent, 2, '%')} (${range(s.lossInterval95, 2)})` : '-',
    s.medianMs !== null ? f(s.medianMs, 1, ' ms') : f(s.medianValue, 1, ` ${s.unit ?? ''}`),
    s.p95Ms !== null ? f(s.p95Ms, 1, ' ms') : '-',
  ];
  const control = t => r.controls.find(c => c.type === t);
  return `# Phone against baseline

A different device on the same network: a plausibility check, not same-device ground truth.
No pass or fail limits are applied.

## Can these runs be compared?

${r.flags.length ? r.flags.map(x => `- ${x}`).join('\n') : '- No problems found.'}

Overlap: ${f(r.comparability.overlapMinutes, 1)} minutes.

## Results

${table(['Measurement', 'Source', 'Succeeded', 'Loss (95% interval)', 'Median', 'p95'], types.flatMap(t => [side('phone', r.phone[t], t), side('baseline', r.baseline[t], t)]))}

Loss intervals treat probes as independent. Losses cluster in time, so the true uncertainty is wider.
Attempts interrupted by a clock gap are excluded from timing.

## Same minute, phone minus baseline

${table(['Measurement', 'Pairs', 'Same target', 'Median difference', 'Middle half', 'Limits of agreement'], Object.entries(r.paired).map(([t, v]) => [t, v.pairs, t === 'icmp_burst' ? v.sameTargetPairs : '-', f(v.medianDifferenceMs, 1, ' ms'), range(v.middleHalfMs), range(v.limitsOfAgreementMs)]))}

Positive means the phone reported a larger value. Each pair is two burst medians at most 45 s apart.

## Is UDP slow, or is the server far away?

${table(['Path', 'Median', 'p95'], [
    ['Phone UDP to lab', f(r.phone.udp_echo?.medianMs, 1, ' ms'), f(r.phone.udp_echo?.p95Ms, 1, ' ms')],
    ['Baseline UDP to lab', f(r.baseline.udp_echo?.medianMs, 1, ' ms'), f(r.baseline.udp_echo?.p95Ms, 1, ' ms')],
    ['Control ICMP to lab', f(control('control_icmp')?.medianMs, 1, ' ms'), f(control('control_icmp')?.p95Ms, 1, ' ms')],
    ['Control TCP to probe server (with lookup)', f(control('control_tcp')?.medianMs, 1, ' ms'), f(control('control_tcp')?.p95Ms, 1, ' ms')],
  ])}

If all rows are close, the delay is the path to the server. If only the phone row is high, suspect the phone's UDP library.
If both UDP rows are high but the controls are not, suspect UDP handling on the path or server.

## Where is packet loss?

${table(['Path', 'Answered', 'Loss (95% interval)', 'Median'], [
    ['Baseline to local router', control('control_gateway')],
    ['Baseline to Google', r.baseline.icmp_burst],
    ['Baseline to lab, ICMP', control('control_icmp')],
    ['Baseline to lab, UDP', r.baseline.udp_echo],
    ['Phone to Google', r.phone.icmp_burst],
    ['Phone to lab, UDP', r.phone.udp_echo],
  ].map(([name, s]) => [name, s ? `${s.replies}/${s.sampleCount}` : '-', s && s.lossPercent !== null ? `${f(s.lossPercent, 2, '%')} (${range(s.lossInterval95, 2)})` : '-', f(s?.medianMs, 1, ' ms')]))}

If the router row loses about as much as the rest, suspect the Wi-Fi or this computer. If the router row is clean, the loss is beyond it.
Routers may give pings to themselves low priority, so loss or delay at the router alone is not proof of a Wi-Fi fault.

## Controlled transfers

${table(['Source', 'Direction', 'Outcome', 'Mbps', 'Seconds', 'Headers after', 'DNS / connect / TLS'], ['phone', 'baseline'].flatMap(role => r.transfers[role].map(x => [role, x.type, x.success ? 'ok' : x.errorType, f(x.mbps, 2), f(x.seconds), f(x.headersSeconds, 1, ' s'), x.phasesMs ? [x.phasesMs.dns, x.phasesMs.connect, x.phasesMs.tls].map(v => f(v, 0)).join(' / ') + ' ms' : '-'])))}

Phase times are cumulative from the start of the request.

## Scheduling (actual minus planned start)

${table(['Measurement', 'Phone median / p95 / max', 'Baseline median / p95 / max'], types.map(t => [t, ...['phone', 'baseline'].map(s => ['medianMs', 'p95Ms', 'maxMs'].map(k => f(r.scheduling[t][s][k], 0)).join(' / ') + ' ms')]))}
`;
}

export async function readInputs(inputs) {
  const result = [];
  for (const input of inputs) {
    const info = await stat(input);
    const files = info.isDirectory()
      ? (await readdir(input)).filter(n => n.endsWith('.json')).map(n => path.join(input, n))
      : [input];
    for (const file of files) {
      const value = JSON.parse(await readFile(file, 'utf8'));
      // A run summary has a numeric `segments` count, so only arrays are lists of sessions.
      const list = [value, value.sessions, value.segments].find(Array.isArray) ?? [value];
      const sessions = list.filter(v => v?.session?.id && Array.isArray(v.measurements));
      // Directories can hold other JSON; a file named explicitly must be usable.
      if (!sessions.length && !info.isDirectory()) throw new Error(`No session evidence in ${file}`);
      result.push(...sessions);
    }
  }
  return result;
}
async function main() {
  const { values: v } = parseArgs({
    options: { phone: { type: 'string', multiple: true }, baseline: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (v.help || !v.phone?.length || !v.baseline || !v.out) {
    console.log('Usage: npm run baseline:compare -- --phone EXPORT_OR_FOLDER [--phone ...] --baseline build/baseline/RUN --out NEW_FOLDER');
    if (!v.help) process.exitCode = 1;
    return;
  }
  const phone = loadSessions(await readInputs(v.phone), 'phone');
  const baseline = loadSessions((await readInputs([v.baseline])).filter(isBaseline), 'baseline');
  const readOptional = async (name, fallback) => (existsSync(path.join(v.baseline, name)) ? JSON.parse(await readFile(path.join(v.baseline, name), 'utf8')) : fallback);
  const { measurements: controls } = await readOptional('control.json', { measurements: [] });
  const { environment } = await readOptional('run.json', { environment: {} });
  const result = compare(phone, baseline, controls, environment);
  await mkdir(v.out, { recursive: true });
  // Never overwrite an earlier report.
  await writeFile(path.join(v.out, 'comparison.json'), JSON.stringify(result, null, 1), { flag: 'wx' });
  await writeFile(path.join(v.out, 'comparison.md'), markdown(result), { flag: 'wx' });
  for (const flag of result.flags) console.log(`  warning: ${flag}`);
  console.log(`Wrote ${path.join(v.out, 'comparison.md')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });

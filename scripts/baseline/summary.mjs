import { measurementOutcome } from '../../src/measurements/outcome.ts';
/** Aggregates shared by the run summary and the phone comparison. */
import { latencySummary } from '../../src/measurements/statistics.ts';

export const SUMMARY_SCHEMA = 'skymeasure-baseline-1';
export const PROBE_TYPES = [
  'icmp_burst',
  'udp_echo',
  'control_icmp',
  'control_gateway',
];

export const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
export const median = values =>
  latencySummary(values.map((rttMs, sequence) => ({ rttMs, sequence })))
    .medianMs;

/** 95% Wilson interval, in percent. Treats probes as independent, which bursts are not. */
export function wilson(failures, total) {
  if (!total) return null;
  const z = 1.96;
  const p = failures / total;
  const d = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / d;
  const half =
    (z / d) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

export const usable = m => m.scheduling?.timingValid !== false;

/** Field names match the dashboard's TripSummary protocols; extra fields are additive. */
export function protocolSummary(type, all) {
  const rows = all.filter(m => m.type === type);
  const timed = rows.filter(usable);
  const samples = timed.flatMap(m => m.details?.samples ?? []);
  const burst = PROBE_TYPES.includes(type);
  const rtts = samples
    .map(s => s.rttMs)
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const values = timed
    .filter(m => m.success && typeof m.value === 'number')
    .map(m => m.value)
    .sort((a, b) => a - b);
  const separateTargets =
    type === 'cdn_fetch' ||
    (type === 'traceroute' &&
      new Set(rows.map(m => m.targetId ?? m.targetHost)).size > 1);
  // Loss counts only probes that were sent and then answered or timed out.
  const outcomes = samples.filter(
    s => s.errorType === 'timeout' || typeof s.rttMs === 'number',
  );
  const lost = outcomes.filter(s => typeof s.rttMs !== 'number').length;
  return {
    type,
    attempts: rows.length,
    successful: rows.filter(m => m.success).length,
    failed: rows.filter(m => measurementOutcome(m) === 'failure').length,
    interrupted: rows.filter(m => measurementOutcome(m) === 'interrupted')
      .length,
    timeouts: rows.filter(m => m.errorType === 'timeout').length,
    capped: 0,
    timingExcluded: rows.length - timed.length,
    incompleteBursts: burst
      ? rows.filter(m => m.details && !m.details.complete).length
      : 0,
    reached: rows.filter(m => m.route?.reached).length,
    sampleCount: samples.length,
    replies: rtts.length,
    medianMs: burst || /tcp/.test(type) ? median(rtts) : null,
    p95Ms: burst || /tcp/.test(type) ? quantile(rtts, 0.95) : null,
    lossPercent:
      burst && outcomes.length ? (100 * lost) / outcomes.length : null,
    lossInterval95: burst ? wilson(lost, outcomes.length) : null,
    unit: rows.find(m => m.unit)?.unit ?? null,
    // CDN completion times belong to different providers. Use target-aware paper summaries.
    medianValue: separateTargets ? null : median(values),
    minValue: separateTargets ? null : values[0] ?? null,
    maxValue: separateTargets ? null : values[values.length - 1] ?? null,
    methods: [...new Set(rows.map(m => m.method))],
  };
}
export const summarize = measurements =>
  [...new Set(measurements.map(m => m.type))]
    .sort()
    .map(type => protocolSummary(type, measurements));

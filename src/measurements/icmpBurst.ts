import { runIcmp } from './icmp';
import { ICMP_SAMPLE_COUNT, SAMPLE_INTERVAL_MS } from './diagnosticConfig';
import { latencySummary, pause } from './statistics';
import type { Measurement, ProbeSample } from './types';

export async function runIcmpBurst(
  attempt: Measurement,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
  probe = runIcmp,
): Promise<Measurement> {
  const started = performance.now();
  const samples: ProbeSample[] = [];
  for (
    let sequence = 0;
    sequence < ICMP_SAMPLE_COUNT && !signal.aborted;
    sequence++
  ) {
    const timestamp = new Date().toISOString();
    const result = await probe(
      attempt,
      host,
      Math.min(timeoutMs, 2000),
      signal,
    );
    samples.push({
      sequence,
      timestamp,
      rttMs: result.value,
      errorType: result.errorType,
      ttl: result.ttl,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage,
      raw: result.raw,
    });
    if (sequence + 1 < ICMP_SAMPLE_COUNT) {
      await pause(SAMPLE_INTERVAL_MS, signal);
    }
  }
  const summary = latencySummary(samples);
  const complete = !signal.aborted && samples.length === ICMP_SAMPLE_COUNT;
  const validOutcomes = samples.every(
    s => s.errorType === null || s.errorType === 'timeout',
  );
  const success = complete && validOutcomes && summary.replies > 0;
  return {
    ...attempt,
    timestamp: samples[0]?.timestamp ?? attempt.timestamp,
    method: 'icmp_echo_burst',
    targetHost: host,
    durationMs: performance.now() - started,
    value: success ? summary.medianMs : null,
    success,
    errorType: signal.aborted
      ? 'cancelled'
      : success
      ? null
      : validOutcomes
      ? 'timeout'
      : 'network',
    errorMessage: success
      ? null
      : 'ICMP burst incomplete or unavailable; missing replies do not establish an internet outage.',
    transferredBytes: null,
    details: {
      protocolVersion: 1,
      samples,
      summary,
      requestedCount: ICMP_SAMPLE_COUNT,
      complete,
      nonResponsePercent:
        complete && validOutcomes
          ? (100 * (ICMP_SAMPLE_COUNT - summary.replies)) / ICMP_SAMPLE_COUNT
          : null,
    },
  };
}

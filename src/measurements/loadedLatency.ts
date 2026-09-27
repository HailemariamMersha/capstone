import { runProbe } from './runProbe';
import {
  BASELINE_SAMPLE_COUNT,
  LOADED_SAMPLE_LIMIT,
  SAMPLE_INTERVAL_MS,
} from './diagnosticConfig';
import { latencySummary, pause } from './statistics';
import type { Measurement, ProbeConfig, ProbeSample } from './types';

/** Bounded HTTP transfer with intentionally concurrent HTTP latency probes. */
export async function runLoadedLatency(
  attempt: Measurement,
  config: ProbeConfig,
  signal: AbortSignal,
  probe = runProbe,
): Promise<Measurement> {
  const started = performance.now();
  const baselineSamples: ProbeSample[] = [];
  const samples: ProbeSample[] = [];
  const sample = (m: Measurement, sequence: number): ProbeSample => ({
    sequence,
    timestamp: m.timestamp,
    rttMs: m.success ? m.value : null,
    errorType: m.errorType,
  });
  for (let i = 0; i < BASELINE_SAMPLE_COUNT && !signal.aborted; i++) {
    baselineSamples.push(
      sample(await probe('http_rtt', config, attempt.sessionId, signal), i),
    );
  }
  let load: Measurement | undefined;
  let loadFinishedAt = Infinity;
  const loadAbort = new AbortController();
  const cancel = () => loadAbort.abort();
  signal.addEventListener('abort', cancel);
  if (signal.aborted) {
    cancel();
  }
  try {
    if (!signal.aborted) {
      const transfer = probe(
        attempt.type === 'loaded_download' ? 'download' : 'upload',
        config,
        attempt.sessionId,
        signal,
      );
      // Upload preparation happens synchronously inside runProbe before this point.
      const loadStartedAt = performance.now();
      const completed = transfer.then(result => {
        load = result;
        loadFinishedAt = performance.now();
        loadAbort.abort();
      });
      try {
        for (
          let i = 0;
          i < LOADED_SAMPLE_LIMIT && !loadAbort.signal.aborted;
          i++
        ) {
          const sampleStartedAt = performance.now();
          const result = await probe(
            'http_rtt',
            config,
            attempt.sessionId,
            loadAbort.signal,
          );
          const sampleFinishedAt = performance.now();
          // Only fully overlapping samples enter the loaded statistics. A transfer
          // that finishes too quickly produces insufficient data, never idle RTT.
          if (
            sampleStartedAt >= loadStartedAt &&
            sampleFinishedAt <= loadFinishedAt &&
            !loadAbort.signal.aborted
          ) {
            samples.push(sample(result, i));
          }
          await pause(SAMPLE_INTERVAL_MS, loadAbort.signal);
        }
      } finally {
        await completed;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  const summary = latencySummary(samples);
  const success = !signal.aborted && !!load?.success && summary.replies > 0;
  return {
    ...attempt,
    method: 'http_loaded_latency_bounded_transfer',
    durationMs: performance.now() - started,
    success,
    value: success ? summary.medianMs : null,
    errorType: signal.aborted
      ? 'cancelled'
      : success
      ? null
      : load?.errorType ?? 'invalid_response',
    errorMessage: success
      ? null
      : signal.aborted
      ? 'Loaded-latency test cancelled.'
      : !load?.success
      ? 'Load transfer failed.'
      : 'Transfer finished without a complete overlapping latency sample; use a larger payload or a slower link.',
    transferredBytes: null,
    details: {
      protocolVersion: 1,
      samples,
      summary,
      baselineSamples,
      baselineSummary: latencySummary(baselineSamples),
      load,
      loadedOverlapCount: summary.replies,
      complete: !signal.aborted && !!load?.success,
    },
  };
}

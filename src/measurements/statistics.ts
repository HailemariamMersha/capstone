import type { LatencySummary, ProbeSample } from './types';

export function latencySummary(samples: ProbeSample[]): LatencySummary {
  const values = samples
    .map(s => s.rttMs)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const differences: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.rttMs !== null && b.rttMs !== null && b.sequence === a.sequence + 1) {
      differences.push(Math.abs(b.rttMs - a.rttMs));
    }
  }
  const mid = Math.floor(values.length / 2);
  return {
    replies: values.length,
    medianMs: !values.length
      ? null
      : values.length % 2
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    successiveDifferenceMs: differences.length
      ? differences.reduce((sum, v) => sum + v, 0) / differences.length
      : null,
  };
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
    if (signal.aborted) {
      finish();
    }
  });
}

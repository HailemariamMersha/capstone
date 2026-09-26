import { runProbe } from './runProbe';
import type { Measurement, ProbeConfig, HttpProbeType } from './types';

/** Sequential on-demand rounds; scheduling and background execution belong to M3/M5. */
export async function runSuite(
  config: ProbeConfig,
  sessionId: string,
  rounds: number,
  signal: AbortSignal,
  onResult: (result: Measurement) => void,
): Promise<void> {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
    throw new Error('Choose between 1 and 10 rounds.');
  }
  for (let round = 0; round < rounds && !signal.aborted; round++) {
    for (const type of ['http_rtt', 'download', 'upload'] as HttpProbeType[]) {
      if (signal.aborted) {
        return;
      }
      const result = await runProbe(type, config, sessionId, signal);
      onResult(result);
    }
  }
}

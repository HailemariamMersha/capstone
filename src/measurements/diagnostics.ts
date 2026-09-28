import { runIcmpBurst } from './icmpBurst';
import { runTcpConnect } from './tcp';
import { runUdpEcho } from './udp';
import { runLoadedLatency } from './loadedLatency';
import { runTraceroute } from './traceroute';
import type { Measurement } from './types';
import type { MeasurementConfig } from '../sessions/types';

export async function runDiagnostic(
  attempt: Measurement,
  config: MeasurementConfig,
  signal: AbortSignal,
): Promise<Measurement> {
  switch (attempt.type) {
    case 'traceroute':
      return runTraceroute(attempt, config, signal);
    case 'icmp_burst':
      return runIcmpBurst(attempt, config.icmpHost!, config.timeoutMs, signal);
    case 'tcp_connect':
      return runTcpConnect(attempt, config.serverUrl, config.timeoutMs, signal);
    case 'udp_echo':
      return runUdpEcho(
        attempt,
        config.udpHost!,
        config.udpPort!,
        config.timeoutMs,
        signal,
      );
    case 'loaded_download':
    case 'loaded_upload':
      return runLoadedLatency(attempt, config, signal);
    default:
      throw new Error(`Unsupported diagnostic: ${attempt.type}`);
  }
}

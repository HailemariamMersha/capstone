import { runIcmpBurst } from './icmpBurst';
import { runTcpConnect } from './tcp';
import { runUdpEcho } from './udp';
import { runLoadedLatency } from './loadedLatency';
import { runPacketTrace, runPacketTcp, runPacketUdp } from './packet';
import { Platform } from 'react-native';
import type { Measurement } from './types';
import type { MeasurementConfig } from '../sessions/types';

export async function runDiagnostic(
  attempt: Measurement,
  config: MeasurementConfig,
  signal: AbortSignal,
): Promise<Measurement> {
  switch (attempt.type) {
    case 'traceroute':
      return runPacketTrace(attempt, config, signal);
    case 'icmp_burst':
      return runIcmpBurst(attempt, config.icmpHost!, config.timeoutMs, signal);
    case 'tcp_connect': {
      const target = config.tcpServerUrl ?? config.serverUrl;
      return (Platform.OS === 'android' ? runPacketTcp : runTcpConnect)(
        { ...attempt, probeServer: target },
        target,
        config.timeoutMs,
        signal,
      );
    }
    case 'udp_echo':
      return (Platform.OS === 'android' ? runPacketUdp : runUdpEcho)(
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

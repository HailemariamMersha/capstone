import type { MeasurementConfig } from '../sessions/types';
import type { ProbeType } from './types';

export const ICMP_SAMPLE_COUNT = 10;
export const SAMPLE_INTERVAL_MS = 250;
export const UDP_SAMPLE_COUNT = 20;
export const UDP_PACKET_BYTES = 128;
export const BASELINE_SAMPLE_COUNT = 3;
export const LOADED_SAMPLE_LIMIT = 20;

/** Planned application payload; excludes IP/transport headers and retransmissions. */
export function requestedPayload(
  type: ProbeType,
  config: MeasurementConfig,
): number {
  switch (type) {
    case 'speedchecker_latency':
      return 0;
    case 'speedchecker_download':
    case 'speedchecker_upload':
      return 50000000;
    case 'traceroute':
      return (config.tracerouteMaxHops ?? 20) * 3 * 32 * 2;
    case 'ndt7_download':
    case 'ndt7_upload':
      return config.referenceByteThreshold ?? 0;
    case 'http_rtt':
      return 4;
    case 'icmp_rtt':
      return 64;
    case 'icmp_burst':
      return ICMP_SAMPLE_COUNT * 64 * 2;
    case 'tcp_connect':
      return 0;
    case 'udp_echo':
      return UDP_SAMPLE_COUNT * UDP_PACKET_BYTES * 2;
    case 'download':
      return config.downloadBytes;
    case 'upload':
      return config.uploadBytes;
    case 'loaded_download':
      return (
        config.downloadBytes + (BASELINE_SAMPLE_COUNT + LOADED_SAMPLE_LIMIT) * 4
      );
    case 'loaded_upload':
      return (
        config.uploadBytes + (BASELINE_SAMPLE_COUNT + LOADED_SAMPLE_LIMIT) * 4
      );
  }
}

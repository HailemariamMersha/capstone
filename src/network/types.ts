/** Nullable context is intentional: network/location permissions must not block probes. */
export interface NetworkSnapshot {
  flightEvidence?: import('../trips/model').Evidence;
  popCode?: string | null;
  reverseDns?: string | null;
  id: string;
  timestamp: string;
  type: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
  isConnected: boolean | null;
  ssid: string | null;
  bssid: string | null;
  publicIp: string | null;
  asn: number | null;
  batteryPercent?: number | null;
  isCharging?: boolean | null;
  isInternetReachable?: boolean | null;
  signalStrength?: number | null;
  publicIpObservedAt?: string | null;
  contextError?: string | null;
}

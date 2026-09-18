/** Nullable context is intentional: network/location permissions must not block probes. */
export interface NetworkSnapshot {
  id: string;
  timestamp: string;
  type: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
  isConnected: boolean | null;
  ssid: string | null;
  bssid: string | null;
  publicIp: string | null;
  asn: number | null;
}

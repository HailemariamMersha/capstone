import NetInfo from '@react-native-community/netinfo';
import DeviceInfo from 'react-native-device-info';
import type { NetworkSnapshot } from './types';

// Do not generate extra reachability traffic to a third-party server.
NetInfo.configure({
  useNativeReachability: true,
  reachabilityShouldRun: () => false,
});
export function createContextCollector(serverUrl: string) {
  let state: Awaited<ReturnType<typeof NetInfo.fetch>> | undefined;
  let fingerprint = '';
  let changed = true;
  let publicIp: string | null = null;
  let asn: number | null = null;
  let observedAt: string | null = null;
  let lastIdentity = 0;
  let notify = () => {};
  const unsubscribe = NetInfo.addEventListener(next => {
    state = next;
    const details = next.details as {
      ssid?: string;
      bssid?: string;
      ipAddress?: string;
      cellularGeneration?: string;
    } | null;
    const key = JSON.stringify([
      next.type,
      next.isConnected,
      details?.ssid,
      details?.bssid,
      details?.ipAddress,
      details?.cellularGeneration,
    ]);
    if (key !== fingerprint) {
      fingerprint = key;
      changed = true;
      publicIp = null;
      asn = null;
      observedAt = null;
      notify();
    }
  });
  return {
    stop: unsubscribe,
    onChange(callback: () => void) {
      notify = callback;
      return () => {
        notify = () => {};
      };
    },
    async sample(): Promise<{ snapshot: NetworkSnapshot; changed: boolean }> {
      const wasChanged = changed;
      changed = false;
      let contextError: string | null = null;
      try {
        state ??= await NetInfo.fetch();
      } catch {
        contextError = 'Network state unavailable.';
      }
      const [battery, charging] = await Promise.all([
        DeviceInfo.getBatteryLevel().catch(() => -1),
        DeviceInfo.isBatteryCharging().catch(() => null),
      ]);
      if (wasChanged || Date.now() - lastIdentity > 5 * 60000) {
        lastIdentity = Date.now();
        publicIp = null;
        asn = null;
        observedAt = null;
        const identityFingerprint = fingerprint;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const response = await fetch(`${serverUrl}/api/v1/context`, {
            signal: controller.signal,
            headers: { 'Cache-Control': 'no-cache' },
          });
          if (
            !response.ok ||
            response.headers.get('X-Capstone-Probe') !== '1'
          ) {
            throw new Error('Context endpoint unavailable.');
          }
          const data = await response.json();
          if (identityFingerprint !== fingerprint) {
            throw new Error('Network changed during identity lookup.');
          }
          publicIp = typeof data.publicIp === 'string' ? data.publicIp : null;
          asn = Number.isInteger(data.asn) ? data.asn : null;
          observedAt = new Date().toISOString();
        } catch {
          contextError = 'Server network identity unavailable.';
        } finally {
          clearTimeout(timer);
        }
      }
      const details = state?.details as {
        ssid?: string;
        bssid?: string;
        strength?: number;
      } | null;
      const type = state?.type;
      return {
        changed: wasChanged,
        snapshot: {
          id: '',
          timestamp: new Date().toISOString(),
          type:
            type === 'wifi' ||
            type === 'cellular' ||
            type === 'ethernet' ||
            type === 'none'
              ? type
              : 'unknown',
          isConnected: state?.isConnected ?? null,
          isInternetReachable: state?.isInternetReachable ?? null,
          ssid: details?.ssid ?? null,
          bssid: details?.bssid ?? null,
          signalStrength: details?.strength ?? null,
          publicIp,
          asn,
          publicIpObservedAt: observedAt,
          batteryPercent:
            battery >= 0 && battery <= 1 ? Math.round(battery * 100) : null,
          isCharging: charging,
          contextError,
        },
      };
    },
  };
}

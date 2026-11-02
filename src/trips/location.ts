import Geolocation from '@react-native-community/geolocation';
import type { GpsEvidence } from './model';
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Whitelist at the location boundary: never pass a position object to storage. */
export function derivedFix(
  raw: { coords: Record<string, unknown>; mocked?: boolean; fixAgeMs?: number },
  now: number,
): GpsEvidence {
  const c = raw.coords;
  return {
    observedAt: now,
    altitudeM: c.hasAltitude === true ? finite(c.altitude) : null,
    speedMps: c.hasSpeed === true ? finite(c.speed) : null,
    horizontalAccuracyM: c.hasAccuracy === true ? finite(c.accuracy) : null,
    verticalAccuracyM: finite(c.verticalAccuracy),
    speedAccuracyMps: finite(c.speedAccuracy),
    mocked: raw.mocked !== false,
    ageMs: finite(raw.fixAgeMs),
    altitudeReference: 'WGS84',
  };
}
export function locationFix(signal: AbortSignal): Promise<GpsEvidence | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let watch: number | undefined;
    let finished = false;
    const done = (fix: GpsEvidence | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (watch !== undefined) Geolocation.clearWatch(watch);
      resolve(fix);
    };
    const abort = () => done(null);
    const timer = setTimeout(() => done(null), 10000);
    signal.addEventListener('abort', abort);
    try {
      Geolocation.setRNConfiguration({
        skipPermissionRequests: true,
        locationProvider: 'android',
      });
      watch = Geolocation.watchPosition(
        value =>
          done(
            derivedFix(
              value as unknown as Parameters<typeof derivedFix>[0],
              Date.now(),
            ),
          ),
        () => done(null),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000,
          distanceFilter: 0,
          interval: 1000,
          fastestInterval: 1000,
        },
      );
      if (finished) Geolocation.clearWatch(watch);
    } catch {
      done(null);
    }
  });
}

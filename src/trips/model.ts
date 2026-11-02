/** Versioned research policy. None of these types accepts coordinates. */
export const TRIP_POLICY = {
  version: 'flight-mlab-2026-11-02',
  evaluateMs: 30000,
  uploadMs: 900000,
  maximumMs: 86400000,
  disconnectMs: 600000,
  landingMs: 300000,
  transferBytes: 260 * 1048576,
  diagnosticBytes: 20 * 1048576,
  liveUploadBytes: 20 * 1048576,
  downloadBytes: 5000000,
  uploadBytes: 1000000,
  altitudeM: 3048,
  speedMps: 128.611,
} as const;
export type Confidence = 'unconfirmed' | 'network_only' | 'gps_supported';
export type Phase = 'watching' | 'collecting' | 'paused' | 'finished';
export interface FlightDetails {
  flightNumber?: string;
  departure?: string;
  arrival?: string;
  expectedMinutes?: number;
}
export function flightDetails(input: FlightDetails): FlightDetails {
  const result: FlightDetails = {};
  for (const key of ['flightNumber', 'departure', 'arrival'] as const) {
    if (input[key]?.trim()) result[key] = input[key]!.trim().slice(0, 120);
  }
  if (input.expectedMinutes != null) {
    if (
      !Number.isFinite(input.expectedMinutes) ||
      input.expectedMinutes < 1 ||
      input.expectedMinutes > 1440
    )
      throw new Error(
        'Expected flight length must be between 1 and 1440 minutes.',
      );
    result.expectedMinutes = input.expectedMinutes;
  }
  return result;
}
export interface GpsEvidence {
  observedAt: number;
  altitudeM: number | null;
  speedMps: number | null;
  horizontalAccuracyM: number | null;
  verticalAccuracyM: number | null;
  speedAccuracyMps: number | null;
  mocked: boolean;
  ageMs: number | null;
  altitudeReference: 'WGS84';
}
export interface Signal {
  state: 'positive' | 'negative' | 'unknown';
  observedAt: number | null;
  reason: string;
}
export interface Evidence {
  at: number;
  networkKey: string | null;
  asn: Signal;
  ssid: Signal;
  gps: Signal;
  provider: string | null;
  confidence: Confidence;
  gpsDetails: GpsEvidence | null;
}
export interface Trip {
  uploadedRevision?: number;
  /** Optional for historical trips, which never acquire automatic M-Lab tests. */
  mlab?: {
    consentVersion: string;
    dueAt: number | null;
    reserved: boolean;
    status: string;
  };
  id: string;
  ownerId: string;
  revision: number;
  startedAt: number;
  endedAt: number | null;
  phase: Phase;
  state: 'active' | 'completed' | 'interrupted';
  reason: string | null;
  flight: FlightDetails;
  policy: Omit<typeof TRIP_POLICY, 'version' | 'transferBytes'> & {
    version: string;
    transferBytes: number;
  };
  segmentCount: number;
  firstQualifiedAt: number | null;
  candidateAt: number | null;
  candidateKey: string | null;
  qualifiedKey: string | null;
  disconnectedAt: number | null;
  lowSpeedAt: number | null;
  airborneSeen: boolean;
  evidence: Evidence | null;
  used: { transfers: number; diagnostics: number; uploads: number };
  transferPairs: number;
  nextTransferAt: number | null;
  nextUploadAt: number;
  due: Record<string, number>;
  shadow: boolean;
}
export const PROVIDERS: Record<number, string> = {
  14593: 'Starlink',
  31515: 'Inmarsat',
  22351: 'Intelsat',
  64294: 'Panasonic',
  206433: 'SITA',
  40306: 'ViaSat',
};
const airline =
  /^(QatarWiFi|EmiratesWiFi|FlyFi|EtihadWi-Fi|AirFranceWi-Fi|KLMWiFi)$/i;
const signal = (
  valid: boolean | null,
  at: number | null,
  reason: string,
): Signal => ({
  state: valid == null ? 'unknown' : valid ? 'positive' : 'negative',
  observedAt: at,
  reason,
});
export function evaluate(input: {
  now: number;
  networkKey: string | null;
  ssid: string | null;
  asn: number | null;
  identityAt: number | null;
  identityReason?: string;
  gps: GpsEvidence | null;
}): Evidence {
  const { now, networkKey, gps } = input;
  const identityFresh =
    !!networkKey &&
    input.identityAt != null &&
    now >= input.identityAt &&
    now - input.identityAt <= 120000;
  const provider =
    identityFresh && input.asn != null ? PROVIDERS[input.asn] ?? null : null;
  const asn = signal(
    identityFresh && input.asn != null ? !!provider : null,
    input.identityAt,
    identityFresh && input.asn != null
      ? 'provider_registry'
      : input.identityReason ?? 'identity_unavailable_or_stale',
  );
  const ssid = signal(
    networkKey && input.ssid
      ? airline.test(input.ssid.replace(/^"|"$/g, ''))
      : null,
    networkKey ? now : null,
    'airline_ssid_pattern',
  );
  const gpsValid =
    gps &&
    gps.ageMs != null &&
    now >= gps.observedAt &&
    now - gps.observedAt + gps.ageMs <= 60000 &&
    !gps.mocked &&
    gps.altitudeM != null &&
    gps.speedMps != null &&
    gps.horizontalAccuracyM != null &&
    gps.horizontalAccuracyM <= 200;
  const gs = signal(
    gpsValid
      ? gps.altitudeM! > TRIP_POLICY.altitudeM &&
          gps.speedMps! > TRIP_POLICY.speedMps
      : null,
    gps?.observedAt ?? null,
    gpsValid ? 'WGS84_altitude_and_speed' : 'fix_unavailable_invalid_or_stale',
  );
  const networkMatches =
    Number(asn.state === 'positive') + Number(ssid.state === 'positive');
  return {
    at: now,
    networkKey,
    asn,
    ssid,
    gps: gs,
    provider,
    gpsDetails: gps,
    confidence: !networkKey
      ? 'unconfirmed'
      : gs.state === 'positive' && networkMatches >= 1
      ? 'gps_supported'
      : networkMatches === 2
      ? 'network_only'
      : 'unconfirmed',
  };
}
export function transition(trip: Trip, evidence: Evidence): Trip {
  const t: Trip = { ...trip, evidence };
  const now = evidence.at;
  if (t.phase === 'finished') return t;
  if (t.qualifiedKey && t.qualifiedKey !== evidence.networkKey)
    t.qualifiedKey = null;
  if (evidence.gps.state === 'positive') t.airborneSeen = true;
  if (evidence.confidence !== 'unconfirmed') {
    if (t.candidateKey !== evidence.networkKey || t.candidateAt == null) {
      t.candidateKey = evidence.networkKey;
      t.candidateAt = now;
    }
    if (now - t.candidateAt >= 30000) {
      t.qualifiedKey = evidence.networkKey;
      t.firstQualifiedAt ??= now;
      t.nextTransferAt ??= now + 300000;
    }
  } else {
    t.candidateAt = null;
    t.candidateKey = null;
  }
  if (t.qualifiedKey && t.qualifiedKey === evidence.networkKey) {
    t.phase = 'collecting';
    t.disconnectedAt = null;
  } else {
    t.phase = t.firstQualifiedAt == null ? 'watching' : 'paused';
    if (t.firstQualifiedAt != null) t.disconnectedAt ??= now;
  }
  const g = evidence.gpsDetails;
  const low =
    t.airborneSeen &&
    evidence.gps.state !== 'unknown' &&
    g?.speedMps != null &&
    g.speedMps <= 30;
  t.lowSpeedAt = low ? t.lowSpeedAt ?? now : null;
  const reason =
    now - t.startedAt >= TRIP_POLICY.maximumMs
      ? 'safety_ceiling'
      : t.disconnectedAt != null &&
        now - t.disconnectedAt >= TRIP_POLICY.disconnectMs
      ? 'wifi_unavailable_after_qualification'
      : t.lowSpeedAt != null && now - t.lowSpeedAt >= TRIP_POLICY.landingMs
      ? 'low_speed_after_airborne_evidence'
      : null;
  return reason
    ? { ...t, state: 'completed', phase: 'finished', endedAt: now, reason }
    : t;
}
export function reserve(
  trip: Trip,
  category: keyof Trip['used'],
  bytes: number,
): boolean {
  const cap =
    category === 'transfers'
      ? trip.policy.transferBytes
      : category === 'diagnostics'
      ? TRIP_POLICY.diagnosticBytes
      : TRIP_POLICY.liveUploadBytes;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    trip.used[category] + bytes > cap
  )
    return false;
  trip.used[category] += bytes;
  return true;
}
export function reservePair(trip: Trip, now: number): boolean {
  if (
    trip.nextTransferAt == null ||
    now < trip.nextTransferAt ||
    trip.transferPairs >= 10
  )
    return false;
  const interval = Math.max(
    300000,
    ((trip.flight.expectedMinutes ?? 1440) * 60000) / 10,
  );
  trip.nextTransferAt +=
    (Math.floor((now - trip.nextTransferAt) / interval) + 1) * interval;
  if (!reserve(trip, 'transfers', 6000000)) return false;
  trip.transferPairs++;
  return true;
}

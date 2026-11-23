export type TripRow = {
  id: string;
  participantId: string;
  flight: { flightNumber?: string; departure?: string; arrival?: string };
  startedAt: number;
  endedAt: number | null;
  state: string;
  phase: string;
  reason: string | null;
  provider: string | null;
  groundTest: boolean;
  receivedAt: string;
  firstQualifiedAt: number | null;
  segmentCount: number;
  receivedSegments: number;
  completeSegments: number;
  missingSegments: number;
  receivedRecords: number;
  expectedRegisteredRecords: number;
  measurements: number;
  failures: number;
  interruptions?: number;
  uploadComplete: boolean;
};
export type TripEvent = {
  id: string;
  at: number;
  end?: number;
  kind: string;
  reason?: string;
  provider?: string;
  asnState?: string;
  phase?: string;
  index?: number;
  protocol?: string;
  durationMs?: number;
};
export type TripDetail = TripRow & {
  computedAt: number;
  dataRevision: number;
  summary: import('@/components/trip-measurement-summary').TripSummary;
  events: TripEvent[];
  segments: {
    index: number;
    sessionId: string;
    startedAt: number | null;
    endedAt: number | null;
    uploaded: boolean;
  }[];
  health: {
    observedCollectionMs: number;
    reportedDurationMs: number;
    coverageIsEstimate: boolean;
    gapCount: number;
    gapMs: number;
    uploadRetries: number;
    skippedProbes: number;
    timingExcluded: number;
    powerObservations: {
      at: number;
      percent?: number | null;
      screenInteractive?: boolean;
      deviceIdle?: boolean;
      batteryExempt?: boolean;
    }[];
  };
};
export type Point = {
  outcome?: 'success' | 'failure' | 'interrupted' | 'unavailable';
  interruptions?: number;
  id: string;
  at: number;
  type: string;
  value: number | null;
  success: boolean | null;
  error: string | null;
  target: string | null;
  timingValid: boolean;
  durationMs: number | null;
  bytes: number | null;
  pointCount?: number;
  failures?: number;
};
export type Timeline = {
  computedAt: number;
  series: { type: string; bucketMs: number; points: Point[] }[];
  clock: string;
};
export const label = (kind: string) =>
  ({
    icmp_burst: 'ICMP echo',
    icmp_rtt: 'ICMP echo',
    udp_echo: 'UDP echo',
    tcp_connect: 'TCP connection',
    traceroute: 'Traceroute',
    download: 'Controlled download',
    upload: 'Controlled upload',
    ndt7_download: 'M-Lab download',
    ndt7_upload: 'M-Lab upload',
    http_rtt: 'HTTP latency',
  }[kind] ?? kind.replaceAll('_', ' '));
export const duration = (ms: number | null | undefined) =>
  ms == null
    ? '—'
    : ms < 60000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
export const number = (n: unknown, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—';
export const when = (at: number | string | null | undefined, local = false) =>
  at == null
    ? '—'
    : new Date(at).toLocaleString(undefined, {
        timeZone: local ? undefined : 'UTC',
        hour12: false,
      });

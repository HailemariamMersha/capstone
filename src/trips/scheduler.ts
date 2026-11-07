import type { ProbeType } from '../measurements/types';

export const COLLECTOR_POLICY = {
  version: 'collector-scheduler-2026-11-08',
  toleranceMs: 1000,
  gapMs: 90000,
  timingGapToleranceMs: 2000,
  identityTimeoutMs: 10000,
  identityRetryMs: 15000,
  identityRefreshMs: 60000,
  identityFreshMs: 120000,
  heavySpacingMs: 60000,
  uploadPauseMs: 25000,
} as const;
export const INTERVALS = {
  icmp_burst: 60000,
  udp_echo: 60000,
  tcp_connect: 60000,
  traceroute: 900000,
} as const;
export type ScheduledProbe = keyof typeof INTERVALS;
const offsets: Record<ScheduledProbe, number> = {
  icmp_burst: 1000,
  udp_echo: 10000,
  tcp_connect: 20000,
  traceroute: 60000,
};
export function advance(due: number, now: number, interval: number) {
  return due + Math.max(1, Math.floor((now - due) / interval) + 1) * interval;
}
export function takeDue(due: number, now: number, interval: number) {
  if (now + COLLECTOR_POLICY.toleranceMs < due) return null;
  const next = advance(due, now + COLLECTOR_POLICY.toleranceMs, interval);
  return {
    scheduledAt: next - interval,
    next,
    skipped: Math.max(0, Math.round((next - due) / interval) - 1),
  };
}
export function resetProbes(now: number): Partial<Record<ProbeType, number>> {
  return Object.fromEntries(
    Object.entries(offsets).map(([type, offset]) => [type, now + offset]),
  );
}
export function transferTimeout(bytes: number) {
  // Policy assumption, not a measured capacity: 0.5 Mbps plus 10s setup, capped at 90s.
  return Math.min(
    90000,
    Math.max(30000, 10000 + Math.ceil(((bytes * 8) / 500000) * 1000)),
  );
}
export type SegmentHealth = {
  expected: Record<string, number>;
  started: Record<string, number>;
  completed: Record<string, number>;
  skips: Record<string, number>;
  gaps: number;
  unobservedMs: number;
  maxLatenessMs: number;
};
export function newHealth(): SegmentHealth {
  return {
    expected: {},
    started: {},
    completed: {},
    skips: {},
    gaps: 0,
    unobservedMs: 0,
    maxLatenessMs: 0,
  };
}
export function increment(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

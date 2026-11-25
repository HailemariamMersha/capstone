/** Shared by the phone, generated Android asset and independent baseline. */
export const PAPER_SUITE_VERSION = 'paper-core-v1';
export const PAPER_POLICY_VERSION = 'flight-paper-core-2026-11-25';
export const PAPER_CONSENT_VERSION = 'skymeasure-paper-core-2026-11-25';
export const PAPER_INTERVAL_MS = 900000;
export const PAPER_MAX_LATENESS_MS = 90000;
export const PAPER_CDN_LIMIT = 512 * 1024;
export const PAPER_DNS_LIMIT = 16 * 1024;
export const PAPER_CDN_TIMEOUT_MS = 90000;
export const PAPER_DNS_TIMEOUT_MS = 20000;
export const PAPER_BODY_SHA256 =
  'ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e';
export const PAPER_REGISTRY = {
  version: PAPER_SUITE_VERSION,
  traces: [
    {
      id: 'fixed_ip_control',
      label: 'Fixed IP control',
      host: '142.250.190.238',
      mode: 'literal',
    },
    {
      id: 'google_domain',
      label: 'Google website',
      host: 'google.com',
      mode: 'hostname',
    },
    {
      id: 'facebook_domain',
      label: 'Facebook website',
      host: 'facebook.com',
      mode: 'hostname',
    },
    {
      id: 'cloudflare_dns',
      label: 'Cloudflare DNS address',
      host: '1.1.1.1',
      mode: 'literal',
    },
    {
      id: 'google_dns',
      label: 'Google DNS address',
      host: '8.8.8.8',
      mode: 'literal',
    },
  ],
  cdns: [
    {
      id: 'google',
      label: 'Google CDN',
      url: 'https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js',
    },
    {
      id: 'cloudflare',
      label: 'Cloudflare CDN',
      url: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
    },
    {
      id: 'microsoft',
      label: 'Microsoft Ajax',
      url: 'https://ajax.aspnetcdn.com/ajax/jQuery/jquery-3.6.0.min.js',
    },
    {
      id: 'jsdelivr',
      label: 'jsDelivr',
      url: 'https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js',
    },
    {
      id: 'jquery',
      label: 'jQuery CDN',
      url: 'https://code.jquery.com/jquery-3.6.0.min.js',
    },
  ],
  content: { version: 'jquery-3.6.0', bytes: 89501, sha256: PAPER_BODY_SHA256 },
  resolverDomain: 'test.nextdns.io',
} as const;
export type PaperJobType = 'traceroute' | 'cdn_fetch' | 'dns_resolver';
export interface PaperJob {
  key: string;
  type: PaperJobType;
  targetId: string;
  roundId: string;
  scheduledAt: number;
  timeoutMs: number;
}
export interface PaperSchedule {
  version: typeof PAPER_SUITE_VERSION;
  anchorAt: number;
  roundIndex: number;
  completed: string[];
  lastHeavyEnd?: number;
}
export function paperJobs(anchorAt: number, round: number): PaperJob[] {
  const base = anchorAt + round * PAPER_INTERVAL_MS;
  const roundId = `${anchorAt}:${round}`;
  const job = (
    type: PaperJobType,
    targetId: string,
    offset: number,
    timeoutMs: number,
  ): PaperJob => ({
    key: `${type}:${targetId}`,
    type,
    targetId,
    roundId,
    scheduledAt: base + offset,
    timeoutMs,
  });
  const rotate = <T>(items: readonly T[]) =>
    items.map((_, i) => items[(i + round) % items.length]);
  return [
    job('dns_resolver', 'nextdns', 30000, PAPER_DNS_TIMEOUT_MS),
    ...rotate(PAPER_REGISTRY.traces).map((t, i) =>
      job('traceroute', t.id, 60000 + i * 120000, 45000),
    ),
    ...rotate(PAPER_REGISTRY.cdns).map((t, i) =>
      job('cdn_fetch', t.id, 240000 + i * 120000, PAPER_CDN_TIMEOUT_MS),
    ),
  ];
}
export function newPaperSchedule(anchorAt: number): PaperSchedule {
  return {
    version: PAPER_SUITE_VERSION,
    anchorAt,
    roundIndex: 0,
    completed: [],
  };
}
/** Advance/expire without replaying old rounds; skipped counts stay bounded. */
export function readyPaperJobs(state: PaperSchedule, now: number) {
  const skipped = new Map<string, { job: PaperJob; count: number }>();
  const skip = (job: PaperJob, count = 1) => {
    const old = skipped.get(job.key);
    skipped.set(job.key, { job, count: (old?.count ?? 0) + count });
  };
  const round = Math.max(
    state.roundIndex,
    Math.floor((now - state.anchorAt) / PAPER_INTERVAL_MS),
  );
  if (round > state.roundIndex) {
    for (const job of paperJobs(state.anchorAt, state.roundIndex)) {
      if (!state.completed.includes(job.key)) skip(job);
      if (round - state.roundIndex > 1) skip(job, round - state.roundIndex - 1);
    }
    state.roundIndex = round;
    state.completed = [];
  }
  const ready: PaperJob[] = [];
  for (const job of paperJobs(state.anchorAt, state.roundIndex)) {
    if (state.completed.includes(job.key)) continue;
    if (now > job.scheduledAt + PAPER_MAX_LATENESS_MS) {
      state.completed.push(job.key);
      skip(job);
    } else if (job.scheduledAt <= now + 1000) ready.push(job);
  }
  return {
    ready: ready.sort((a, b) => a.scheduledAt - b.scheduledAt),
    skipped: [...skipped.values()],
  };
}

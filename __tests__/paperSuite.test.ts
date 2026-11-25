import {
  PAPER_REGISTRY,
  PAPER_CDN_LIMIT,
  PAPER_INTERVAL_MS,
  newPaperSchedule,
  readyPaperJobs,
  paperJobs,
  PAPER_POLICY_VERSION,
} from '../src/measurements/paperSuite';
import {
  PAPER_TRIP_POLICY,
  reserveContent,
  settleContent,
  reservePair,
  type Trip,
} from '../src/trips/model';

test('five distinct trace controls and identical versioned CDN objects', () => {
  expect(PAPER_REGISTRY.traces.map(t => t.host)).toEqual([
    '142.250.190.238',
    'google.com',
    'facebook.com',
    '1.1.1.1',
    '8.8.8.8',
  ]);
  expect(new Set(PAPER_REGISTRY.cdns.map(t => t.url)).size).toBe(5);
  expect(PAPER_REGISTRY.content.bytes).toBe(89501);
});
test.each([14, 24])(
  '%i-hour healthy schedule has exactly one attempt per target per round',
  hours => {
    const state = newPaperSchedule(1000),
      attempts = new Set<string>();
    let skips = 0;
    for (let now = 1000; now < 1000 + hours * 3600000; now += 1000) {
      const next = readyPaperJobs(state, now);
      skips += next.skipped.reduce((n, s) => n + s.count, 0);
      for (const job of next.ready) {
        expect(attempts.has(job.roundId + job.key)).toBe(false);
        attempts.add(job.roundId + job.key);
        state.completed.push(job.key);
      }
    }
    expect(skips).toBe(0);
    expect(attempts.size).toBe(hours * 4 * 11);
  },
);
test('rotation counterbalances every target position without changing literal addresses', () => {
  const first = Array.from(
    { length: 5 },
    (_, i) => paperJobs(0, i).filter(j => j.type === 'traceroute')[0].targetId,
  );
  expect(new Set(first).size).toBe(5);
});
test('segment pauses preserve completion and expired jobs do not catch up after suspension', () => {
  const state = newPaperSchedule(0);
  const early = readyPaperJobs(state, 30000).ready[0];
  state.completed.push(early.key);
  const saved = JSON.parse(JSON.stringify(state));
  expect(
    readyPaperJobs(saved, 55000).ready.some(j => j.key === early.key),
  ).toBe(false);
  const after = readyPaperJobs(saved, 10 * PAPER_INTERVAL_MS + 10000);
  expect(after.ready).toEqual([]);
  expect(after.skipped.reduce((n, s) => n + s.count, 0)).toBe(109);
  expect(after.skipped.length).toBeLessThanOrEqual(11);
});
test('CDN reservations settle actual or uncertain bytes monotonically and prohibit controlled pairs', () => {
  const t = {
    policy: PAPER_TRIP_POLICY,
    used: { transfers: 0, diagnostics: 0, uploads: 0 },
    nextTransferAt: 0,
    transferPairs: 0,
  } as Trip;
  expect(reservePair(t, 1)).toBe(false);
  expect(t.policy.version).toBe(PAPER_POLICY_VERSION);
  expect(reserveContent(t, 'a', PAPER_CDN_LIMIT)).toBe(true);
  expect(t.used.transfers).toBe(0);
  settleContent(t, 'a', 89501);
  expect(t.used.transfers).toBe(89501);
  expect(reserveContent(t, 'b', PAPER_CDN_LIMIT)).toBe(true);
  settleContent(t, 'b', null);
  expect(t.used.transfers).toBe(89501 + PAPER_CDN_LIMIT);
  settleContent(t, 'b', null);
  expect(t.used.transfers).toBe(89501 + PAPER_CDN_LIMIT);
  t.used.transfers = t.policy.transferBytes - 100;
  expect(reserveContent(t, 'c', PAPER_CDN_LIMIT)).toBe(false);
});

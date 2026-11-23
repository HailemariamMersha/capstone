const {
  batches,
  estimateUploadSizing,
} = require('../scripts/measurements/upload-sizing.cjs');
test('transport model applies both byte and record limits without splitting evidence', () => {
  const records = Array.from({ length: 201 }, (_, i) => ({
    type: 'event',
    id: String(i),
    version: 1,
    payload: { text: 'x' },
  }));
  expect(batches(records).map(b => b.length)).toEqual([200, 1]);
  const big = {
    type: 'measurement',
    id: 'big',
    version: 1,
    payload: { text: 'x'.repeat(600000) },
  };
  expect(batches([big, records[0]])).toEqual([[big], [records[0]]]);
});
test('14/24-hour projections count changed metadata and known acknowledgements', () => {
  const session = {
    id: 's',
    state: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:15:00Z',
    config: {},
  };
  const events = Array.from({ length: 300 }, (_, i) => ({
    id: 'e' + i,
    sessionId: 's',
    kind: 'synthetic',
    details: { missing: null, timeNs: '9999999999999999999', zero: 0 },
  }));
  const result = estimateUploadSizing({
    segments: [{ session, measurements: [], events, snapshots: [] }],
  });
  expect(result.segments[0]).toMatchObject({
    recordCount: 301,
    recordRequests: 2,
    requests: 5,
  });
  expect(result.projections.map(p => p.windows)).toEqual([56, 96]);
  expect(
    result.projections.every(
      p =>
        p.accountedBodyBytes ===
        result.segments[0].accountedBodyBytes * p.windows,
    ),
  ).toBe(true);
  expect(events[0].details).toEqual({
    missing: null,
    timeNs: '9999999999999999999',
    zero: 0,
  });
});

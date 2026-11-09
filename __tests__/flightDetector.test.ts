import {
  evaluate,
  transition,
  reserve,
  reservePair,
  TRIP_POLICY,
  flightDetails,
  type Trip,
  type GpsEvidence,
} from '../src/trips/model';
const initial = (): Trip => ({
  id: 'a'.repeat(32),
  ownerId: 'owner',
  revision: 1,
  startedAt: 0,
  endedAt: null,
  phase: 'watching',
  state: 'active',
  reason: null,
  flight: {},
  policy: TRIP_POLICY,
  segmentCount: 0,
  firstQualifiedAt: null,
  candidateAt: null,
  candidateKey: null,
  qualifiedKey: null,
  disconnectedAt: null,
  lowSpeedAt: null,
  airborneSeen: false,
  evidence: null,
  used: { transfers: 0, diagnostics: 0, uploads: 0 },
  transferPairs: 0,
  nextTransferAt: null,
  nextUploadAt: 900000,
  due: {},
  shadow: false,
});
const evidence = (
  now: number,
  changes: Partial<Parameters<typeof evaluate>[0]> = {},
) =>
  evaluate({
    now,
    networkKey: 'wifi',
    ssid: 'FlyFi',
    asn: 14593,
    identityAt: now,
    gps: null,
    ...changes,
  });
const fix = (now: number, speed = 200): GpsEvidence => ({
  observedAt: now,
  altitudeM: 9000,
  speedMps: speed,
  horizontalAccuracyM: 20,
  verticalAccuracyM: null,
  speedAccuracyMps: null,
  mocked: false,
  ageMs: 0,
  altitudeReference: 'WGS84',
});
test('waiting at home does not run the disconnection timer', () => {
  const t = transition(
    initial(),
    evidence(7200000, { networkKey: null, ssid: null, asn: null }),
  );
  expect(t.phase).toBe('watching');
  expect(t.disconnectedAt).toBeNull();
});
test('two fresh ASN evaluations qualify without SSID or GPS', () => {
  const asnOnly = (at: number) => evidence(at, { ssid: null, gps: null });
  let t = transition(initial(), asnOnly(1000));
  expect(t.firstQualifiedAt).toBeNull();
  t = transition(t, asnOnly(30999));
  expect(t.phase).toBe('watching');
  t = transition(t, asnOnly(31000));
  expect(t.phase).toBe('collecting');
  expect(t.evidence?.confidence).toBe('asn_matched');
  expect(t.detectorPolicy?.version).toBe('asn-only-v1');
  expect(t.nextTransferAt).toBe(331000);
});
test('SSID and GPS cannot replace missing or stale ASN evidence', () => {
  expect(evidence(120001, { ssid: null, identityAt: 0 }).confidence).toBe(
    'unconfirmed',
  );
  expect(evidence(1, { asn: null, ssid: null, gps: fix(1) }).confidence).toBe(
    'unconfirmed',
  );
  expect(evidence(1, { asn: null, gps: fix(1) }).confidence).toBe(
    'unconfirmed',
  );
  expect(evidence(1, { ssid: 'Unrecognized', gps: null }).confidence).toBe(
    'asn_matched',
  );
  for (const patch of [
    { mocked: true },
    { ageMs: 60001 },
    { horizontalAccuracyM: 201 },
    { altitudeM: null },
    { speedMps: null },
  ])
    expect(
      evidence(1, { asn: null, gps: { ...fix(1), ...patch } }).gps.state,
    ).toBe('unknown');
});
test('same-Wi-Fi internet outage retains collection; disconnection ends after grace', () => {
  let t = transition(transition(initial(), evidence(0)), evidence(30000));
  t = transition(t, evidence(200000, { asn: null, ssid: null }));
  expect(t.phase).toBe('collecting');
  t = transition(t, evidence(300000, { networkKey: null }));
  expect(t.phase).toBe('paused');
  t = transition(t, evidence(899999, { networkKey: null }));
  expect(t.phase).toBe('paused');
  t = transition(t, evidence(900000, { networkKey: null }));
  expect(t.reason).toBe('qualifying_network_unavailable_after_qualification');
});
test('GPS speed cannot qualify collection or infer landing under ASN-only policy', () => {
  let t = transition(initial(), evidence(0, { gps: fix(0) }));
  t = transition(t, evidence(30000, { gps: fix(30000, 0) }));
  t = transition(t, evidence(330000, { gps: fix(330000, 0) }));
  expect(t.phase).toBe('collecting');
  expect(t.reason).toBeNull();
  expect(t.airborneSeen).toBe(false);
  expect(
    transition(initial(), evidence(360000, { gps: fix(360000, 0) })).phase,
  ).not.toBe('finished');
});
test('a fresh non-provider ASN pauses collection and requires confirmation again', () => {
  let t = transition(transition(initial(), evidence(0)), evidence(30000));
  t = transition(t, evidence(60000, { asn: 64512 }));
  expect(t.phase).toBe('paused');
  expect(t.qualifiedKey).toBeNull();
  t = transition(t, evidence(90000));
  expect(t.phase).toBe('paused');
  t = transition(t, evidence(120000));
  expect(t.phase).toBe('collecting');
});
test('another network must requalify even when its SSID is identical', () => {
  let t = transition(transition(initial(), evidence(0)), evidence(30000));
  t = transition(t, evidence(60000, { networkKey: 'other-wifi', asn: null }));
  expect(t.phase).toBe('paused');
});
test.each([0, -1, NaN, Infinity, 1.5, 4294967296])(
  'invalid ASN %s remains unknown',
  asn => expect(evidence(1, { asn }).asn.state).toBe('unknown'),
);
test.each([60, 840, 1440])(
  'spreads at most ten transfer reservations across %i minutes without reset',
  minutes => {
    const t = initial();
    t.flight.expectedMinutes = minutes;
    t.nextTransferAt = 300000;
    const times: number[] = [];
    for (let now = 0; now <= 1440 * 60000; now += 30000)
      if (reservePair(t, now)) times.push(now);
    expect(times).toHaveLength(10);
    expect(times[0]).toBe(300000);
    expect(times[9]).toBeGreaterThanOrEqual(minutes * 60000 * 0.9);
    expect(t.used.transfers).toBe(60000000);
    expect(JSON.parse(JSON.stringify(t)).transferPairs).toBe(10);
  },
);
test('missed slots skip catch-up and each allowance is independent', () => {
  const t = initial();
  t.nextTransferAt = 300000;
  expect(reservePair(t, 72000000)).toBe(true);
  expect(reservePair(t, 72000000)).toBe(false);
  expect(reserve(t, 'uploads', 20 * 1048576)).toBe(true);
  expect(reserve(t, 'uploads', 1)).toBe(false);
  expect(reserve(t, 'diagnostics', 1)).toBe(true);
  expect(reserve(t, 'transfers', -1)).toBe(false);
});
test('optional flight details contain only explicit reported fields', () => {
  expect(flightDetails({})).toEqual({});
  expect(() => flightDetails({ expectedMinutes: NaN })).toThrow();
  expect(
    flightDetails({ flightNumber: ' QR 12 ', latitude: 12 } as never),
  ).toEqual({ flightNumber: 'QR 12' });
});
test.each([60, 840, 1440])(
  '300 MiB policy keeps ten controlled pairs after M-Lab reservation for %i minutes',
  minutes => {
    const t = initial();
    t.flight.expectedMinutes = minutes;
    t.nextTransferAt = 300000;
    expect(reserve(t, 'transfers', 200 * 1048576)).toBe(true);
    for (let now = 0; now <= 1440 * 60000; now += 30000) reservePair(t, now);
    expect(t.transferPairs).toBe(10);
    expect(t.used.transfers).toBe(200 * 1048576 + 60000000);
    expect(t.used.transfers).toBeLessThanOrEqual(260 * 1048576);
  },
);
test('historical policy does not silently gain the new M-Lab allowance', () => {
  const t = initial();
  t.policy = {
    ...t.policy,
    version: 'flight-2026-11-01',
    transferBytes: 60 * 1048576,
  };
  expect(reserve(t, 'transfers', 200 * 1048576)).toBe(false);
});

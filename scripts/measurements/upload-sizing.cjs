/* Offline transport sizing only. Original evidence stays local and unchanged. */
const fs = require('node:fs');
const { gzipSync } = require('fflate');
const { Buffer } = require('node:buffer');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const encoded = value => {
  const source = Buffer.from(JSON.stringify(value), 'utf8');
  return source.length < 1024
    ? source.length
    : Math.min(
        source.length,
        gzipSync(source, { level: 1, mtime: 0 }).byteLength,
      );
};
const stamp = row =>
  Date.parse(row.payload.timestamp ?? row.payload.startedAt) || 0;
function batches(records) {
  const result = [];
  let current = [];
  for (const record of records) {
    const next = [...current, record];
    if (
      current.length &&
      (next.length > 200 || bytes({ records: next }) > 512 * 1024)
    ) {
      result.push(current);
      current = [record];
    } else current = next;
  }
  if (current.length) result.push(current);
  return result;
}
function estimateSegment(segment, index) {
  const session = { ...segment.session };
  delete session.ownerId;
  delete session.uploadStatus;
  const record = (type, payload) => ({
    type,
    id: payload.id,
    version: 1,
    payload,
  });
  const rows = [
    record('session', session),
    ...(segment.measurements ?? []).map(m => record('measurement', m)),
    ...(segment.events ?? []).map(e => record('event', e)),
    ...(segment.snapshots ?? []).map(n => record('snapshot', n)),
  ];
  const manifest = {
    session,
    expected: rows.map(({ type, id, version }) => ({ type, id, version })),
    collectorVersion:
      session.config?.collectorVersion ?? 'skymeasure-libraries-2',
    schemaVersion: 3,
  };
  // Count legitimate changed trip metadata once per window, not zero times.
  const trip = segment.trip ?? {};
  const tripResponse = {
    id: trip.id ?? '0'.repeat(32),
    acceptedRevision: trip.revision ?? 1,
    expectedSegments: 96,
    receivedSegments: 96,
    completeSegments: 95,
    uploadComplete: false,
  };
  const arrangements = [
    rows,
    [rows[0], ...rows.slice(1).sort((a, b) => stamp(a) - stamp(b))],
    [
      rows[0],
      ...rows.slice(1).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ],
  ];
  const choices = arrangements.map(order => {
    const packs = batches(order);
    const recordBytes = packs.reduce(
      (sum, batch) =>
        sum +
        encoded({ records: batch }) +
        bytes({
          acknowledged: batch.map(({ type, id, version }) => ({
            type,
            id,
            version,
          })),
        }),
      0,
    );
    return {
      recordRequests: packs.length,
      accountedBodyBytes:
        recordBytes +
        encoded(manifest) +
        bytes({ registered: true }) +
        encoded(trip) +
        bytes(tripResponse) +
        bytes({}) +
        bytes({ complete: true, missing: [] }),
      encodedRecordBytes: packs.reduce(
        (sum, p) => sum + encoded({ records: p }),
        0,
      ),
    };
  });
  const worst = choices.reduce((a, b) =>
    a.accountedBodyBytes >= b.accountedBodyBytes ? a : b,
  );
  const started = Date.parse(session.startedAt),
    ended = Date.parse(session.endedAt);
  return {
    segment: index + 1,
    recordCount: rows.length,
    collectionSeconds: Number.isFinite(ended - started)
      ? (ended - started) / 1000
      : null,
    decodedRecordBytes: bytes({ records: rows }),
    ...worst,
    requests: worst.recordRequests + 3,
  };
}
function estimateUploadSizing(data) {
  const segments = Array.isArray(data.segments)
    ? data.segments
    : data.session
    ? [data]
    : [];
  if (!segments.length)
    throw new Error('Expected a trip export or complete session export');
  const results = segments.map(estimateSegment);
  const full = results.filter(r => r.collectionSeconds >= 12 * 60);
  const representative = full.length ? full : results;
  const worst = Math.max(...representative.map(r => r.accountedBodyBytes));
  return {
    model: 'gzip-v2-200-records-512KiB',
    assumptions: [
      'Exported record versions are unavailable; model uses version 1.',
      'Worst of three record orderings and largest observed full segment repeated per window.',
      'One changed trip PUT, one session manifest and one completion per segment.',
      'Known response-body sizes; no retries, auth traffic, TLS/TCP headers or retransmissions.',
      'This estimates payload accounting, not phone upload speed or carrier billing.',
    ],
    segments: results,
    projections: [14, 24].map(hours => ({
      hours,
      windows: hours * 4,
      accountedBodyBytes: worst * hours * 4,
      allowanceBytes: 20 * 1048576,
      fitsWithoutRetries: worst * hours * 4 <= 20 * 1048576,
    })),
  };
}
module.exports = { estimateUploadSizing, batches };
if (require.main === module) {
  try {
    const at = process.argv.indexOf('--input');
    if (at < 0 || !process.argv[at + 1])
      throw new Error(
        'Usage: npm run uploads:size -- --input <trip-export.json>',
      );
    console.log(
      JSON.stringify(
        estimateUploadSizing(
          JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { csvCell, measurementCsv } from '../src/export/serialize';
test('CSV escapes multiline text, quotes and spreadsheet formulas', () => {
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  expect(csvCell('=1+1')).toBe('"\'=1+1"');
  expect(csvCell(null)).toBe('""');
  expect(csvCell(-3)).toBe('"-3"');
  expect(csvCell('-3+1')).toBe('"\'-3+1"');
  const csv = measurementCsv([
    { id: 'm', success: false, errorMessage: 'offline' },
  ]);
  expect(csv).toContain('"false"');
  expect(csv).toContain('"offline"');
  expect(csv.endsWith('\r\n')).toBe(true);
});

// Parse RFC 4180 independently of the exporter, including quoted multiline cells.
function parseCsv(text) {
  const records = [];
  let record = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      record.push(cell);
      cell = '';
    } else if (!quoted && c === '\r' && text[i + 1] === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      i++;
    } else cell += c;
  }
  const headers = records.shift();
  return records.map(values => {
    expect(values).toHaveLength(headers.length);
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}
const { sessionExportFiles } = require('../src/export/serialize');
test('exports separate samples including failures, baseline and every hop without inventing values', () => {
  const data = {
    session: { id: 's', config: { maxDurationMs: 60000 } },
    events: [
      {
        id: 'e',
        kind: 'session_ended',
        details: { reason: 'Stopped by user.' },
      },
    ],
    snapshots: [{ id: 'n', type: 'wifi', isCharging: false }],
    measurements: [
      {
        id: 'icmp',
        sessionId: 's',
        type: 'icmp_burst',
        networkSnapshot: { id: 'n', type: 'wifi' },
        unknownFutureField: { retained: true },
        details: {
          samples: [
            {
              sequence: 0,
              rttMs: 0,
              ttl: 52,
              errorType: null,
              raw: {
                library: 'ping-react-native',
                version: '2.1.1',
                request: { ttl: 54 },
                callbacks: [{ value: { rawStdout: 'line,"quoted"\nnext\n' } }],
              },
            },
            { sequence: 1, rttMs: null, errorType: 'timeout' },
          ],
          summary: { replies: 1 },
        },
      },
      {
        id: 'trace',
        sessionId: 's',
        type: 'traceroute',
        route: {
          library: 'icmpenguin',
          version: '1.0.0-rc.3',
          samples: [
            {
              hop: 1,
              sequence: 0,
              kind: 'host_unreachable',
              rttMs: 9,
              icmpType: null,
              icmpCode: null,
              rawResult: { variant: 'HostUnreachable', elapsedUsec: 9000 },
            },
            { hop: 2, sequence: 1, kind: 'timeout', rttMs: null },
          ],
        },
      },
      {
        id: 'load',
        type: 'loaded_download',
        details: {
          samples: [{ sequence: 0, rttMs: 30 }],
          baselineSamples: [{ sequence: 0, rttMs: 10 }],
        },
      },
    ],
  };
  const files = Object.fromEntries(
    sessionExportFiles(data).map(f => [f.name, f.content]),
  );
  expect(JSON.parse(files['session.json'])).toEqual({
    ...data,
    exportFormatVersion: 2,
  });
  const samples = parseCsv(files['samples.csv']);
  expect(samples).toHaveLength(6);
  expect(samples[0]).toMatchObject({
    rttMs: '0',
    replyTtl: '52',
    probeTtl: '54',
    networkType: 'wifi',
  });
  expect(JSON.parse(samples[0].rawSampleJson)).toEqual(
    data.measurements[0].details.samples[0],
  );
  expect(samples[1]).toMatchObject({
    rttMs: '',
    errorType: 'timeout',
    libraryVersion: '',
  });
  expect(samples[2]).toMatchObject({
    probeTtl: '1',
    replyTtl: '',
    icmpType: '',
    icmpCode: '',
    nativeVariant: 'HostUnreachable',
    elapsedUsec: '9000',
  });
  expect(samples[5].sampleGroup).toBe('baseline');
  expect(
    JSON.parse(parseCsv(files['measurements.csv'])[0].rawRecordJson),
  ).toEqual(data.measurements[0]);
  expect(parseCsv(files['events.csv'])[0].details).toContain(
    'Stopped by user.',
  );
  expect(parseCsv(files['network-context.csv'])[0].isCharging).toBe('false');
});
test('empty sessions export headers and legacy results remain unchanged in JSON', () => {
  const files = sessionExportFiles({
    session: { id: 'empty' },
    measurements: [],
    events: [],
    snapshots: [],
  });
  expect(parseCsv(files.find(f => f.name === 'samples.csv').content)).toEqual(
    [],
  );
  expect(files).toHaveLength(6);
});

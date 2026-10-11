const {
  analyze,
  outputFiles,
  parseCsv,
  summary,
} = require('../scripts/measurements/analyze.cjs');
const {
  catalog,
  dictionaryMarkdown,
} = require('../scripts/measurements/dictionary.cjs');
const { sessionExportFiles } = require('../src/export/serialize');
const fs = require('node:fs');
const path = require('node:path');
// Deliberately synthetic records: documentation-range IPs, no private experiment data.
function session(measurements = []) {
  return {
    session: {
      id: 's',
      startedAt: '2026-10-07T00:00:00.000Z',
      endedAt: '2026-10-07T00:01:00.000Z',
    },
    measurements,
    events: [],
    snapshots: [],
  };
}
function measurement(type, extra = {}) {
  return {
    id: 'm',
    sessionId: 's',
    type,
    method: 'example',
    success: true,
    value: 0,
    unit: 'ms',
    durationMs: 1,
    timestamp: '2026-10-07T00:00:00.000Z',
    ...extra,
  };
}
const errors = result =>
  result.audit.issues.filter(i => i.severity === 'error');

test('dictionary covers all legacy headers exactly and documentation stays generated', () => {
  const files = sessionExportFiles(session());
  for (const [name, def] of Object.entries(catalog.files)) {
    if (def.kind === 'legacy')
      expect(
        parseCsv(files.find(f => f.name === name).content).headers,
      ).toEqual(def.columns);
    expect(new Set(def.columns).size).toBe(def.columns.length);
    for (const column of def.columns) {
      const field = catalog.fields[column];
      for (const key of [
        'meaning',
        'datatype',
        'units',
        'source',
        'calculation',
        'blank',
      ])
        expect(field[key]).toEqual(expect.any(String));
      expect(field.example).toBeDefined();
      expect(field.applicableFiles).toContain(name);
    }
  }
  expect(
    fs.readFileSync(
      path.join(__dirname, '../docs/measurements/columns.md'),
      'utf8',
    ),
  ).toBe(dictionaryMarkdown());
});

test('zero RTT survives, timeout stays null, formulas respect failed sequence adjacency', () => {
  const samples = [
    { sequence: 0, rttMs: 0, errorType: null },
    { sequence: 1, rttMs: null, errorType: 'timeout' },
    { sequence: 2, rttMs: 10, errorType: null },
    { sequence: 3, rttMs: 20, errorType: null },
  ];
  expect(summary(samples)).toEqual({
    replies: 3,
    medianMs: 10,
    p95Ms: 20,
    successiveDifferenceMs: 10,
  });
  const m = measurement('icmp_burst', {
    value: 10,
    details: {
      samples,
      summary: summary(samples),
      complete: true,
      requestedCount: 4,
      nonResponsePercent: 25,
    },
  });
  const result = analyze(session([m]));
  expect(errors(result)).toEqual([]);
  const csv = parseCsv(outputFiles(result)['icmp.csv']).rows;
  expect(csv[0].rttMs).toBe('0');
  expect(csv[1].rttMs).toBe('');
  expect(csv[1].outcome).toBe('timeout');
});

test('native byte-size mapping gaps and nanosecond strings retain their provenance', () => {
  const s = {
    sequence: 0,
    rttMs: 1,
    packet: {
      engine: 'capstone-linux-sockets',
      payloadBytes: 64,
      sendMonotonicNs: '187009405150837001',
      response: {
        receiveMonotonicNs: '187009405151837001',
        elapsedUs: 1000,
        kernelReceiveRealtimeNs: '1791393334539568298',
      },
    },
  };
  const data = session([
      measurement('icmp_burst', { details: { samples: [s] } }),
    ]),
    original = JSON.stringify(data);
  const result = analyze(data);
  expect(errors(result)).toEqual([]);
  expect(JSON.stringify(data)).toBe(original);
  expect(result.views['icmp.csv'][0]).toMatchObject({
    payloadBytes: 64,
    payloadSizeSource: 'packet.payloadBytes',
    recordPath: '/measurements/0/details/samples/0',
    sendMonotonicNs: '187009405150837001',
  });
  expect(
    result.audit.issues.some(i => i.code === 'legacy_size_mapping_gap'),
  ).toBe(true);
  s.packet.sendMonotonicNs = 187009405150837001;
  expect(
    analyze(data).audit.issues.some(i => i.code === 'nanosecond_string'),
  ).toBe(true);
});

test('historical target aliases are suppressed only in derived ICMP views', () => {
  const p = {
    engine: 'icmpenguin',
    resolvedAddress: '203.0.113.1',
    response: { responderAddress: '203.0.113.1' },
  };
  const data = session([
    measurement('icmp_burst', {
      details: { samples: [{ sequence: 0, rttMs: 2, packet: p }] },
    }),
  ]);
  const result = analyze(data);
  expect(result.views['icmp.csv'][0]).toMatchObject({
    responderAddress: null,
    addressEvidence: 'unavailable_library_target_only',
  });
  expect(p.response.responderAddress).toBe('203.0.113.1');
  expect(
    result.audit.issues.some(i => i.code === 'historical_target_alias'),
  ).toBe(true);
});

test('traceroute labels are not decoded into invented ICMP type/code', () => {
  const data = session([
    measurement('traceroute', {
      value: 1,
      route: {
        library: 'icmpenguin',
        version: '1.0.0-rc.3',
        reached: true,
        reachedHop: 1,
        samples: [
          {
            hop: 1,
            sequence: 0,
            kind: 'host_unreachable',
            rttMs: 3,
            address: '192.0.2.1',
            icmpType: null,
            icmpCode: null,
            rawResult: { variant: 'HostUnreachable' },
          },
        ],
      },
    }),
  ]);
  const result = analyze(data);
  expect(errors(result)).toEqual([]);
  expect(result.views['traceroute.csv'][0]).toMatchObject({
    icmpType: null,
    icmpCode: null,
    responderAddress: '192.0.2.1',
  });
  expect(
    result.audit.issues.some(i => i.code === 'ambiguous_trace_label'),
  ).toBe(true);
});

test('TCP conversions use the same socket snapshot and preserve zero counters', () => {
  const data = session([
    measurement('tcp_connect', {
      value: 21.047,
      packet: {
        engine: 'capstone-linux-sockets',
        tcpInfoAfter: {
          tcpi_rtt: 20414,
          tcpi_rttvar: 10207,
          tcpi_snd_cwnd: 10,
          tcpi_snd_mss: 1238,
          tcpi_total_retrans: 0,
        },
      },
    }),
  ]);
  const result = analyze(data);
  expect(errors(result)).toEqual([]);
  expect(result.views['tcp.csv'][0]).toMatchObject({
    connectDurationMs: 21.047,
    kernelRttMs: 20.414,
    kernelRttVariationMs: 10.207,
    congestionWindowBytesEstimate: 12380,
    tcpTotalRetransmissions: 0,
    timingScope: 'native_connect',
  });
  const lib = analyze(
    session([
      measurement('tcp_connect', {
        value: 27,
        raw: {
          library: 'react-native-tcp-socket',
          version: '6.4.3',
          callbacks: [
            {
              value: {
                event: 'connected',
                remoteAddress: '203.0.113.1',
                localAddress: '192.0.2.1',
                localPort: 1234,
              },
            },
          ],
        },
      }),
    ]),
  );
  expect(lib.views['tcp.csv'][0]).toMatchObject({
    kernelRttMs: null,
    congestionWindowBytesEstimate: null,
    targetAddress: '203.0.113.1',
    timingScope: 'connect_including_resolution_and_callback',
  });
});

test('loaded HTTP uses embedded transfer duration and preserves both sample groups', () => {
  const samples = [{ sequence: 0, rttMs: 20 }],
    baselineSamples = [{ sequence: 0, rttMs: 10 }];
  const data = session([
    measurement('loaded_download', {
      value: 20,
      durationMs: 9000,
      requestedBytes: 900,
      details: {
        samples,
        baselineSamples,
        summary: summary(samples),
        baselineSummary: summary(baselineSamples),
        load: {
          success: true,
          requestedBytes: 1000,
          transferredBytes: 1000,
          durationMs: 100,
          value: 0.08,
          httpStatus: 200,
        },
      },
    }),
  ]);
  const result = analyze(data);
  expect(errors(result)).toEqual([]);
  expect(result.views['http.csv'][0]).toMatchObject({
    transferDurationMs: 100,
    requestedBytes: 1000,
    throughputMbps: 0.08,
    httpLatencyMs: 20,
    baselineMedianMs: 10,
    loadedMedianMs: 20,
  });
  expect(
    result.views['http-latency-samples.csv'].map(s => [
      s.sampleGroup,
      s.httpLatencyMs,
    ]),
  ).toEqual([
    ['probe', 20],
    ['baseline', 10],
  ]);
});

test('detects bad statistics, counts, types, joins and encoding without inventing replacements', () => {
  const m = measurement('icmp_burst', {
    sessionId: 'wrong',
    value: '5',
    success: 'true',
    details: {
      complete: true,
      requestedCount: 3,
      nonResponsePercent: 120,
      summary: {
        replies: 5,
        medianMs: 99,
        p95Ms: 99,
        successiveDifferenceMs: 8,
      },
      samples: [
        {
          sequence: 0,
          rttMs: 5,
          packet: { sendBufferHex: 'zz', sentSocketBytes: 2 },
        },
        { sequence: 0, rttMs: 6 },
      ],
    },
  });
  const result = analyze(session([m, { ...m }]));
  const codes = new Set(errors(result).map(i => i.code));
  for (const code of [
    'measurement_id',
    'session_join',
    'numeric_type',
    'boolean_type',
    'percentage_range',
    'sample_identity',
    'completed_count',
    'hex_encoding',
    'summary_medianMs',
    'loss_formula',
  ])
    expect(codes.has(code)).toBe(true);
});

test('checks retained byte lengths, decoded ICMP fields and same-clock order', () => {
  const p = {
    sendMonotonicNs: '2000',
    sendBufferHex: 'abcd',
    sentSocketBytes: 1,
    response: {
      receiveMonotonicNs: '1000',
      receivedHex: '0000000100020003',
      receivedSocketBytes: 8,
      receivedScope: 'icmp_message',
      icmpType: 8,
      icmpCode: 0,
      icmpChecksum: 1,
      icmpIdentifier: 2,
      icmpSequence: 3,
    },
  };
  const result = analyze(
    session([
      measurement('icmp_burst', {
        details: { samples: [{ sequence: 0, rttMs: 1, packet: p }] },
      }),
    ]),
  );
  const codes = errors(result).map(i => i.code);
  expect(codes).toEqual(
    expect.arrayContaining(['buffer_length', 'icmp_header', 'monotonic_order']),
  );
});

test('incomplete bursts cannot produce validated loss, while zero-reply UDP is a warning', () => {
  const samples = [{ sequence: 0, rttMs: null, errorType: 'timeout' }];
  const data = session([
    measurement('udp_echo', {
      success: false,
      value: null,
      errorType: 'timeout',
      details: {
        complete: false,
        sentCount: 1,
        requestedCount: 20,
        lossPercent: null,
        samples,
        summary: summary(samples),
      },
    }),
  ]);
  const result = analyze(data);
  expect(errors(result)).toEqual([]);
  expect(result.audit.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'loss_formula',
        severity: 'unavailable',
      }),
      expect.objectContaining({ code: 'udp_no_replies', severity: 'warning' }),
    ]),
  );
  expect(result.views['udp.csv'][0].rttMs).toBeNull();
});

test('all outputs are present for empty sessions and JSON shape errors fail clearly', () => {
  const result = analyze(session());
  expect(Object.keys(outputFiles(result))).toHaveLength(9);
  expect(errors(result)).toEqual([]);
  expect(parseCsv(outputFiles(result)['icmp.csv']).rows).toEqual([]);
  expect(() => analyze({ session: { id: 's' }, measurements: [] })).toThrow(
    'complete session',
  );
  expect(() =>
    analyze(
      session([measurement('icmp_burst', { details: { samples: [null] } })]),
    ),
  ).toThrow('Samples must be objects');
});

test('focused CSV escapes spreadsheet formulas and keeps multiline values intact', () => {
  const result = analyze(
    session([measurement('tcp_connect', { targetHost: '=malicious,"\ntext' })]),
  );
  expect(parseCsv(outputFiles(result)['tcp.csv']).rows[0].targetHost).toBe(
    '\'=malicious,"\ntext',
  );
});

test('optional reference tests remain accounted for without inventing packet rows', () => {
  const result = analyze(
    session([measurement('ndt7_download', { value: 10, unit: 'Mbps' })]),
  );
  expect(result.audit.groups.ndt7_download.attempts).toBe(1);
  expect(result.audit.issues.some(i => i.code === 'focused_view')).toBe(true);
  expect(result.views['http.csv']).toHaveLength(0);
});

test('UDP callback payload bytes are validated and truncation is explicit', () => {
  const m = measurement('udp_echo', {
    success: false,
    value: null,
    raw: {
      library: 'react-native-udp',
      callbacks: [
        {
          value: {
            event: 'send_requested',
            payloadBase64: 'AQI=',
            payloadBytes: 4,
          },
        },
        {
          value: {
            event: 'unmatched_datagram',
            payloadBase64: 'AQI=',
            payloadBytes: 10000,
            payloadTruncated: true,
          },
        },
      ],
    },
  });
  const r = analyze(session([m]));
  expect(r.audit.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'callback_payload_length',
        severity: 'error',
      }),
      expect.objectContaining({
        code: 'truncated_callback_payload',
        severity: 'warning',
      }),
    ]),
  );
});

test('CLI writes reports, refuses overwrite, leaves source intact and returns data-error status', () => {
  const { spawnSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'capstone-analysis-'));
  try {
    const input = path.join(dir, 'input.json'),
      out = path.join(dir, 'out');
    const contents = JSON.stringify(session());
    fs.writeFileSync(input, contents);
    const cli = path.resolve(__dirname, '../scripts/measurements/analyze.cjs');
    const run = destination =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          '--input',
          input,
          '--out',
          destination,
        ],
        { encoding: 'utf8' },
      );
    expect(run(out).status).toBe(0);
    const before = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    const second = run(out);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('Output already exists');
    expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toBe(before);
    expect(fs.readFileSync(input, 'utf8')).toBe(contents);
    fs.writeFileSync(
      input,
      JSON.stringify(
        session([measurement('tcp_connect', { sessionId: 'wrong' })]),
      ),
    );
    expect(run(path.join(dir, 'bad-data')).status).toBe(2);
    expect(
      fs.existsSync(path.join(dir, 'bad-data', 'sanity-checks.json')),
    ).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

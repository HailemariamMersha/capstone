/* Compare saved evidence; absence is never converted to a zero measurement. */
const fs = require('node:fs');
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n
    ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
    : null;
};
function summarize(data) {
  if (!data.session?.id || !Array.isArray(data.measurements))
    throw new Error('Expected a complete session JSON export.');
  const ids = new Set();
  const groups = {};
  for (const m of data.measurements) {
    if (!m.id || ids.has(m.id))
      throw new Error('Missing or duplicate measurement ID.');
    ids.add(m.id);
    const g = (groups[m.type] ??= {
      attempts: 0,
      successful: 0,
      errors: {},
      methods: new Set(),
      libraries: new Set(),
      values: [],
      probes: 0,
      samplesWithRtt: 0,
      fields: {
        receivedBytes: 0,
        icmpTypeCode: 0,
        kernelReceiveTimestamp: 0,
        tcpInfo: 0,
        callbackPayloads: 0,
        tcpEndpointCallbacks: 0,
      },
      droppedCallbacks: 0,
    });
    g.attempts++;
    g.successful += Number(m.success === true);
    g.methods.add(m.method ?? 'unrecorded');
    if (!m.success) {
      const key = m.errorType ?? 'unspecified';
      g.errors[key] = (g.errors[key] ?? 0) + 1;
    }
    if (m.success && typeof m.value === 'number') g.values.push(m.value);
    const inspectRaw = raw => {
      if (raw?.library) g.libraries.add(`${raw.library}@${raw.version}`);
      g.droppedCallbacks += raw?.droppedCallbacks ?? 0;
      for (const callback of raw?.callbacks ?? []) {
        const v = callback.value;
        g.fields.callbackPayloads += Number(
          typeof v?.payloadBase64 === 'string',
        );
        g.fields.tcpEndpointCallbacks += Number(
          typeof v?.remoteAddress === 'string' &&
            typeof v?.localAddress === 'string',
        );
      }
    };
    inspectRaw(m.raw);
    const packets = m.packet ? [m.packet] : [];
    const samples = [
      ...(m.details?.samples ?? []),
      ...(m.route?.samples ?? []),
    ];
    g.probes += samples.length;
    g.samplesWithRtt += samples.filter(
      s => typeof s.rttMs === 'number' && Number.isFinite(s.rttMs),
    ).length;
    for (const s of samples) {
      inspectRaw(s.raw);
      if (s.packet) packets.push(s.packet);
    }
    for (const p of packets) {
      if (p.engine)
        g.libraries.add(`${p.engine}@${p.engineVersion ?? 'unrecorded'}`);
      const r = p.response;
      g.fields.receivedBytes += Number(typeof r?.receivedHex === 'string');
      g.fields.icmpTypeCode += Number(
        Number.isInteger(r?.icmpType) && Number.isInteger(r?.icmpCode),
      );
      g.fields.kernelReceiveTimestamp += Number(
        typeof r?.kernelReceiveRealtimeNs === 'string',
      );
      g.fields.tcpInfo += Number(p.tcpInfoAfter != null);
    }
  }
  for (const g of Object.values(groups)) {
    g.methods = [...g.methods];
    g.libraries = [...g.libraries];
    g.medianSuccessfulValue = median(g.values);
    delete g.values;
  }
  const events = data.events ?? [];
  const gaps = events.filter(e => e.kind === 'schedule_gap');
  return {
    sessionId: data.session.id,
    state: data.session.state,
    durationSeconds: data.session.endedAt
      ? (Date.parse(data.session.endedAt) -
          Date.parse(data.session.startedAt)) /
        1000
      : null,
    savedMeasurements: ids.size,
    groups,
    scheduling: {
      delayEvents: gaps.length,
      skippedIntervals: gaps.reduce((n, e) => n + (e.details?.skipped ?? 0), 0),
      maxLateByMs: gaps.length
        ? Math.max(...gaps.map(e => e.details?.lateByMs ?? 0))
        : 0,
    },
    stopReasons: events
      .filter(e => e.kind === 'session_limit')
      .map(e => e.details?.reason),
    networkTypes: [...new Set((data.snapshots ?? []).map(s => s.type))],
  };
}
function compare(custom, library) {
  const a = summarize(custom),
    b = summarize(library);
  const keys = [
    'maxDurationMs',
    'maxPayloadBytes',
    'downloadBytes',
    'uploadBytes',
    'serverUrl',
    'icmpHost',
    'tcpServerUrl',
    'udpHost',
    'udpPort',
    'tracerouteHost',
    'httpEnabled',
    'icmpBurstEnabled',
    'tcpEnabled',
    'loadedLatencyEnabled',
    'rttIntervalMs',
    'downloadIntervalMs',
    'uploadIntervalMs',
    'timeoutMs',
  ];
  const configDifferences = keys
    .filter(
      k =>
        JSON.stringify(custom.session.config?.[k]) !==
        JSON.stringify(library.session.config?.[k]),
    )
    .map(k => ({
      field: k,
      custom: custom.session.config?.[k] ?? null,
      library: library.session.config?.[k] ?? null,
    }));
  return {
    custom: a,
    library: b,
    configDifferences,
    interpretation: [
      'These are separate runs, not a controlled simultaneous network benchmark.',
      'Compare methods and timing scopes before comparing numeric values. Library TCP includes resolution/callback time; custom TCP excludes it.',
      'Field counts show retained evidence, not complete wire packet capture. Zero field counts mean unavailable/unobserved, never zero RTT.',
      'UDP library burst pacing differs from the custom sequential probe implementation.',
      ...(configDifferences.length
        ? ['Configurations differ: this comparison is preliminary.']
        : []),
    ],
  };
}
module.exports = { compare, summarize };
if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    process.stderr.write(
      'Usage: node scripts/compare-packet-engines.cjs CUSTOM_SESSION.json LIBRARY_SESSION.json\n',
    );
    process.exitCode = 1;
  } else
    process.stdout.write(
      JSON.stringify(
        compare(
          JSON.parse(fs.readFileSync(a, 'utf8')),
          JSON.parse(fs.readFileSync(b, 'utf8')),
        ),
        null,
        2,
      ) + '\n',
    );
}

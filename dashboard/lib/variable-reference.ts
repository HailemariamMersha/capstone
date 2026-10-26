import dictionary from '@/public/measurements/columns.json';
export type Field = [string, string, string];
type Definition = {
  datatype: string;
  units: string;
  source: string;
  calculation: string;
  blank: string;
};
const fields = dictionary.fields as Record<string, Definition>;
const aliases: Record<string, string> = {
  target: 'targetHost',
  differenceMs: 'successiveDifferenceMs',
  replies: 'replyCount',
  baselineMs: 'baselineMedianMs',
  loadBytes: 'loadTransferredBytes',
  network: 'networkType',
  signal: 'signalStrength',
  battery: 'batteryPercent',
  protocol: 'measurementType',
  phase: 'sampleGroup',
  address: 'responderAddress',
  parent: 'measurementId',
  observed: 'sampleTimestamp',
  scheduled: 'scheduledAt',
  executed: 'timestamp',
  delayMs: 'durationMs',
};
const sourceOverrides: Record<string, Record<string, string>> = {
  Measurements: {
    type: 'measurement.type',
    value: 'measurement.value',
    unit: 'measurement.unit',
    outcome: 'measurement.success',
    timestamp: 'measurement.timestamp',
    target: 'measurement.targetHost ?? measurement.probeServer',
    durationMs: 'measurement.durationMs',
    method: 'measurement.method',
    id: 'measurement.id',
    transferredBytes: 'measurement.transferredBytes',
    requestedBytes: 'measurement.requestedBytes',
    medianMs: 'measurement.details.summary.medianMs',
    p95Ms: 'measurement.details.summary.p95Ms',
    differenceMs: 'measurement.details.summary.successiveDifferenceMs',
    replies: 'measurement.details.summary.replies',
    lossPercent:
      'measurement.details.lossPercent ?? measurement.details.nonResponsePercent',
    baselineMs: 'measurement.details.baselineSummary.medianMs',
    loadMbps: 'measurement.details.load.value',
    loadBytes: 'measurement.details.load.transferredBytes',
    library: 'measurement.raw.library',
    errorType: 'measurement.errorType',
    network: 'measurement.networkSnapshot.type',
    signal: 'measurement.networkSnapshot.signalStrength',
    battery: 'measurement.networkSnapshot.batteryPercent',
  },
  Samples: {
    protocol: 'parent measurement.type',
    phase: 'details.samples / details.baselineSamples / route.samples',
    sequence: 'sample.sequence',
    rttMs: 'sample.rttMs',
    outcome: 'sample.errorType, sample.kind and sample.rttMs',
    hop: 'sample.hop',
    address: 'sample.address (library result only)',
    kind: 'sample.kind',
    parent: 'parent measurement.id',
    target: 'parent measurement.targetHost ?? parent measurement.probeServer',
    observed: 'sample.timestamp ?? ISO(sample.observedAtMs)',
    errorType: 'sample.errorType',
    replyTtl:
      'sample.replyTtl ?? sample.ttl ?? sample.packet.response.replyTtl',
    probeTtl: 'sample.packet.probeTtl',
    icmpType: 'sample.icmpType ?? sample.packet.response.icmpType',
    icmpCode: 'sample.icmpCode ?? sample.packet.response.icmpCode',
    icmpIdentifier: 'sample.packet.response.icmpIdentifier',
    icmpSequence: 'sample.packet.response.icmpSequence',
    icmpChecksum: 'sample.packet.response.icmpChecksum',
    receivedSocketBytes: 'sample.packet.response.receivedSocketBytes',
    receivedScope: 'sample.packet.response.receivedScope',
    probeBytes: 'sample.probeBytes',
  },
  Scheduling: {
    type: 'measurement.type',
    scheduled: 'measurement.scheduledAt',
    executed: 'measurement.timestamp',
    delayMs:
      'Date.parse(measurement.timestamp) − Date.parse(measurement.scheduledAt)',
  },
};
export function variableDefinition(group: string, key: string): Definition {
  const definition = {
    ...fields[aliases[key] ?? key],
    source: sourceOverrides[group][key],
  };
  if (key === 'outcome')
    return {
      datatype: 'string',
      units: 'none',
      source: definition.source,
      calculation:
        group === 'Measurements'
          ? 'success=true → success; false → failure; absent → unavailable. A burst may succeed with individual timeouts.'
          : 'Explicit timeout → timeout; another error → error; ambiguous traceroute response label or finite nonnegative RTT → response; otherwise unavailable. Response does not prove the destination was reached.',
      blank:
        'Missing evidence is labelled unavailable; it is not success or zero loss.',
    };
  if (key === 'phase')
    definition.calculation =
      'details.samples → probe; details.baselineSamples → baseline; route.samples → traceroute. The full combined CSV calls traceroute samples hop.';
  if (key === 'delayMs')
    definition.calculation =
      'Executed wall-clock milliseconds minus scheduled wall-clock milliseconds. Clock changes can affect this; it is not RTT.';
  if (key === 'value')
    definition.calculation =
      'ICMP/UDP: median valid probe RTT; TCP: connection callback duration; HTTP RTT: full response duration; download/upload: payload bytes × 8 / durationMs / 1000; loaded latency: median overlapping HTTP samples; traceroute: reached-hop result. Always read Unit and Method.';
  if (key === 'lossPercent')
    definition.calculation =
      'UDP: (sentCount − valid unique replies) / sentCount × 100. ICMP: (requestedCount − replies) / requestedCount × 100, only for a complete burst with valid outcomes. An unavailable statistic stays blank.';
  if (key === 'observed')
    definition.calculation =
      'Keep the saved ISO timestamp; otherwise convert observedAtMs from Unix milliseconds to UTC. This is not a kernel timestamp.';
  if (key === 'address')
    definition.calculation =
      'Copy sample.address only; never fill it using the target hostname or resolved destination.';
  return definition;
}
export const measurementFields: Field[] = [
  ['type', 'Measurement type', 'Which test ran.'],
  [
    'value',
    'Result',
    'Interpret with unit and method: burst median, connection duration, HTTP throughput or reached hop.',
  ],
  ['unit', 'Unit', 'ms, Mbps or hops; do not combine unlike units.'],
  [
    'outcome',
    'Overall outcome',
    'A successful burst can still contain individual timeouts.',
  ],
  [
    'timestamp',
    'Collected at (UTC)',
    'Actual measurement start/observation time.',
  ],
  [
    'target',
    'Target',
    'Intended target hostname or endpoint, not necessarily a reply-source address.',
  ],
  [
    'durationMs',
    'Operation duration (ms)',
    'Whole operation, including burst waits or baseline work; not always RTT.',
  ],
  ['method', 'Method', 'How the measurement was performed and timed.'],
  [
    'id',
    'Measurement ID',
    'Joins the parent measurement to individual samples.',
  ],
  [
    'transferredBytes',
    'Transferred bytes',
    'Confirmed application bytes; excludes protocol overhead.',
  ],
  [
    'requestedBytes',
    'Planned payload bytes',
    'Budget reservation; not total wire traffic.',
  ],
  [
    'medianMs',
    'Median latency (ms)',
    'Median of valid samples; loaded tests exclude baseline samples here.',
  ],
  [
    'p95Ms',
    'p95 latency (ms)',
    'Nearest-rank 95th percentile of valid samples.',
  ],
  [
    'differenceMs',
    'Successive difference (ms)',
    'Mean absolute difference between adjacent successful probe sequences.',
  ],
  [
    'replies',
    'Valid latency samples',
    'Count used for latency statistics, not necessarily packet count.',
  ],
  [
    'lossPercent',
    'Non-response (%)',
    'ICMP non-response or UDP loss statistic; missing is not zero.',
  ],
  [
    'baselineMs',
    'Baseline median (ms)',
    'Median HTTP latency before the load transfer.',
  ],
  [
    'loadMbps',
    'Load throughput (Mbps)',
    'Throughput of the embedded HTTP transfer.',
  ],
  [
    'loadBytes',
    'Load transferred bytes',
    'Application bytes in the embedded transfer; count once per parent.',
  ],
  [
    'library',
    'Recorded library',
    'Parent provenance may be absent even when a library performed the test.',
  ],
  [
    'errorType',
    'Error category',
    'Parent failure category; individual probe errors are separate.',
  ],
  [
    'network',
    'Network type',
    'Context snapshot reused by the measurement and its samples.',
  ],
  [
    'signal',
    'Wi-Fi strength (0–100)',
    'NetInfo signal score, not dBm or satellite signal strength.',
  ],
  ['battery', 'Battery (%)', 'Battery level at the context snapshot time.'],
];
export const probeFields: Field[] = [
  [
    'protocol',
    'Measurement type',
    'Parent test; HTTP samples are transactions, not individual packets.',
  ],
  [
    'phase',
    'Sample phase',
    'probe: ordinary/during-transfer; baseline: before transfer; traceroute: hop probe.',
  ],
  [
    'sequence',
    'Probe sequence',
    'Application/library index, not necessarily ICMP header sequence.',
  ],
  [
    'rttMs',
    'Elapsed time (ms)',
    'ICMP/UDP/trace RTT, TCP connection duration, or full HTTP transaction latency.',
  ],
  [
    'outcome',
    'Sample outcome',
    'Response, timeout, error or unavailable; independent of parent success.',
  ],
  [
    'hop',
    'Traceroute hop',
    'Outgoing hop limit; the RTT is not the delay of only this link.',
  ],
  [
    'address',
    'Reply / offender address',
    'Library-supplied responder; blank when unavailable. Never substituted with the target.',
  ],
  [
    'kind',
    'Library outcome label',
    'Trace host_unreachable is ambiguous in icmpenguin rc.3, not a decoded ICMP type.',
  ],
  ['parent', 'Measurement ID', 'Parent measurement that owns this sample.'],
  [
    'target',
    'Target',
    'Intended destination; distinct from observed responder address.',
  ],
  [
    'observed',
    'Observed at (UTC)',
    'Application timestamp or adapter callback wall-clock time; not kernel timestamp.',
  ],
  [
    'errorType',
    'Error category',
    'Sample-level error; traceroute also uses its library outcome label.',
  ],
  [
    'replyTtl',
    'Reply TTL',
    'Incoming TTL reported by the library; not directly a path hop count.',
  ],
  [
    'probeTtl',
    'Probe TTL',
    'Outgoing ICMP hop limit; for traceroute use Traceroute hop.',
  ],
  [
    'icmpType',
    'ICMP type',
    'Decoded ICMP header field when supplied; not inferred from trace labels.',
  ],
  ['icmpCode', 'ICMP code', 'Decoded ICMP subtype; zero is a real value.'],
  [
    'icmpIdentifier',
    'ICMP identifier',
    'Identifier decoded from the received echo header.',
  ],
  [
    'icmpSequence',
    'ICMP header sequence',
    'Received header sequence, separate from the application probe index.',
  ],
  [
    'icmpChecksum',
    'ICMP checksum',
    'Received checksum value; presence is not independent checksum verification.',
  ],
  [
    'receivedSocketBytes',
    'Received ICMP bytes',
    'Returned ICMP message size; excludes the outer IP header.',
  ],
  [
    'receivedScope',
    'Received byte scope',
    'Description of what the retained bytes contain.',
  ],
  [
    'probeBytes',
    'Trace payload bytes',
    'Library-reported outgoing traceroute payload size.',
  ],
];
export const scheduleFields: Field[] = [
  ['type', 'Measurement type', 'Scheduled test.'],
  ['scheduled', 'Scheduled at (UTC)', 'Intended execution time.'],
  ['executed', 'Executed at (UTC)', 'Recorded execution timestamp.'],
  [
    'delayMs',
    'Start delay (ms)',
    'Execution minus scheduled time in wall clock; not network latency.',
  ],
];

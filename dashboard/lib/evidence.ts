export type Evidence = Record<string, any>;
export const measurementLabels: Record<string, string> = {
  icmp_burst: 'ICMP echo burst',
  icmp_rtt: 'ICMP echo',
  tcp_connect: 'TCP connection',
  udp_echo: 'UDP echo',
  traceroute: 'Traceroute',
  http_rtt: 'HTTP latency',
  download: 'HTTP download',
  upload: 'HTTP upload',
  loaded_download: 'Latency during download',
  loaded_upload: 'Latency during upload',
};
export const measurementLabel = (type: string) =>
  measurementLabels[type] ?? type;
export const present = (v: unknown) => v !== undefined && v !== null;
const numeric = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
export function parentOutcome(m: Evidence) {
  return m.success === true
    ? 'success'
    : m.success === false
    ? 'failure'
    : 'unavailable';
}
export function sampleOutcome(s: Evidence): string {
  if (s.errorType === 'timeout' || s.kind === 'timeout') return 'timeout';
  if (s.errorType || s.kind === 'error') return 'error';
  // A trace error callback is response evidence. Its library label is not a
  // decoded ICMP type and cannot be used to classify an outage.
  if (
    s.kind &&
    [
      'host_unreachable',
      'network_unreachable',
      'icmp_error',
      'port_unreachable',
    ].includes(s.kind)
  )
    return 'response';
  if (numeric(s.rttMs) && s.rttMs >= 0) return 'response';
  return 'unavailable';
}
export function sampleRows(measurements: Evidence[]): Evidence[] {
  return measurements.flatMap(m => {
    const groups: [string, Evidence[]][] = [
      ['probe', m.details?.samples ?? []],
      ['baseline', m.details?.baselineSamples ?? []],
      ['traceroute', m.route?.samples ?? []],
    ];
    if (m.type === 'icmp_rtt' && !m.details?.samples?.length) {
      groups[0][1] = [
        {
          sequence: 0,
          timestamp: m.timestamp,
          rttMs: m.value,
          ttl: m.ttl,
          errorType: m.errorType,
          packet: m.packet,
        },
      ];
    }
    return groups.flatMap(([phase, samples]) =>
      samples.map((s, ordinal) => {
        const response = s.packet?.response ?? {};
        return {
          ...s,
          parent: m.id,
          protocol: m.type,
          phase,
          ordinal,
          target: m.targetHost ?? m.probeServer,
          observed:
            s.timestamp ??
            (numeric(s.observedAtMs)
              ? new Date(s.observedAtMs).toISOString()
              : null),
          outcome: sampleOutcome(s),
          replyTtl: s.replyTtl ?? s.ttl ?? response.replyTtl,
          probeTtl: s.packet?.probeTtl,
          icmpType: s.icmpType ?? response.icmpType,
          icmpCode: s.icmpCode ?? response.icmpCode,
          icmpIdentifier: response.icmpIdentifier,
          icmpSequence: response.icmpSequence,
          icmpChecksum: response.icmpChecksum,
          receivedSocketBytes: response.receivedSocketBytes,
          receivedScope: response.receivedScope,
        };
      }),
    );
  });
}
export function filterMeasurements(
  rows: Evidence[],
  type: string,
  outcome: string,
  search: string,
) {
  const q = search.trim().toLowerCase();
  return rows.filter(
    m =>
      (!type || m.type === type) &&
      (!outcome || parentOutcome(m) === outcome) &&
      (!q ||
        [
          m.id,
          m.targetHost,
          m.probeServer,
          m.method,
          m.type,
          measurementLabel(m.type),
        ].some(v =>
          String(v ?? '')
            .toLowerCase()
            .includes(q),
        )),
  );
}
export function csvText(headers: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    let text = present(v) ? String(v) : '';
    if (typeof v === 'string' && /^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"'
      : text;
  };
  return (
    [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
  );
}

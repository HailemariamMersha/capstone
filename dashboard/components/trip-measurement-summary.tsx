export type TripSummary = {
  receivedSegments: number;
  receivedRecords: number;
  expectedRecords: number;
  measurements: number;
  failures: number;
  protocols: ProtocolSummary[];
};
type ProtocolSummary = {
  timingExcluded?: number;
  type: string;
  attempts: number;
  successful: number;
  failed: number;
  timeouts: number;
  capped: number;
  incompleteBursts: number;
  reached: number;
  sampleCount: number;
  replies: number;
  medianMs: number | null;
};
const count = (n: number) => n.toLocaleString();
function elapsed(start: number, end: number | null) {
  if (end == null) return 'In progress · last reported';
  const minutes = Math.floor(Math.max(0, end - start) / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function outcome(m: ProtocolSummary, noun: string) {
  const parts = [`${count(m.successful)}/${count(m.attempts)} ${noun}`];
  if (m.timeouts) parts.push(`${count(m.timeouts)} timed out`);
  if (m.capped) parts.push(`${count(m.capped)} capped / partial`);
  if (m.timingExcluded)
    parts.push(
      `${count(m.timingExcluded)} timing excluded after a collection gap`,
    );
  const other = Math.max(0, m.failed - m.timeouts - m.capped);
  if (other)
    parts.push(`${count(other)} other ${other === 1 ? 'error' : 'errors'}`);
  const unknown = m.attempts - m.successful - m.failed;
  if (unknown > 0) parts.push(`${count(unknown)} outcomes unavailable`);
  return parts.join('; ');
}
function results(m: ProtocolSummary | undefined) {
  if (!m?.attempts) return 'Not collected in received segments';
  if (
    m.type === 'icmp_burst' ||
    m.type === 'icmp_rtt' ||
    m.type === 'udp_echo'
  ) {
    const samples = m.incompleteBursts
      ? `${count(m.replies)} replies in ${count(
          m.sampleCount,
        )} saved samples; ${count(m.incompleteBursts)} incomplete ${
          m.incompleteBursts === 1 ? 'burst' : 'bursts'
        }`
      : `${count(m.replies)}/${count(m.sampleCount)} recorded probes replied`;
    return `${samples}. ${outcome(
      m,
      m.type === 'icmp_rtt' ? 'attempts succeeded' : 'bursts succeeded',
    )}.`;
  }
  if (m.type === 'traceroute')
    return `${count(m.reached)}/${count(
      m.attempts,
    )} traces reported reaching the destination; ${count(m.replies)}/${count(
      m.sampleCount,
    )} saved hop probes returned RTT.`;
  return outcome(
    m,
    m.type === 'tcp_connect' ? 'connections succeeded' : 'tests completed',
  );
}
export function TripMeasurementSummary({
  summary,
  startedAt,
  endedAt,
}: {
  summary: TripSummary | undefined;
  startedAt: number;
  endedAt: number | null;
}) {
  if (!summary)
    return (
      <p className="muted text-sm">
        Measurement summary unavailable. Open a segment to inspect its evidence.
      </p>
    );
  const byType = new Map(summary.protocols.map(m => [m.type, m]));
  const rows: [string, string][] = [
    ['ICMP', 'icmp_burst'],
    ...(byType.has('icmp_rtt')
      ? [['ICMP single probe', 'icmp_rtt'] as [string, string]]
      : []),
    ['UDP', 'udp_echo'],
    ['TCP', 'tcp_connect'],
    ['Traceroute', 'traceroute'],
    ['Controlled download', 'download'],
    ['Controlled upload', 'upload'],
    ['M-Lab download', 'ndt7_download'],
    ['M-Lab upload', 'ndt7_upload'],
  ];
  const known = new Set(rows.map(([, type]) => type));
  rows.push(
    ...summary.protocols
      .filter(m => !known.has(m.type))
      .map(m => [m.type.replaceAll('_', ' '), m.type] as [string, string]),
  );
  return (
    <section
      aria-label="Trip measurement summary"
      className="space-y-3 border-t border-slate-200 pt-4"
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Elapsed trip time', elapsed(startedAt, endedAt)],
          ['Received segments', count(summary.receivedSegments)],
          ['Measurements', count(summary.measurements)],
          ['Failed / incomplete measurements', count(summary.failures)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 p-3">
            <dt className="text-xs muted">{label}</dt>
            <dd className="mt-1 text-lg font-semibold text-slate-900">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        {count(summary.receivedRecords)}/{count(summary.expectedRecords)}{' '}
        expected records received across registered segments.
      </p>
      <div
        className="overflow-x-auto rounded-xl border border-slate-200"
        role="region"
        aria-label="Trip measurement results"
        tabIndex={0}
      >
        <table className="w-full min-w-[540px] text-left text-sm">
          <caption className="sr-only">
            Measurements across received trip segments
          </caption>
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="p-3">
                Measurement
              </th>
              <th scope="col" className="p-3">
                Results
              </th>
              <th scope="col" className="p-3">
                Median timing
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, type]) => {
              const m = byType.get(type);
              return (
                <tr key={type} className="border-t border-slate-100 align-top">
                  <th scope="row" className="p-3 font-medium">
                    {label}
                  </th>
                  <td className="p-3">{results(m)}</td>
                  <td className="p-3 whitespace-nowrap">
                    {m?.medianMs != null
                      ? `${m.medianMs.toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })} ms ${type === 'tcp_connect' ? 'connect' : 'RTT'}`
                      : 'Unavailable'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Elapsed time includes gaps and upload pauses. Totals cover received
        evidence only; a complete upload does not mean continuous collection.
      </p>
      <details className="text-xs muted">
        <summary>How to read these results</summary>
        <p className="mt-2">
          Each measurement is counted once, regardless of its number of samples.
          Timing medians pool valid individual probe values, including zero.
          Incomplete bursts cannot establish whole-trip packet loss. A burst can
          succeed despite individual timeouts. TCP timing measures connection
          duration. Traceroute destinations use the library’s qualified labels.
          Capped M-Lab tests are partial results, without a completed speed
          estimate. Different targets make cross-protocol latency comparisons
          unsuitable for isolating protocol overhead.
        </p>
      </details>
    </section>
  );
}

'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { api, download } from '@/lib/client';
import { DataTable } from './data-table';
import { Button } from './ui/button';
import { label, when, number } from '@/lib/trip-types';
import { variableDefinition } from '@/lib/variable-reference';
type Row = Record<string, any>;
const empty = (v: unknown) =>
  v == null ? (
    <span title="Not recorded or not applicable" aria-label="Not recorded">
      —
    </span>
  ) : typeof v === 'object' ? (
    JSON.stringify(v)
  ) : (
    String(v)
  );
function column(
  key: string,
  title: string,
  description: string,
  scope?: 'Measurements' | 'Samples' | 'Events',
): ColumnDef<Row> {
  const definition = variableDefinition(
    scope ??
      ([
        'protocol',
        'sequence',
        'rttMs',
        'outcome',
        'address',
        'hop',
        'phase',
        'measurementId',
      ].includes(key)
        ? 'Samples'
        : 'Measurements'),
    key,
  );
  return {
    id: key,
    accessorFn: row =>
      key === 'targetHost'
        ? row.targetHost ?? row.probeServer
        : key === 'lossPercent'
        ? row.details?.lossPercent ?? row.details?.nonResponsePercent
        : key === 'replyCount'
        ? row.details?.summary?.replies
        : key === 'port'
        ? row.details?.targetPort ?? row.raw?.request?.port
        : row[key],
    header: title,
    meta: {
      description: `${description} Units: ${definition.units}. ${definition.calculation} Missing: ${definition.blank}`,
    },
    cell: c =>
      key === 'timestamp'
        ? when(c.getValue() as string)
        : key === 'type' || key === 'protocol'
        ? label(String(c.getValue()))
        : key === 'success'
        ? c.getValue() === true
          ? 'Success'
          : c.getValue() === false
          ? String(c.row.original.errorType ?? 'Failed')
          : '—'
        : empty(c.getValue()),
  };
}
export function TripEvidence({
  tripId,
  segments,
}: {
  tripId: string;
  segments: { index: number; sessionId: string; uploaded: boolean }[];
}) {
  const [layer, setLayer] = useState('measurements'),
    [protocol, setProtocol] = useState(''),
    [outcome, setOutcome] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState('');
  const [raw, setRaw] = useState<Row | null>(null);
  const path = `/research/trips/${tripId}/evidence?layer=${layer}&protocol=${protocol}&outcome=${outcome}&offset=${offset}&limit=50`;
  const query = useQuery<{ items: Row[]; total: number }>({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    retry: false,
    staleTime: 60000,
  });
  const fields: ColumnDef<Row>[] =
    layer === 'samples'
      ? [
          column(
            'timestamp',
            'Observed (UTC)',
            'Recorded observation time; not a kernel timestamp.',
            'Samples',
          ),
          column(
            'protocol',
            'Test',
            'Measurement method producing this observation.',
          ),
          column('sequence', 'Probe', 'Probe sequence within its burst.'),
          column(
            'rttMs',
            'RTT (ms)',
            'Application/library observed round-trip time.',
          ),
          column('outcome', 'Outcome', 'Reply, timeout, error or unavailable.'),
          column(
            'address',
            'Reply address',
            'Responder address when exposed by the library.',
          ),
          column('hop', 'Hop', 'Traceroute TTL position.'),
          column(
            'phase',
            'Sample group',
            'Probe, baseline, hop or benchmark callback.',
          ),
          column(
            'measurementId',
            'Measurement ID',
            'Parent observation identifier.',
          ),
        ]
      : layer === 'events'
      ? [
          column(
            'timestamp',
            'Observed (UTC)',
            'Event recording time; see details for original observation time.',
            'Events',
          ),
          column('kind', 'Event', 'Collector activity or decision.', 'Events'),
          column(
            'details',
            'Details',
            'Scheduling evidence and recorded reasons.',
            'Events',
          ),
          column(
            'sessionId',
            'Segment ID',
            'Closed collection fragment containing the event.',
            'Events',
          ),
        ]
      : [
          column(
            'timestamp',
            'Started (UTC)',
            'Measurement execution wall-clock time.',
          ),
          column(
            'type',
            'Test',
            'Interpret result together with its method and unit.',
          ),
          column(
            'value',
            'Result',
            'Valid burst median, connection duration, transfer rate or route result.',
          ),
          column('unit', 'Unit', 'Milliseconds, Mbps or hops.'),
          column(
            'success',
            'Succeeded',
            'Parent result; a successful burst can still contain lost probes.',
          ),
          column(
            'targetHost',
            'Target',
            'Destination host; controlled transfers may instead use probeServer.',
          ),
          column(
            'durationMs',
            'Duration (ms)',
            'Application-observed callback duration.',
          ),
          column(
            'transferredBytes',
            'Payload bytes',
            'Observed application transfer bytes; excludes transport overhead.',
          ),
          column('errorType', 'Error', 'Recorded failure classification.'),
          column('method', 'Method', 'How this measurement was obtained.'),
          column('probeServer', 'Probe endpoint', 'Controlled service URL.'),
          column(
            'id',
            'Measurement ID',
            'Identifier linking raw records and samples.',
          ),
          column(
            'lossPercent',
            'Loss / non-response (%)',
            'Recorded burst loss statistic; incomplete or invalid bursts remain blank.',
          ),
          column(
            'replyCount',
            'Replies',
            'Unique valid replies recorded in the burst summary.',
          ),
          column(
            'port',
            'Port',
            'Destination port supplied to the measurement library.',
          ),
        ];
  const transfer = [
    'download',
    'upload',
    'ndt7_download',
    'ndt7_upload',
  ].includes(protocol);
  const echo = ['icmp_burst', 'icmp_rtt', 'udp_echo'].includes(protocol);
  const defaults =
    layer === 'events'
      ? ['timestamp', 'kind', 'details', 'sessionId']
      : layer === 'samples' && protocol === 'traceroute'
      ? ['timestamp', 'hop', 'sequence', 'address', 'rttMs', 'outcome']
      : layer === 'measurements' && transfer
      ? [
          'timestamp',
          'targetHost',
          'transferredBytes',
          'durationMs',
          'value',
          'success',
        ]
      : layer === 'measurements' && protocol === 'tcp_connect'
      ? ['timestamp', 'targetHost', 'port', 'value', 'success', 'errorType']
      : layer === 'measurements' && echo
      ? [
          'timestamp',
          'targetHost',
          'value',
          'replyCount',
          'lossPercent',
          'success',
        ]
      : fields.slice(0, 6).map(c => c.id!);
  for (const field of fields) {
    if (field.id === 'value' && transfer) field.header = 'Rate (Mbps)';
    if (field.id === 'value' && protocol === 'tcp_connect')
      field.header = 'Connect duration (ms)';
    if (field.id === 'value' && echo) field.header = 'Median RTT (ms)';
  }
  const change =
    (setter: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setter(e.target.value);
      setOffset(0);
    };
  return (
    <section className="space-y-5" aria-label="Trip evidence">
      <div>
        <h2 className="text-xl font-semibold">Evidence</h2>
        <p className="muted text-sm mt-1">
          Measurements are rounds or transfers; samples are individual
          observations. Only the requested page is loaded.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <label>
          Rows
          <select
            aria-label="Evidence rows"
            className="block"
            value={layer}
            onChange={change(setLayer)}
          >
            <option value="measurements">Measurement rounds</option>
            <option value="samples">Individual probes</option>
            <option value="events">Collector events</option>
          </select>
        </label>
        <label>
          Test
          <select
            aria-label="Evidence test"
            className="block"
            value={protocol}
            onChange={change(setProtocol)}
          >
            <option value="">All tests</option>
            {[
              'icmp_burst',
              'udp_echo',
              'tcp_connect',
              'traceroute',
              'download',
              'upload',
              'ndt7_download',
              'ndt7_upload',
            ].map(p => (
              <option value={p} key={p}>
                {label(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            aria-label="Evidence outcome"
            className="block"
            value={outcome}
            onChange={change(setOutcome)}
          >
            <option value="">All outcomes</option>
            <option value="success">Success / reply</option>
            <option value="failure">Failure</option>
            <option value="interrupted">Interrupted</option>
            <option value="timeout">Timeout</option>
          </select>
        </label>
      </div>
      {query.error && (
        <div role="alert" className="panel p-4 text-red-800">
          {query.error.message}{' '}
          <button className="underline" onClick={() => query.refetch()}>
            Retry
          </button>
        </div>
      )}
      {query.isPending ? (
        <p role="status">Loading evidence…</p>
      ) : (
        <>
          <DataTable
            key={`${layer}:${protocol}`}
            rows={query.data?.items ?? []}
            columns={fields}
            name="Trip observations"
            defaultColumns={defaults}
          />
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous observations
            </Button>
            <span className="text-sm muted">
              {offset + 1}–{Math.min(offset + 50, query.data?.total ?? 0)} of{' '}
              {query.data?.total ?? 0}
            </span>
            <Button
              variant="outline"
              disabled={offset + 50 >= (query.data?.total ?? 0)}
              onClick={() => setOffset(offset + 50)}
            >
              Next observations
            </Button>
          </div>
        </>
      )}
      <details className="panel p-5">
        <summary className="cursor-pointer font-semibold">
          Collection segments and original evidence
        </summary>
        <p className="muted text-sm my-3">
          Segments are approximately 15-minute fragments of this trip. Complete
          downloads preserve original records, including byte dumps.
        </p>
        <div className="grid gap-3 mt-3">
          {segments.map(s => (
            <div
              key={s.index}
              className="flex flex-wrap gap-3 items-center border-b border-slate-100 pb-3"
            >
              <span className="mr-auto">
                Segment {s.index + 1} ·{' '}
                {s.uploaded ? 'reconciled' : 'partial upload'}
              </span>
              <Button
                variant="outline"
                onClick={() =>
                  download(
                    `/research/sessions/${s.sessionId}`,
                    `segment-${s.index + 1}.json`,
                  ).catch(e => setError(e.message))
                }
              >
                Original JSON
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    setRaw(await api(`/research/sessions/${s.sessionId}`));
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Inspect raw
              </Button>
            </div>
          ))}
        </div>
        {raw && (
          <pre className="max-h-96 overflow-auto text-xs mt-4">
            {JSON.stringify(raw, null, 2)}
          </pre>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    </section>
  );
}

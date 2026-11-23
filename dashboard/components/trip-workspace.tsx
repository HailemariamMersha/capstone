'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowDownToLine,
  BookOpen,
  LayoutDashboard,
  LogOut,
  Plane,
  RadioTower,
  RefreshCw,
  Users,
} from 'lucide-react';
import { api, download, supabase } from '@/lib/client';
import {
  type TripRow,
  type TripDetail,
  type Timeline,
  label,
  duration,
  number,
  when,
} from '@/lib/trip-types';
import { Button } from './ui/button';
import { TripTimeline } from './trip-timeline';
import { TripEvidence } from './trip-evidence';
import { PaymentReconciliation } from './payment-reconciliation';
import { RouteMap } from './trip-route-map';
import { MeasurementGuide } from './measurement-guide';
export type Profile = { role: string; participantId: string };
export type Section = 'overview' | 'trips' | 'participants' | 'guide';
const queryOptions = {
  retry: false,
  refetchIntervalInBackground: false,
} as const;
export function Message({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-xl border p-4 ${
        error
          ? 'border-red-200 bg-red-50 text-red-900'
          : 'border-slate-200 bg-white text-slate-600'
      }`}
    >
      {children}
    </div>
  );
}
function ScopeBadge({ ground }: { ground: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
        ground ? 'bg-slate-100 text-slate-700' : 'bg-teal-50 text-teal-900'
      }`}
    >
      {ground ? 'Ground test' : 'Flight study'}
    </span>
  );
}
function KindFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="text-sm font-medium">
      Data type
      <select
        className="block mt-1"
        aria-label="Data type"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="all">All received trips</option>
        <option value="study">Flight study</option>
        <option value="ground">Ground tests</option>
      </select>
    </label>
  );
}
function Updated({ at, onRefresh }: { at: number; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-3 text-xs muted">
      <span>
        {at ? `Last updated ${when(at)} UTC` : 'Waiting for received data'}
      </span>
      <Button
        variant="ghost"
        aria-label="Refresh current data"
        onClick={onRefresh}
      >
        <RefreshCw size={15} />
        Refresh
      </Button>
    </div>
  );
}
function TripList({
  preview = false,
  kind = 'all',
}: {
  preview?: boolean;
  kind?: string;
}) {
  const [q, setQ] = useState(''),
    [draft, setDraft] = useState(''),
    [provider, setProvider] = useState(''),
    [dataKind, setKind] = useState(kind),
    [since, setSince] = useState(''),
    [until, setUntil] = useState(''),
    [page, setPage] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    if (!preview) {
      const s = new URLSearchParams(window.location.search);
      setQ(s.get('q') ?? '');
      setDraft(s.get('q') ?? '');
      setProvider(s.get('provider') ?? '');
      setKind(s.get('kind') ?? 'all');
      setSince(s.get('since') ?? '');
      setUntil(s.get('until') ?? '');
      setPage(Number(s.get('page')) || 0);
    }
  }, [preview]);
  useEffect(() => {
    if (preview) setKind(kind);
  }, [preview, kind]);
  const filter = new URLSearchParams({
    view: 'compact',
    q,
    provider,
    kind: dataKind,
  });
  if (since) filter.set('since', `${since}T00:00:00Z`);
  if (until)
    filter.set('until', new Date(Date.parse(until) + 86400000).toISOString());
  const path = `/research/trips?${filter}&offset=${
    page * (preview ? 5 : 20)
  }&limit=${preview ? 5 : 20}`;
  const query = useQuery<{ items: TripRow[]; total: number }>({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    ...queryOptions,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (preview) return;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({
      q,
      provider,
      kind: dataKind,
      since,
      until,
      page: String(page),
    })) {
      if (v && v !== 'all' && v !== '0') p.set(k, v);
    }
    window.history.replaceState(null, '', `/trips${p.size ? '?' + p : ''}`);
  }, [preview, q, provider, dataKind, since, until, page]);
  return (
    <section
      className="space-y-4"
      aria-label={preview ? 'Recent trips' : 'Trip history'}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">
          {preview ? 'Recent trips' : 'Trip history'}
        </h2>
        {preview ? (
          <Link className="text-sm text-teal-800 underline" href="/trips">
            View all trips →
          </Link>
        ) : (
          <Button
            variant="outline"
            onClick={() =>
              download(
                `/research/trips/export-summary?${filter}`,
                'skymeasure-trips.csv',
              ).catch(e => setError(e.message))
            }
          >
            <ArrowDownToLine size={16} />
            Filtered trip summary CSV
          </Button>
        )}
      </div>
      {!preview && (
        <form
          className="flex flex-wrap gap-3 items-end"
          onSubmit={e => {
            e.preventDefault();
            setQ(draft);
            setPage(0);
          }}
        >
          <label className="text-sm font-medium">
            Flight, route or participant
            <input
              className="block mt-1"
              aria-label="Search trips"
              placeholder="Search received trips"
              value={draft}
              onChange={e => setDraft(e.target.value)}
            />
          </label>
          <Button type="submit">Search</Button>
          <KindFilter
            value={dataKind}
            onChange={v => {
              setKind(v);
              setPage(0);
            }}
          />
          <label className="text-sm font-medium">
            Latest provider
            <select
              className="block mt-1"
              value={provider}
              onChange={e => {
                setProvider(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All providers</option>
              {[
                'Starlink',
                'Inmarsat',
                'Intelsat',
                'Panasonic',
                'SITA',
                'ViaSat',
                'TEST Etisalat',
              ].map(p => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            From (UTC)
            <input
              className="block mt-1"
              type="date"
              value={since}
              onChange={e => {
                setSince(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="text-sm font-medium">
            Through (UTC)
            <input
              className="block mt-1"
              type="date"
              value={until}
              onChange={e => {
                setUntil(e.target.value);
                setPage(0);
              }}
            />
          </label>
        </form>
      )}
      <Updated at={query.dataUpdatedAt} onRefresh={() => query.refetch()} />
      {(query.error || error) && (
        <Message error>
          {query.error?.message ?? error}{' '}
          <button className="underline" onClick={() => query.refetch()}>
            Retry trip list
          </button>
        </Message>
      )}
      {query.isPending ? (
        <Message>Loading received trips…</Message>
      ) : query.data?.items.length === 0 ? (
        <Message>
          No trips yet. New trips will appear here when the phone uploads its
          first closed segment.
        </Message>
      ) : (
        <div className="panel table-scroll">
          <table className="w-full" aria-label="Received trips">
            <thead>
              <tr>
                <th>Flight / reported route</th>
                <th>Data type</th>
                <th>Collected (UTC)</th>
                <th>Duration</th>
                <th>Provider / state</th>
                <th>Upload</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map(t => (
                <tr key={t.id}>
                  <td>
                    <Link
                      href={`/trips/${t.id}`}
                      className="font-semibold text-teal-800 underline underline-offset-4"
                    >
                      {t.flight?.flightNumber || 'Trip'}
                    </Link>
                    <p className="text-xs muted mt-1">
                      {t.flight?.departure || '—'} → {t.flight?.arrival || '—'}
                    </p>
                  </td>
                  <td>
                    <ScopeBadge ground={t.groundTest} />
                  </td>
                  <td>{when(t.startedAt)}</td>
                  <td>
                    {t.endedAt == null
                      ? 'Last reported active'
                      : duration(t.endedAt - t.startedAt)}
                  </td>
                  <td>
                    {t.provider || 'Not observed'}
                    <p className="text-xs muted mt-1">
                      {t.phase === 'finished' ? t.state : t.phase} · last
                      reported
                    </p>
                  </td>
                  <td>
                    <span
                      className={`text-xs font-semibold ${
                        t.uploadComplete ? 'text-teal-800' : 'text-amber-800'
                      }`}
                    >
                      {t.uploadComplete ? 'Complete' : 'Awaiting records'}
                    </span>
                    <p className="text-xs muted mt-1">
                      {t.completeSegments}/{t.segmentCount} segments
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!preview && (
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            disabled={!page}
            onClick={() => setPage(p => p - 1)}
          >
            Previous trips
          </Button>
          <span className="muted text-sm">
            Page {page + 1} · {query.data?.total ?? 0} trips
          </span>
          <Button
            variant="outline"
            disabled={(page + 1) * 20 >= (query.data?.total ?? 0)}
            onClick={() => setPage(p => p + 1)}
          >
            Next trips
          </Button>
        </div>
      )}
    </section>
  );
}
function ProviderResults({ kind }: { kind: string }) {
  type Result = {
    provider: string;
    asn: string | null;
    groundTest: boolean;
    protocol: string;
    target: string;
    attempts: number;
    successful: number;
    probes: number;
    replies: number;
    medianRttMs: number | null;
    medianMbps: number | null;
  };
  const path = `/research/provider-results?kind=${kind}`;
  const data = useQuery<{ items: Result[]; computedAt: number; notes: string }>(
    {
      queryKey: [path],
      queryFn: ({ signal }) => api(path, { signal }),
      ...queryOptions,
      staleTime: 60000,
      refetchInterval: 60000,
    },
  );
  return (
    <section className="space-y-4" aria-label="Provider comparison">
      <div>
        <h2 className="text-xl font-semibold">Network results by provider</h2>
        <p className="muted text-sm mt-1">
          Valid received observations, grouped by method and destination. Ground
          tests remain separate. Provider names do not establish satellite orbit
          or an airborne flight.
        </p>
      </div>
      {data.isPending ? (
        <Message>
          Calculating provider results… Trip history is available below.
        </Message>
      ) : data.error ? (
        <Message error>
          {data.error.message}{' '}
          <button className="underline" onClick={() => data.refetch()}>
            Retry provider results
          </button>
        </Message>
      ) : !data.data?.items.length ? (
        <Message>
          No network measurements have arrived for this data type.
        </Message>
      ) : (
        <div className="panel table-scroll">
          <table className="w-full" aria-label="Provider network results">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Data type</th>
                <th>Method / target</th>
                <th>Valid median</th>
                <th>Successful rounds</th>
                <th>Recorded replies</th>
              </tr>
            </thead>
            <tbody>
              {data.data.items.map((r, i) => (
                <tr key={i}>
                  <td className="font-medium">
                    {r.provider}
                    <p className="text-xs muted">
                      {r.asn ? `AS${r.asn}` : 'ASN not observed'}
                    </p>
                  </td>
                  <td>
                    <ScopeBadge ground={r.groundTest} />
                  </td>
                  <td>
                    {label(r.protocol)}
                    <p className="text-xs muted">{r.target}</p>
                  </td>
                  <td>
                    {r.medianMbps != null
                      ? `${number(r.medianMbps)} Mbps`
                      : r.medianRttMs != null
                      ? `${number(r.medianRttMs)} ms`
                      : '—'}
                  </td>
                  <td>
                    {r.successful}/{r.attempts}
                  </td>
                  <td>{r.probes ? `${r.replies}/${r.probes}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.data && (
        <p className="text-xs muted">
          Computed {when(data.data.computedAt * 1000)} UTC. Medians pool
          individual valid probes; controlled transfers and M-Lab are separate.
          Counts cover received data only.
        </p>
      )}
    </section>
  );
}
function Overview() {
  const [kind, setKind] = useState('all');
  const path = `/research/trip-overview?kind=${kind}`;
  const query = useQuery<Record<string, number>>({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    ...queryOptions,
    refetchInterval: 15000,
  });
  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Every trip, in context.</h1>
          <p className="muted mt-2">
            Received network results and collection health, with the evidence
            one click away.
          </p>
        </div>
        <KindFilter value={kind} onChange={setKind} />
      </div>
      {query.error && <Message error>{query.error.message}</Message>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['trips', 'Trips received'],
          ['studyTrips', 'Flight-study trips'],
          ['groundTests', 'Ground tests'],
          ['incompleteUploads', 'Trips awaiting records'],
        ].map(([key, title]) => (
          <div key={key} className="panel p-6">
            <p className="text-sm muted">{title}</p>
            <p className="text-3xl font-semibold mt-3">
              {query.data ? number(query.data[key], 0) : '—'}
            </p>
          </div>
        ))}
      </div>
      <ProviderResults kind={kind} />
      <TripList preview kind={kind} />
    </div>
  );
}
function HealthHeader({ trip }: { trip: TripDetail }) {
  const badges = [
    {
      title: trip.groundTest ? 'Ground test' : 'Flight study',
      detail: trip.provider
        ? `Provider ASN matched: ${trip.provider}`
        : 'Provider match not observed in received evidence',
      tone: 'neutral',
    },
    {
      title: `Observed collection: ${duration(
        trip.health.observedCollectionMs,
      )}`,
      detail: `Across ${duration(
        trip.health.reportedDurationMs,
      )} reported elapsed time; coverage is an estimate from received observations.`,
      tone: 'neutral',
    },
    {
      title: trip.uploadComplete ? 'Upload complete' : 'Upload incomplete',
      detail: `${trip.receivedRecords}/${trip.expectedRegisteredRecords} records in registered segments; ${trip.completeSegments}/${trip.segmentCount} segments reconciled.`,
      tone: trip.uploadComplete ? 'good' : 'warn',
    },
    {
      title: `${trip.health.gapCount} recorded gaps`,
      detail: trip.health.gapCount
        ? `${duration(
            trip.health.gapMs,
          )} without collector observations; cause not established.`
        : trip.uploadComplete
        ? 'No collector gaps recorded in received evidence.'
        : 'No recorded gaps so far; missing segments remain unknown.',
      tone: trip.health.gapCount ? 'warn' : 'neutral',
    },
    {
      title: trip.state === 'active' ? trip.phase : trip.state,
      detail: `Last reported state. Latest server receipt: ${when(
        trip.receivedAt,
      )} UTC.`,
      tone: 'neutral',
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {badges.map(b => (
        <div
          key={b.title}
          className={`rounded-xl border p-4 ${
            b.tone === 'good'
              ? 'border-teal-200 bg-teal-50'
              : b.tone === 'warn'
              ? 'border-amber-200 bg-amber-50'
              : 'border-slate-200 bg-white'
          }`}
        >
          <p className="font-semibold text-sm capitalize">{b.title}</p>
          <p className="text-xs muted mt-2 leading-relaxed">{b.detail}</p>
        </div>
      ))}
    </div>
  );
}
function NetworkSummary({ trip }: { trip: TripDetail }) {
  return (
    <section className="panel table-scroll">
      <table className="w-full" aria-label="Trip measurement results">
        <thead>
          <tr>
            <th>Measurement</th>
            <th>Successful rounds</th>
            <th>Replies</th>
            <th>Valid median result</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {trip.summary.protocols.map(p => (
            <tr key={p.type}>
              <td className="font-medium">{label(p.type)}</td>
              <td>
                {p.successful}/{p.attempts}
              </td>
              <td>{p.sampleCount ? `${p.replies}/${p.sampleCount}` : '—'}</td>
              <td>
                {p.medianMbps != null
                  ? `${number(p.medianMbps)} Mbps`
                  : p.medianMs == null
                  ? '—'
                  : `${number(p.medianMs)} ms`}
              </td>
              <td>
                {[
                  p.timeouts ? `${p.timeouts} timed out` : '',
                  p.capped ? `${p.capped} partial` : '',
                  p.incompleteBursts
                    ? `${p.incompleteBursts} incomplete bursts`
                    : '',
                  p.type === 'traceroute'
                    ? `${p.reached} library-reported destination reach`
                    : '',
                ]
                  .filter(Boolean)
                  .join('; ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!trip.summary.protocols.length && (
        <p className="p-6 muted">No measurement rounds in received segments.</p>
      )}
    </section>
  );
}
function TripPage({ id }: { id: string }) {
  const [tab, setTab] = useState('network'),
    [evidence, setEvidence] = useState(false),
    [exporting, setExporting] = useState<string | null>(null),
    [error, setError] = useState('');
  const path = `/research/trips/${id}/detail`;
  const data = useQuery<TripDetail>({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    ...queryOptions,
    refetchInterval: q => (q.state.data?.uploadComplete ? false : 15000),
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const timelinePath = `/research/trips/${id}/timeline?maxPoints=2000`;
  const timeline = useQuery<Timeline>({
    queryKey: [timelinePath],
    queryFn: ({ signal }) => api(timelinePath, { signal }),
    enabled: Boolean(data.data),
    ...queryOptions,
    refetchInterval: () => (data.data?.uploadComplete ? false : 15000),
    staleTime: 60000,
  });
  if (!data.data)
    return (
      <div className="space-y-5">
        <Link className="text-teal-800 underline" href="/trips">
          ← All trips
        </Link>
        {data.error ? (
          <Message error>
            {data.error.message}{' '}
            <button className="underline" onClick={() => data.refetch()}>
              Retry trip
            </button>
          </Message>
        ) : (
          <Message>Loading this trip’s results…</Message>
        )}
      </div>
    );
  const t = data.data;
  return (
    <div className="space-y-6">
      <Link
        href="/trips"
        className="inline-flex gap-2 text-sm text-teal-800 underline"
      >
        <ArrowLeft size={16} />
        All trips
      </Link>
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <div className="flex gap-3 items-center">
            <h1 className="text-3xl font-semibold">
              {t.flight.flightNumber || 'Trip'}
            </h1>
            <ScopeBadge ground={t.groundTest} />
          </div>
          <p className="muted mt-2">
            {t.flight.departure || '—'} → {t.flight.arrival || '—'} · started{' '}
            {when(t.startedAt)} UTC
          </p>
          <p className="text-xs muted mt-2">
            Participant P-{t.participantId.slice(0, 8)} · route and flight
            number are participant-reported
          </p>
        </div>
        <details className="relative">
          <summary className="cursor-pointer min-h-11 rounded-xl bg-teal-800 text-white px-4 py-3 text-sm">
            Download trip
          </summary>
          <div className="absolute right-0 z-20 panel shadow-lg p-3 w-64 space-y-2">
            {['json', 'csv'].map(format => (
              <Button
                className="w-full"
                variant="ghost"
                key={format}
                disabled={exporting !== null}
                onClick={async () => {
                  setExporting(format);
                  try {
                    await download(
                      `/research/trips/${id}/export?format=${format}`,
                      `trip-${id}.${format}`,
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setExporting(null);
                  }
                }}
              >
                {format === 'json'
                  ? 'Complete original JSON'
                  : 'Combined measurements / samples CSV'}
              </Button>
            ))}
            <p className="text-xs muted">
              Received segments only. Partial uploads remain marked partial;
              NetIDs are excluded.
            </p>
          </div>
        </details>
      </header>
      <Updated
        at={data.dataUpdatedAt}
        onRefresh={() => {
          data.refetch();
          timeline.refetch();
        }}
      />
      {(error || data.error) && (
        <Message error>
          {error || data.error?.message} Previously loaded evidence remains
          visible.
        </Message>
      )}
      {exporting && (
        <Message>
          Preparing {exporting.toUpperCase()} export… Keep this page open until
          the download starts.
        </Message>
      )}
      <HealthHeader trip={t} />
      <RouteMap from={t.flight.departure} to={t.flight.arrival} />
      <div
        role="tablist"
        aria-label="Trip result view"
        className="flex gap-2 border-b border-slate-200 pb-3"
      >
        <Button
          role="tab"
          aria-selected={tab === 'network'}
          variant={tab === 'network' ? 'default' : 'ghost'}
          onClick={() => setTab('network')}
        >
          Network results
        </Button>
        <Button
          role="tab"
          aria-selected={tab === 'health'}
          variant={tab === 'health' ? 'default' : 'ghost'}
          onClick={() => setTab('health')}
        >
          Collector health
        </Button>
      </div>
      {tab === 'network' ? (
        <>
          <NetworkSummary trip={t} />
          {timeline.error && (
            <Message error>
              {timeline.error.message}{' '}
              <button className="underline" onClick={() => timeline.refetch()}>
                Retry timeline
              </button>
            </Message>
          )}
          <TripTimeline key={id} data={t} timeline={timeline.data} />
        </>
      ) : (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              ['Skipped probe events', t.health.skippedProbes],
              ['Live upload retries', t.health.uploadRetries],
              ['Timing-excluded rounds', t.health.timingExcluded],
            ].map(([title, count]) => (
              <div key={String(title)} className="panel p-5">
                <p className="muted text-sm">{title}</p>
                <p className="text-2xl font-semibold mt-3">
                  {number(count, 0)}
                </p>
              </div>
            ))}
          </div>
          <TripTimeline key={id} data={t} timeline={timeline.data} healthOnly />
          <details className="panel p-5">
            <summary className="cursor-pointer font-semibold">
              Battery and Android power observations
            </summary>
            <p className="text-xs muted mt-2">
              These are device observations. “Not charging” alone does not
              establish that the phone was unplugged.
            </p>
            <div className="max-h-72 overflow-auto mt-3">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Observed (UTC)</th>
                    <th>Battery</th>
                    <th>Screen interactive</th>
                    <th>Device idle</th>
                    <th>Battery exemption</th>
                  </tr>
                </thead>
                <tbody>
                  {t.health.powerObservations.map((p, i) => (
                    <tr key={i}>
                      <td>{when(p.at)}</td>
                      <td>
                        {p.percent == null ? '—' : `${number(p.percent, 0)}%`}
                      </td>
                      <td>
                        {p.screenInteractive == null
                          ? '—'
                          : String(p.screenInteractive)}
                      </td>
                      <td>
                        {p.deviceIdle == null ? '—' : String(p.deviceIdle)}
                      </td>
                      <td>
                        {p.batteryExempt == null
                          ? '—'
                          : String(p.batteryExempt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <section className="panel p-5">
        <button
          aria-expanded={evidence}
          className="font-semibold text-teal-800 underline min-h-11"
          onClick={() => setEvidence(v => !v)}
        >
          {evidence
            ? 'Hide evidence'
            : 'Inspect individual probes, segments and raw evidence'}
        </button>
        {evidence && (
          <div className="mt-5">
            <TripEvidence tripId={id} segments={t.segments} />
          </div>
        )}
      </section>
    </div>
  );
}
function Participants({ profile }: { profile: Profile }) {
  const client = useQueryClient(),
    [error, setError] = useState('');
  const people = useQuery<{
    items: { participantId: string; trips: number; latestCollection: number }[];
  }>({
    queryKey: ['trip-contributors'],
    queryFn: ({ signal }) => api('/research/trip-contributors', { signal }),
    ...queryOptions,
  });
  const members = useQuery<{
    items: { participantId: string; role: string }[];
  }>({
    queryKey: ['members'],
    queryFn: () => api('/admin/members'),
    enabled: profile.role === 'administrator',
    ...queryOptions,
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Participants and team</h1>
        <p className="muted mt-2">
          Contributions use participant identifiers. Payment details are
          restricted to administrators.
        </p>
      </div>
      {people.error && <Message error>{people.error.message}</Message>}
      <section className="panel table-scroll">
        <table className="w-full">
          <thead>
            <tr>
              <th>Participant</th>
              <th>Trips received</th>
              <th>Latest collection (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {people.data?.items.map(p => (
              <tr key={p.participantId}>
                <td>
                  <Link
                    className="text-teal-800 underline"
                    href={`/trips?q=${p.participantId}`}
                  >
                    P-{p.participantId.slice(0, 8)}
                  </Link>
                </td>
                <td>{p.trips}</td>
                <td>{when(p.latestCollection)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {people.data?.items.length === 0 && (
          <p className="p-5 muted">No received contributions yet.</p>
        )}
      </section>
      {profile.role === 'administrator' && (
        <>
          <PaymentReconciliation />
          <section className="panel p-6 space-y-4">
            <h2 className="text-xl font-semibold">Research team access</h2>
            {members.data?.items.map(m => (
              <div
                key={m.participantId}
                className="flex flex-wrap gap-4 items-center"
              >
                <span className="font-mono text-xs flex-1">
                  {m.participantId}
                </span>
                <select
                  aria-label={`Role for ${m.participantId}`}
                  value={m.role}
                  disabled={m.participantId === profile.participantId}
                  onChange={async e => {
                    try {
                      await api(`/admin/members/${m.participantId}`, {
                        method: 'PUT',
                        body: JSON.stringify({ role: e.target.value }),
                      });
                      await client.invalidateQueries({ queryKey: ['members'] });
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  {['participant', 'researcher', 'administrator'].map(r => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
            ))}
            {(error || members.error) && (
              <Message error>{error || members.error?.message}</Message>
            )}
          </section>
        </>
      )}
    </div>
  );
}
export function TripWorkspace({
  profile,
  section = 'overview',
  tripId,
}: {
  profile: Profile;
  section?: Section;
  tripId?: string;
}) {
  const client = useQueryClient();
  const seenReset = useRef<number | null>(null);
  const generation = useQuery<{ resetAt: number }>({
    queryKey: ['/research/history-generation'],
    queryFn: ({ signal }) => api('/research/history-generation', { signal }),
    ...queryOptions,
    refetchInterval: 15000,
  });
  useEffect(() => {
    const at = generation.data?.resetAt;
    if (at == null) return;
    if (seenReset.current != null && at !== seenReset.current) {
      client.resetQueries({
        predicate: q => {
          const key = String(q.queryKey[0]);
          return (
            (key.startsWith('/research/') &&
              key !== '/research/history-generation') ||
            key === 'admin-payments' ||
            key === 'trip-contributors'
          );
        },
      });
    }
    seenReset.current = at;
  }, [generation.data?.resetAt, client]);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="border-r border-slate-200 bg-white p-6 lg:sticky lg:top-0 lg:h-screen flex flex-col">
        <Link href="/" className="flex gap-3 items-center mb-10">
          <span className="bg-teal-800 rounded-xl p-2 text-white">
            <RadioTower size={24} />
          </span>
          <span>
            <b className="text-lg tracking-tight">SkyMeasure</b>
            <span className="block text-xs muted">RESEARCH WORKSPACE</span>
          </span>
        </Link>
        <nav
          aria-label="Research workspace"
          className="flex flex-wrap lg:flex-col gap-2"
        >
          {[
            {
              key: 'overview',
              name: 'Overview',
              href: '/',
              icon: LayoutDashboard,
            },
            { key: 'trips', name: 'Trips', href: '/trips', icon: Plane },
            {
              key: 'participants',
              name: 'Participants',
              href: '/participants',
              icon: Users,
            },
            {
              key: 'guide',
              name: 'Measurement guide',
              href: '/guide',
              icon: BookOpen,
            },
          ].map(({ key, name, href, icon: Icon }) => (
            <Link
              href={href}
              key={key}
              aria-current={
                (tripId ? 'trips' : section) === key ? 'page' : undefined
              }
              className={`flex gap-3 items-center rounded-xl p-3 text-sm ${
                (tripId ? 'trips' : section) === key
                  ? 'bg-teal-50 text-teal-900 font-semibold'
                  : 'muted hover:bg-slate-50'
              }`}
            >
              <Icon size={18} />
              {name}
            </Link>
          ))}
        </nav>
        <div className="mt-auto pt-10">
          <p className="text-xs muted mb-4">
            Private research team · {profile.role}
          </p>
          <Button
            variant="ghost"
            onClick={async () => {
              await supabase.auth.signOut({ scope: 'local' });
              client.clear();
            }}
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="p-5 md:p-9 xl:p-12 max-w-[1700px] w-full min-w-0">
        <p className="text-xs tracking-wide text-slate-500 mb-7">
          RECEIVED EVIDENCE / {tripId ? 'TRIP' : section.toUpperCase()}
        </p>
        {tripId ? (
          <TripPage id={tripId} />
        ) : section === 'overview' ? (
          <Overview />
        ) : section === 'participants' ? (
          <Participants profile={profile} />
        ) : section === 'guide' ? (
          <div className="space-y-6">
            <h1 className="text-3xl font-semibold">Measurement guide</h1>
            <MeasurementGuide />
          </div>
        ) : (
          <TripList />
        )}
      </main>
    </div>
  );
}

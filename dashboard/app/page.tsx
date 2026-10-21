'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type CellContext,
} from '@tanstack/react-table';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  CircleUserRound,
  LayoutDashboard,
  LogOut,
  RadioTower,
  RefreshCw,
  Rows3,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, configured, download, supabase } from '@/lib/client';

type Profile = { role: string; participantId: string };
type Summary = {
  id: string;
  participantId: string;
  collectedAt: string;
  receivedAt: string;
  completedAt: string | null;
  collectorVersion: string;
  measurements: number;
  failures: number;
  receivedRecords: number;
  expectedRecords: number;
  uploadStatus: string;
};
type Raw = Record<string, any>;
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : 'Unavailable';
const value = (v: unknown) =>
  v === null || v === undefined ? 'Unavailable' : String(v);
function useData<T>(path: string) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-xl border p-5 ${
        error
          ? 'border-red-200 bg-red-50 text-red-900'
          : 'border-slate-200 bg-white'
      }`}
    >
      {children}
    </div>
  );
}
function Badge({ complete }: { complete: boolean }) {
  return (
    <span
      className={`inline-flex self-start shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
        complete ? 'bg-teal-50 text-teal-900' : 'bg-amber-50 text-amber-900'
      }`}
    >
      {complete ? 'Complete' : 'Partial upload'}
    </span>
  );
}
function DataTable<T>({
  rows,
  columns,
  paginate = false,
}: {
  paginate?: boolean;
  rows: T[];
  columns: ColumnDef<T>[];
}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: paginate ? getPaginationRowModel() : undefined,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full">
        <thead>
          {table.getHeaderGroups().map(g => (
            <tr key={g.id}>
              {g.headers.map(h => (
                <th key={h.id} scope="col">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(r => (
            <tr key={r.id} className="hover:bg-slate-50">
              {r.getVisibleCells().map(c => (
                <td key={c.id}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {paginate && rows.length > 50 && (
        <div className="flex justify-between items-center gap-4 p-4">
          <Button
            variant="outline"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            Previous observations
          </Button>
          <span className="text-sm muted">
            Page {table.getState().pagination.pageIndex + 1} of{' '}
            {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            Next observations
          </Button>
        </div>
      )}
      {!rows.length && (
        <p className="p-8 muted">No received records match this view.</p>
      )}
    </div>
  );
}
function SessionDetail({ id, close }: { id: string; close: () => void }) {
  const data = useData<Raw>(`/research/sessions/${id}`);
  const [error, setError] = useState('');
  if (data.error) return <Notice error>{data.error.message}</Notice>;
  if (!data.data) return <Notice>Loading session evidence…</Notice>;
  const d = data.data;
  const measurements: Raw[] = d.measurements;
  const probes: Raw[] = measurements.flatMap(m => [
    ...(m.details?.samples ?? []).map((s: Raw) => ({
      ...s,
      parent: m.id,
      protocol: m.type,
      phase: 'probe',
    })),
    ...(m.details?.baselineSamples ?? []).map((s: Raw) => ({
      ...s,
      parent: m.id,
      protocol: m.type,
      phase: 'baseline',
    })),
    ...(m.route?.samples ?? []).map((s: Raw) => ({
      ...s,
      parent: m.id,
      protocol: m.type,
      phase: 'traceroute',
    })),
  ]);
  const timing = measurements
    .filter(m => m.unit === 'ms')
    .map(m => ({
      time: new Date(m.timestamp).toLocaleTimeString(),
      [m.type]: m.value,
      method: m.type,
    }));
  const probeColumns: ColumnDef<Raw>[] = [
    'protocol',
    'phase',
    'sequence',
    'hop',
    'rttMs',
    'address',
    'kind',
    'errorType',
  ].map(k => ({
    accessorKey: k,
    header: k === 'rttMs' ? 'Probe RTT (ms)' : k,
    cell: (c: CellContext<Raw, unknown>) => value(c.getValue()),
  }));
  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={close}>
        <ArrowLeft size={16} />
        All sessions
      </Button>
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Session evidence</h1>
          <p className="muted mt-2">
            Collected {date(d.session.startedAt)} · Received{' '}
            {date(d.receipt.receivedAt)}
          </p>
        </div>
        <Badge complete={Boolean(d.receipt.completedAt)} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() =>
            download(`/research/sessions/${id}`, `${id}.json`).catch(e =>
              setError(e.message),
            )
          }
        >
          <ArrowDownToLine size={16} />
          Original session JSON
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            download(
              `/research/sessions/${id}?format=csv`,
              `${id}-combined.csv`,
            ).catch(e => setError(e.message))
          }
        >
          Combined measurement / sample CSV
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ['Measurements', measurements.length],
          ['Individual samples', probes.length],
          [
            'Records received',
            `${d.receipt.receivedRecords} / ${d.receipt.expectedRecords}`,
          ],
        ].map(([k, v]) => (
          <div className="panel p-6" key={k}>
            <p className="muted">{k}</p>
            <p className="text-3xl mt-3 font-semibold">{v}</p>
          </div>
        ))}
      </div>
      <section className="panel p-6">
        <h2 className="text-xl font-semibold">Timing observations</h2>
        <p className="muted text-sm mt-2 mb-6">
          One point per measurement in milliseconds. Connection duration and
          echo RTT are different methods; gaps mean unavailable evidence.
        </p>
        {timing.length ? (
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={timing}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" />
                <YAxis unit=" ms" />
                <Tooltip />
                {[
                  ...new Set(
                    measurements
                      .filter(m => m.unit === 'ms')
                      .map(m => String(m.type)),
                  ),
                ].map((method, i) => (
                  <Line
                    key={method}
                    dataKey={method}
                    stroke={['#087f79', '#355b91', '#986422', '#7b4c94'][i % 4]}
                    connectNulls={false}
                    dot={true}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p>No timing values available.</p>
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold mb-4">
          Transfers and measurement outcomes
        </h2>
        <DataTable<Raw>
          paginate
          rows={measurements.map(m => ({
            ...m,
            loadMbps: m.details?.load?.value,
            loadBytes: m.details?.load?.transferredBytes,
          }))}
          columns={[
            'type',
            'value',
            'unit',
            'success',
            'transferredBytes',
            'durationMs',
            'loadMbps',
            'loadBytes',
            'method',
          ].map(k => ({
            accessorKey: k,
            header: k,
            cell: (c: CellContext<Raw, unknown>) => value(c.getValue()),
          }))}
        />
      </section>
      <section>
        <h2 className="text-xl font-semibold mb-2">
          Individual probes and traceroute hops
        </h2>
        <p className="muted mb-4">
          Traceroute kind labels are library classifications, not independently
          decoded ICMP evidence. A blank reply source or TTL means the library
          did not provide it.
        </p>
        <DataTable paginate rows={probes} columns={probeColumns} />
      </section>
      <section>
        <h2 className="text-xl font-semibold mb-4">Scheduling observations</h2>
        <DataTable<Raw>
          paginate
          rows={measurements.map(m => ({
            type: m.type,
            scheduled: m.scheduledAt,
            executed: m.timestamp,
            delayMs:
              m.scheduledAt && m.timestamp
                ? Date.parse(m.timestamp) - Date.parse(m.scheduledAt)
                : null,
          }))}
          columns={['type', 'scheduled', 'executed', 'delayMs'].map(k => ({
            accessorKey: k,
            header: k,
            cell: (c: CellContext<Raw, unknown>) => value(c.getValue()),
          }))}
        />
        <p className="muted text-sm mt-2">
          Delay uses two wall-clock timestamps; device clock changes may affect
          it. It is not packet RTT.
        </p>
      </section>
      {['configuration', 'context', 'raw evidence'].map((name, i) => (
        <details key={name} className="panel p-6">
          <summary className="cursor-pointer font-semibold capitalize">
            {name}
          </summary>
          <pre className="overflow-auto text-xs mt-4 max-h-96">
            {JSON.stringify(
              i === 0 ? d.session.config : i === 1 ? d.snapshots : d,
              null,
              2,
            )}
          </pre>
        </details>
      ))}
      <a
        className="underline"
        href="/measurement-guide.md"
        target="_blank"
        rel="noreferrer"
      >
        Measurement definitions and missing values
      </a>
    </div>
  );
}
function Workspace({ profile }: { profile: Profile }) {
  const [section, setSection] = useState('Overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [protocol, setProtocol] = useState('');
  const [outcome, setOutcome] = useState('');
  const [participant, setParticipant] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [collector, setCollector] = useState('');
  const [context, setContext] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const filters = new URLSearchParams({
    q,
    protocol,
    outcome,
    participant,
    since,
    until,
    collector,
    context,
  });
  for (const [key, v] of [...filters]) if (!v) filters.delete(key);
  const sessions = useData<{ items: Summary[]; total: number }>(
    `/research/sessions?${filters}&offset=${offset}&limit=25`,
  );
  const overview = useData<Record<string, number>>('/research/overview');
  const participants = useData<{
    items: {
      participantId: string;
      sessions: number;
      latestCollection: string;
    }[];
  }>('/research/participants');
  const members = useQuery<{
    items: { participantId: string; role: string }[];
  }>({
    queryKey: ['members'],
    queryFn: () => api('/admin/members'),
    enabled: profile.role === 'administrator',
    retry: false,
  });
  const client = useQueryClient();
  const columns = useMemo<ColumnDef<Summary>[]>(
    () => [
      {
        accessorKey: 'collectedAt',
        header: 'COLLECTED',
        cell: c => (
          <button
            className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-4"
            onClick={() => setSelected(c.row.original.id)}
          >
            {date(c.row.original.collectedAt)}
          </button>
        ),
      },
      {
        accessorKey: 'participantId',
        header: 'PARTICIPANT',
        cell: c => (
          <span title={c.row.original.participantId}>
            P-{c.row.original.participantId.slice(0, 8)}
          </span>
        ),
      },
      { accessorKey: 'measurements', header: 'MEASUREMENTS' },
      { accessorKey: 'failures', header: 'UNSUCCESSFUL' },
      {
        accessorKey: 'completedAt',
        header: 'UPLOAD',
        cell: c => <Badge complete={Boolean(c.getValue())} />,
      },
      {
        accessorKey: 'receivedAt',
        header: 'RECEIVED',
        cell: c => date(c.row.original.receivedAt),
      },
    ],
    [],
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-r border-slate-200 bg-white p-6 lg:sticky lg:top-0 lg:h-screen flex flex-col">
        <div className="flex gap-3 items-center mb-10">
          <div className="bg-teal-800 rounded-xl p-2 text-white">
            <RadioTower size={24} />
          </div>
          <div>
            <p className="font-bold text-lg tracking-tight">SkyMeasure</p>
            <p className="text-xs muted">RESEARCH WORKSPACE</p>
          </div>
        </div>
        <nav
          className="flex flex-wrap lg:flex-col gap-2"
          aria-label="Research workspace"
        >
          {[LayoutDashboard, Rows3, Users, ArrowDownToLine].map((Icon, i) => {
            const title = ['Overview', 'Sessions', 'Participants', 'Downloads'][
              i
            ];
            return (
              <button
                key={title}
                onClick={() => {
                  setSection(title);
                  setSelected(null);
                }}
                className={`flex gap-3 items-center text-sm rounded-xl p-3 text-left ${
                  section === title
                    ? 'bg-teal-50 text-teal-900 font-semibold'
                    : 'muted hover:bg-slate-50'
                }`}
                aria-current={section === title ? 'page' : undefined}
              >
                <Icon size={18} />
                {title}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto pt-10">
          <p className="text-xs muted mb-4">
            Private research team
            <br />
            {profile.role}
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
      <main className="p-6 md:p-10 xl:p-12 max-w-[1600px] min-w-0">
        <header className="flex flex-wrap justify-between items-center gap-4 mb-10">
          <p className="text-sm muted">
            Network research <span className="mx-2">/</span> {section}
          </p>
          <Button variant="outline" onClick={() => client.invalidateQueries()}>
            <RefreshCw size={15} />
            Refresh data
          </Button>
        </header>
        {selected ? (
          <SessionDetail id={selected} close={() => setSelected(null)} />
        ) : (
          <div className="space-y-7">
            <div>
              <p className="text-xs tracking-[.15em] text-teal-800 font-semibold mb-3">
                RECEIVED CONTRIBUTIONS
              </p>
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
                {section === 'Overview'
                  ? 'A clearer view of connectivity.'
                  : section}
              </h1>
              <p className="muted mt-3 max-w-2xl">
                {section === 'Overview'
                  ? 'Explore the evidence participants have shared, from a whole session to an individual probe.'
                  : 'Research evidence from uploaded sessions, with original records preserved.'}
              </p>
            </div>
            <div className="rounded-xl bg-teal-50 border border-teal-100 p-4 text-sm flex gap-3">
              <Activity size={20} className="shrink-0" />
              <p>
                Uploads arrive after collection ends. This workspace cannot see
                active phones or sessions that have not been sent. Visible data
                refreshes every 15 seconds.
              </p>
            </div>
            {(error || sessions.error || overview.error) && (
              <Notice error>
                {error || sessions.error?.message || overview.error?.message}
              </Notice>
            )}
            {section === 'Overview' && (
              <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-4">
                {[
                  ['participants', 'Contributors'],
                  ['sessions', 'Received sessions'],
                  ['measurements', 'Measurements'],
                  ['partialSessions', 'Partial uploads'],
                  ['failures', 'Unsuccessful tests'],
                ].map(([key, label]) => (
                  <div key={key} className="panel p-6">
                    <p className="text-sm muted">{label}</p>
                    <p className="text-4xl font-semibold tracking-tight mt-5">
                      {overview.data
                        ? overview.data[key].toLocaleString()
                        : '—'}
                    </p>
                    <p className="text-xs muted mt-3">Received evidence only</p>
                  </div>
                ))}
              </div>
            )}
            {(section === 'Overview' ||
              section === 'Sessions' ||
              section === 'Downloads') && (
              <>
                <div className="flex justify-between items-center">
                  <h2 className="font-semibold text-xl">
                    {section === 'Overview'
                      ? 'Recent arrivals'
                      : 'Session records'}
                  </h2>
                  <p className="text-sm muted">
                    {sessions.data?.total ?? '—'} sessions
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <input
                    aria-label="Search sessions"
                    placeholder="Search ID or collector"
                    value={q}
                    onChange={e => {
                      setQ(e.target.value);
                      setOffset(0);
                    }}
                  />
                  <select
                    aria-label="Protocol"
                    value={protocol}
                    onChange={e => {
                      setProtocol(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All measurements</option>
                    {[
                      'icmp_burst',
                      'tcp_connect',
                      'udp_echo',
                      'traceroute',
                      'http_rtt',
                      'download',
                      'upload',
                      'loaded_download',
                      'loaded_upload',
                    ].map(p => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Outcome"
                    value={outcome}
                    onChange={e => {
                      setOutcome(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All outcomes</option>
                    <option value="success">Successful</option>
                    <option value="failure">Unsuccessful</option>
                  </select>
                  <input
                    aria-label="Participant identifier"
                    placeholder="Participant identifier"
                    value={participant}
                    onChange={e => {
                      setParticipant(e.target.value);
                      setOffset(0);
                    }}
                  />
                  <input
                    aria-label="Collected from"
                    type="date"
                    value={since}
                    onChange={e => {
                      setSince(e.target.value);
                      setOffset(0);
                    }}
                  />
                  <input
                    aria-label="Collected until"
                    type="date"
                    value={until}
                    onChange={e => {
                      setUntil(e.target.value);
                      setOffset(0);
                    }}
                  />
                  <select
                    aria-label="Network context"
                    value={context}
                    onChange={e => {
                      setContext(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All network contexts</option>
                    <option value="wifi">Wi-Fi</option>
                    <option value="cellular">Cellular</option>
                    <option value="none">Disconnected</option>
                  </select>
                  <input
                    aria-label="Collector version"
                    placeholder="Collector version"
                    value={collector}
                    onChange={e => {
                      setCollector(e.target.value);
                      setOffset(0);
                    }}
                  />
                </div>
                {sessions.isPending ? (
                  <Notice>Loading received sessions…</Notice>
                ) : (
                  <DataTable
                    rows={sessions.data?.items ?? []}
                    columns={columns}
                  />
                )}
                <div className="flex justify-between gap-3">
                  <Button
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 25))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={offset + 25 >= (sessions.data?.total ?? 0)}
                    onClick={() => setOffset(offset + 25)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
            {section === 'Participants' && (
              <>
                <DataTable
                  rows={participants.data?.items ?? []}
                  columns={[
                    {
                      accessorKey: 'participantId',
                      header: 'Participant',
                      cell: c => (
                        <button
                          className="underline text-teal-800"
                          onClick={() => {
                            setParticipant(String(c.getValue()));
                            setSection('Sessions');
                            setOffset(0);
                          }}
                        >
                          {String(c.getValue())}
                        </button>
                      ),
                    },
                    { accessorKey: 'sessions', header: 'Contributions' },
                    {
                      accessorKey: 'latestCollection',
                      header: 'Latest collection',
                      cell: c => date(String(c.getValue())),
                    },
                  ]}
                />
                {participants.error && (
                  <Notice error>{participants.error.message}</Notice>
                )}
                {profile.role === 'administrator' && (
                  <section className="panel p-6">
                    <h2 className="text-xl font-semibold mb-4">
                      Research team access
                    </h2>
                    <p className="muted mb-5">
                      Public registration creates participants. Only
                      administrators can grant research access.
                    </p>
                    {members.data?.items.map(m => (
                      <div
                        key={m.participantId}
                        className="flex flex-wrap items-center gap-4 py-3 border-b border-slate-100"
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
                              await client.invalidateQueries({
                                queryKey: ['members'],
                              });
                            } catch (err) {
                              setError((err as Error).message);
                            }
                          }}
                        >
                          {['participant', 'researcher', 'administrator'].map(
                            r => (
                              <option key={r}>{r}</option>
                            ),
                          )}
                        </select>
                      </div>
                    ))}
                    {members.error && (
                      <Notice error>{members.error.message}</Notice>
                    )}
                  </section>
                )}
              </>
            )}
            {section === 'Downloads' && (
              <section className="panel p-7 space-y-4">
                <h2 className="text-xl font-semibold">
                  Take the evidence with you
                </h2>
                <p className="muted">
                  Download a summary of the current filters, or open a session
                  above for original JSON and its combined CSV. Sample rows
                  repeat their parent measurement: do not add those parent
                  values together.
                </p>
                <Button
                  onClick={() =>
                    download(
                      `/research/sessions?${filters}&format=csv`,
                      'skymeasure-sessions.csv',
                    ).catch(e => setError(e.message))
                  }
                >
                  <ArrowDownToLine size={16} />
                  Filtered session summary CSV
                </Button>
                <p>
                  <a
                    className="underline text-teal-800"
                    href="/measurement-guide.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the measurement guide
                  </a>
                </p>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
function Entry() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const client = useQueryClient();
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedIn(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSignedIn(Boolean(s));
      if (!s) client.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [client]);
  const profile = useQuery<Profile>({
    queryKey: ['profile'],
    queryFn: () => api('/profile'),
    enabled: signedIn === true,
    retry: false,
  });
  if (signedIn === null)
    return (
      <main className="p-12">
        <Notice>Opening research workspace…</Notice>
      </main>
    );
  if (
    signedIn &&
    profile.data &&
    ['researcher', 'administrator'].includes(profile.data.role)
  )
    return <Workspace profile={profile.data} />;
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="panel max-w-xl p-10 md:p-14 space-y-7">
        <RadioTower className="text-teal-800" size={40} />
        <p className="text-xs tracking-widest font-semibold text-teal-800">
          SKYMEASURE RESEARCH
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Every journey has a signal.
        </h1>
        <p className="muted text-lg">
          A private workspace for the team studying how our networks connect
          people on the move.
        </p>
        {signedIn ? (
          <>
            <Notice error={Boolean(profile.error)}>
              {profile.error?.message ??
                (profile.isPending
                  ? 'Checking research access…'
                  : `Researcher access is required. Give your administrator this participant identifier: ${profile.data?.participantId}`)}
            </Notice>
            <Button
              variant="outline"
              onClick={() => supabase.auth.signOut({ scope: 'local' })}
            >
              Sign out
            </Button>
          </>
        ) : (
          <Button
            disabled={!configured}
            onClick={async () => {
              const { error: e } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                  redirectTo: `${window.location.origin}/auth/callback`,
                },
              });
              if (e)
                setError('Could not start Google sign-in. Please try again.');
            }}
          >
            <CircleUserRound size={18} />
            Continue with Google
          </Button>
        )}
        {!configured && (
          <Notice>
            Staging services are not configured yet. Follow the repository setup
            guide before inviting participants.
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        <p className="text-xs muted">
          Access is limited to approved researchers. Signing up does not grant
          access to research data.
        </p>
      </div>
    </main>
  );
}
export default function Page() {
  const [client] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { staleTime: 10000 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Entry />
    </QueryClientProvider>
  );
}

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { NavigationContainer, useIsFocused } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Button,
  Card,
  Chip,
  Divider,
  HelperText,
  List,
  PaperProvider,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import type { Session } from '@supabase/supabase-js';
import {
  auth,
  api,
  configured,
  handleAuthCallback,
  localSession,
  rememberParticipant,
  subscribeParticipant,
  signOutParticipant,
  loadProfile,
  Profile,
  ResearchAccessError,
  secureStorage,
  signIn,
  enrollParticipant,
} from '../auth/client';
import { configureUploads, syncAccount } from '../sync/background';
import { acquireActivity, currentActivity } from '../services/activityGate';
import {
  getServiceStatus,
  startSession,
  stopSession,
  subscribeToStatus,
} from '../services/measurement';
import { measurementStore } from '../storage/database';
import { shareSession } from '../export/shareSession';
import type {
  MeasurementConfig,
  ServiceStatus,
  SessionRecord,
} from '../sessions/types';
import { validateSessionConfig } from '../sessions/config';
import { participantDefaults } from './defaults';
import { theme } from './theme';
import ReferencePanel from '../components/ReferencePanel';
import publicConfig from '../config/public.json';
import FlightHome, { TripHistory } from './FlightHome';
import Enrollment from './Enrollment';
import ParticipationInfo from './ParticipationInfo';

const CONSENT = 'skymeasure-flight-mlab-2026-11-02';

const Tabs = createBottomTabNavigator();
type AccountContext = {
  session: Session;
  profile: Profile;
  updateProfile: (p: Profile) => void;
  status: ServiceStatus | null;
  refresh: () => Promise<void>;
};
const Context = createContext<AccountContext | null>(null);
const useAccount = () => useContext(Context)!;
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Please try again.';
function Page({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.heading}>
      <Text variant="headlineLarge" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="bodyLarge">{subtitle}</Text>
    </View>
  );
}
function Failure({ text }: { text: string | null }) {
  return text ? (
    <HelperText type="error" accessibilityLiveRegion="polite">
      {text}
    </HelperText>
  ) : null;
}
function Toggle({
  title,
  value,
  change,
  disabled,
}: {
  title: string;
  value: boolean;
  change: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.flex} variant="bodyLarge">
        {title}
      </Text>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={change}
        disabled={disabled}
      />
    </View>
  );
}

function Home() {
  const { session, profile } = useAccount();
  const [manual, setManual] = useState(false);
  const researcher = profile.role !== 'participant';
  if (manual && researcher)
    return (
      <>
        <Button onPress={() => setManual(false)}>
          Back to trip collection
        </Button>
        <ManualHome />
      </>
    );
  return (
    <FlightHome
      owner={session.user.id}
      researcher={researcher}
      manual={() => setManual(true)}
    />
  );
}
function ManualHome() {
  const { session, status, refresh } = useAccount();
  const network = useNetInfo();
  const focused = useIsFocused();
  const [referenceBusy, setReferenceBusy] = useState(false);
  const referenceSaved = useCallback(() => {
    refresh().catch(e => setError(message(e)));
    syncAccount().catch(e => setError(message(e)));
  }, [refresh]);
  const [settings, setSettings] =
    useState<MeasurementConfig>(participantDefaults);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const operating = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [latest, setLatest] = useState<SessionRecord | null>(null);
  const active = status?.state !== 'stopped' && status !== null;
  useEffect(() => {
    const update = () =>
      measurementStore
        .accountSessions(session.user.id)
        .then(rows => setLatest(rows[0] ?? null))
        .catch(e => setError(message(e)));
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, [session.user.id, status?.state]);
  const field = <K extends keyof MeasurementConfig>(
    key: K,
    value: MeasurementConfig[K],
  ) => setSettings(s => ({ ...s, [key]: value }));
  async function act() {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError(null);
    try {
      if (active) await stopSession();
      else {
        const config = validateSessionConfig({
          ...settings,
          collectionMode: 'research_manual',
        });
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          const result = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
          if (result !== PermissionsAndroid.RESULTS.GRANTED)
            setNotice(
              'Notifications are off. You can still stop the session here.',
            );
        }
        await startSession(config, undefined, session.user.id);
      }
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      operating.current = false;
    }
  }
  return (
    <Page>
      <Heading
        title="Your network, understood."
        subtitle="A small contribution to better connected journeys."
      />
      <Chip style={styles.chip}>
        {network.isConnected
          ? network.type === 'wifi'
            ? 'Connected to Wi-Fi'
            : 'Connected to mobile or another network'
          : 'Offline · sessions save on this phone'}
      </Chip>
      <Card mode="contained" style={styles.hero}>
        <Card.Content>
          <Text variant="labelLarge">
            {active ? 'MEASUREMENT IN PROGRESS' : 'READY WHEN YOU ARE'}
          </Text>
          <Text variant="displaySmall" style={styles.space}>
            {active
              ? `${Math.floor((status?.elapsedMs ?? 0) / 60000)} min`
              : 'Make a contribution'}
          </Text>
          <Text variant="bodyLarge">
            {active
              ? `${
                  status?.measurementCount ?? 0
                } observations saved. You can lock your screen. Uploads wait until this session finishes.`
              : 'Run a short session while you travel or use your usual network. Stop whenever you need to.'}
          </Text>
          <Button
            mode="contained"
            style={styles.space}
            contentStyle={styles.control}
            onPress={act}
            loading={busy}
            disabled={busy || referenceBusy || !status}
          >
            {active ? 'Stop session' : 'Start session'}
          </Button>
          <Text variant="bodyMedium">
            {active
              ? 'Your measurements are saved as the session runs.'
              : '10 minutes by default · 100 MiB allowance · battery safeguard'}
          </Text>
        </Card.Content>
      </Card>
      <Failure text={error ?? status?.error ?? null} />
      {!status && (
        <Button onPress={() => refresh().catch(e => setError(message(e)))}>
          Retry session status
        </Button>
      )}
      {notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
      {!active && latest && (
        <Card mode="outlined">
          <Card.Content>
            <Text variant="titleLarge">Your latest contribution</Text>
            <Text>
              {latest.measurementCount} measurements saved ·{' '}
              {latest.uploadStatus ?? 'Saved locally'}
            </Text>
            <Text>View results and upload progress in Sessions.</Text>
          </Card.Content>
        </Card>
      )}
      {!active && (
        <>
          <TextInput
            mode="outlined"
            label="Session duration (minutes)"
            keyboardType="numeric"
            value={String((settings.maxDurationMs ?? 600000) / 60000)}
            onChangeText={v => field('maxDurationMs', Number(v) * 60000)}
          />
          <TextInput
            mode="outlined"
            label="Data allowance (MiB)"
            keyboardType="numeric"
            value={String((settings.maxPayloadBytes ?? 0) / 1048576)}
            onChangeText={v =>
              field('maxPayloadBytes', Math.round(Number(v) * 1048576))
            }
          />
          <Text variant="bodySmall">
            Allowance covers test payloads; network headers and uploads use
            additional data. Collection stops when the allowance or battery
            limit is reached.
          </Text>
          <TextInput
            mode="outlined"
            label="Flight or provider notes (optional)"
            value={settings.notes ?? ''}
            maxLength={500}
            onChangeText={v => field('notes', v)}
          />
          <List.Accordion
            title="Advanced settings"
            expanded={advanced}
            onPress={() => setAdvanced(!advanced)}
          >
            <Toggle
              title="ICMP echo probes"
              value={Boolean(settings.icmpHost)}
              change={v =>
                setSettings(s => ({
                  ...s,
                  icmpHost: v ? 'google.com' : '',
                  icmpBurstEnabled: v,
                }))
              }
            />
            <Toggle
              title="TCP connections"
              value={Boolean(settings.tcpEnabled)}
              change={v => field('tcpEnabled', v)}
            />
            <Toggle
              title="Traceroute probes"
              value={Boolean(settings.tracerouteHost)}
              change={v => field('tracerouteHost', v ? 'google.com' : '')}
            />
            <Toggle
              title="UDP echo probes"
              value={Boolean(settings.udpHost)}
              disabled={!participantDefaults.udpHost}
              change={v =>
                field('udpHost', v ? participantDefaults.udpHost : '')
              }
            />
            {!participantDefaults.udpHost && (
              <Text>
                UDP is unavailable until the study server is configured.
              </Text>
            )}
            <Toggle
              title="HTTP transfers"
              value={Boolean(settings.httpEnabled)}
              change={v =>
                setSettings(s => ({
                  ...s,
                  httpEnabled: v,
                  loadedLatencyEnabled: v && s.loadedLatencyEnabled,
                }))
              }
            />
            <Toggle
              title="Latency during HTTP transfers"
              value={Boolean(settings.loadedLatencyEnabled)}
              disabled={!settings.httpEnabled}
              change={v => field('loadedLatencyEnabled', v)}
            />
            {(['downloadBytes', 'uploadBytes'] as const).map(key => (
              <TextInput
                key={key}
                mode="outlined"
                label={`${
                  key === 'downloadBytes' ? 'Download' : 'Upload'
                } size (MiB)`}
                keyboardType="numeric"
                value={String(settings[key] / 1048576)}
                onChangeText={v => field(key, Math.round(Number(v) * 1048576))}
              />
            ))}
            {(
              [
                'rttIntervalMs',
                'downloadIntervalMs',
                'uploadIntervalMs',
                'diagnosticsIntervalMs',
              ] as const
            ).map((key, i) => (
              <TextInput
                key={key}
                mode="outlined"
                label={`${
                  ['Latency', 'Download', 'Upload', 'Packet test'][i]
                } interval (seconds)`}
                keyboardType="numeric"
                value={String((settings[key] ?? 60000) / 1000)}
                onChangeText={v => field(key, Number(v) * 1000)}
              />
            ))}
            <TextInput
              mode="outlined"
              label="Stop below battery (%)"
              keyboardType="numeric"
              value={String(settings.minimumBatteryPercent)}
              onChangeText={v => field('minimumBatteryPercent', Number(v))}
            />
          </List.Accordion>
        </>
      )}
      <ReferencePanel
        participant={{
          ownerId: session.user.id,
          collectorVersion: publicConfig.collectorVersion,
        }}
        idle={focused && !active && !busy && status !== null}
        onBusyChange={setReferenceBusy}
        onSaved={referenceSaved}
      />
    </Page>
  );
}

function Sessions() {
  const { session, status } = useAccount();
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [remoteOffset, setRemoteOffset] = useState(0);
  const [hasMoreRemote, setHasMoreRemote] = useState(false);
  const [remoteUnavailable, setRemoteUnavailable] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remote, setRemote] = useState<
    {
      id: string;
      collectedAt: string;
      measurements: number;
      uploadStatus: string;
    }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{
    id: string;
    items: { label: string; value: string }[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRecordings, setShowRecordings] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setRows(await measurementStore.accountSessions(session.user.id));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [session.user.id]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh, status?.state]);
  useEffect(() => {
    let alive = true;
    setRemoteLoading(true);
    api<{ items: typeof remote }>(
      `/sessions?offset=${remoteOffset}&limit=50`,
      {},
      session.user.id,
    )
      .then(r => {
        if (alive) {
          setRemote(previous =>
            remoteOffset ? [...previous, ...r.items] : r.items,
          );
          setHasMoreRemote(r.items.length === 50);
          setRemoteUnavailable(false);
        }
      })
      .catch(() => {
        if (alive) setRemoteUnavailable(true);
      })
      .finally(() => {
        if (alive) setRemoteLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [session.user.id, remoteOffset]);
  async function inspect(id: string) {
    try {
      if (
        !(await measurementStore.accountSessions(session.user.id)).some(
          s => s.id === id,
        )
      )
        throw new Error('Session is not available for this account');
      const measurements = await measurementStore.listMeasurements(id, 10000);
      const groups = new Map<
        string,
        { total: number; failed: number; latest?: string }
      >();
      for (const { measurement: m } of measurements) {
        const g: { total: number; failed: number; latest?: string } =
          groups.get(m.type) ?? { total: 0, failed: 0 };
        if (!g.latest && m.success && m.value != null)
          g.latest = `${m.value.toFixed(2)} ${m.unit}`;
        g.total++;
        if (!m.success) g.failed++;
        groups.set(m.type, g);
      }
      setDetails({
        id,
        items: [...groups].map(([type, g]) => ({
          label:
            (
              {
                icmp_burst: 'ICMP echo',
                icmp_rtt: 'ICMP echo',
                tcp_connect: 'TCP connection',
                udp_echo: 'UDP echo',
                traceroute: 'Traceroute',
                http_rtt: 'HTTP latency',
                loaded_download: 'Latency during download',
                loaded_upload: 'Latency during upload',
                ndt7_download: 'M-Lab download speed',
                ndt7_upload: 'M-Lab upload speed',
              } as Record<string, string>
            )[type] ?? type.replaceAll('_', ' '),
          value: `${g.total} measurements · ${
            g.failed
          } unsuccessful. Latest result: ${g.latest ?? 'unavailable'}.`,
        })),
      });
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <Page>
      <Heading
        title="Your contributions"
        subtitle="Every journey makes a difference."
      />
      <Button
        mode="outlined"
        disabled={status?.state !== 'stopped'}
        onPress={async () => {
          try {
            await syncAccount();
            await refresh();
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        Retry uploads
      </Button>
      <Failure text={error} />
      {loading && <ActivityIndicator />}
      {remoteLoading && <Text>Checking uploaded account history…</Text>}
      {remoteUnavailable && (
        <Text>
          Uploaded account history is unavailable right now. Your sessions saved
          on this phone are shown below.
        </Text>
      )}
      {!loading &&
        !remoteLoading &&
        !remoteUnavailable &&
        !rows.length &&
        !remote.length && (
          <Card>
            <Card.Content>
              <Text variant="titleLarge">Your first session starts here</Text>
              <Text>
                Start from Home. Every saved contribution will appear here, even
                when you are offline.
              </Text>
            </Card.Content>
          </Card>
        )}
      <TripHistory owner={session.user.id} />
      {rows.some(s => s.config.tripId) && (
        <Button onPress={() => setShowRecordings(v => !v)}>
          {showRecordings ? 'Hide saved recordings' : 'View saved recordings'}
        </Button>
      )}
      {rows
        .filter(s => !s.config.tripId || showRecordings)
        .map(s => (
          <Card key={s.id} mode="outlined" onPress={() => inspect(s.id)}>
            <Card.Content>
              <Text variant="titleMedium">
                {s.config.tripId
                  ? `Recording ${(s.config.segmentIndex ?? 0) + 1} · `
                  : ''}
                {new Date(s.startedAt).toLocaleString()}
              </Text>
              <Text>
                {s.measurementCount} measurements ·{' '}
                {s.endedAt
                  ? `${Math.max(
                      0,
                      Math.round(
                        (Date.parse(s.endedAt) - Date.parse(s.startedAt)) /
                          60000,
                      ),
                    )} minutes`
                  : 'In progress'}
              </Text>
              <Chip style={styles.chip}>
                {s.state === 'active'
                  ? 'Recording'
                  : s.uploadStatus ?? 'Saved locally'}
              </Chip>
            </Card.Content>
          </Card>
        ))}
      {remote
        .filter(r => !rows.some(s => s.id === r.id))
        .map(s => (
          <Card key={s.id}>
            <Card.Content>
              <Text>{new Date(s.collectedAt).toLocaleString()}</Text>
              <Text>
                {s.measurements} measurements · {s.uploadStatus} · from your
                account
              </Text>
            </Card.Content>
          </Card>
        ))}
      {hasMoreRemote && (
        <Button
          disabled={remoteLoading}
          onPress={() => setRemoteOffset(offset => offset + 50)}
        >
          Load older account sessions
        </Button>
      )}
      {details && (
        <Card mode="contained">
          <Card.Content>
            <Text variant="titleLarge">Session results</Text>
            {details.items.map(i => (
              <List.Item key={i.label} title={i.label} description={i.value} />
            ))}
            <Text>
              Unsuccessful probes are useful research evidence. Unavailable
              values are not zero.
            </Text>
            <Button
              onPress={async () => {
                try {
                  if (
                    !(
                      await measurementStore.accountSessions(session.user.id)
                    ).some(s => s.id === details.id)
                  )
                    throw new Error('Account changed');
                  await shareSession(details.id, 'csv');
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              Export this session
            </Button>
            <Button onPress={() => setDetails(null)}>Close results</Button>
          </Card.Content>
        </Card>
      )}
    </Page>
  );
}

function Account() {
  const { session, profile, updateProfile, status } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState(0);
  const [legacy, setLegacy] = useState<SessionRecord[]>([]);
  useEffect(() => {
    measurementStore
      .accountTrips(session.user.id)
      .then(rows => setTotals(rows.length))
      .catch(() => {});
  }, [session.user.id, status]);
  async function operation(action: () => Promise<void>) {
    if (currentActivity()) {
      setError('Wait for collection or the current upload to finish.');
      return;
    }
    const release = acquireActivity('account');
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      release();
    }
  }
  async function signOut() {
    await signOutParticipant();
  }
  return (
    <Page>
      <Heading
        title="Your account"
        subtitle="You choose when and how to contribute."
      />
      <Card mode="outlined">
        <Card.Content>
          <Text variant="titleLarge">
            {session.user.user_metadata.full_name ?? 'Research participant'}
          </Text>
          <Text>{session.user.email}</Text>
          <Text style={styles.space}>{totals} trips saved on this phone</Text>
        </Card.Content>
      </Card>
      <Toggle
        title="Allow uploads on mobile data"
        disabled={busy}
        value={profile.mobileUploads}
        change={v =>
          operation(async () => {
            const p = await api<Profile>(
              '/profile',
              { method: 'PATCH', body: JSON.stringify({ mobileUploads: v }) },
              session.user.id,
            );
            await secureStorage.setItem(
              `profile.${session.user.id}`,
              JSON.stringify(p),
            );
            updateProfile(p);
          })
        }
      />
      <Text>
        Your contributions upload over Wi-Fi unless you allow mobile data.
      </Text>
      <Button
        mode="outlined"
        disabled={busy}
        onPress={() =>
          operation(async () => {
            if (Platform.OS === 'android')
              await PermissionsAndroid.request(
                PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
              );
          })
        }
      >
        Optional Wi-Fi details
      </Button>
      <Text>
        Android may require location permission and system Location to reveal
        Wi-Fi identifiers. Collection uses ASN matching and works without these
        optional details. Automatic trips do not collect GPS movement.
      </Text>
      <Divider />
      <Text variant="titleLarge">Research participation</Text>
      <ParticipationInfo />

      <Failure text={error} />
      <Button
        mode="outlined"
        disabled={busy || status?.state !== 'stopped'}
        onPress={() =>
          session.user.is_anonymous
            ? Alert.alert(
                'Reset this installation’s identity?',
                'Pending old records remain on this phone but cannot be uploaded by the new identity. Export them first. This cannot recover records removed by uninstalling.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Reset identity',
                    style: 'destructive',
                    onPress: () => operation(signOut),
                  },
                ],
              )
            : operation(signOut)
        }
      >
        {session.user.is_anonymous ? 'Reset anonymous identity' : 'Sign out'}
      </Button>
      <Text>
        Pending sessions stay on this phone and remain private to your account.
      </Text>
      <Button
        mode="outlined"
        disabled={busy || status?.state !== 'stopped'}
        onPress={() =>
          operation(async () => {
            if (session.user.is_anonymous)
              updateProfile(await loadProfile(session.user.id));
            else await signIn();
          })
        }
      >
        {session.user.is_anonymous
          ? 'Retry research access'
          : 'Confirm Google sign-in'}
      </Button>
      <Text>
        If your login has expired, confirm it to resume uploads. Saved sessions
        remain available offline.
      </Text>
      <Button
        textColor={theme.colors.error}
        disabled={busy || status?.state !== 'stopped'}
        onPress={() =>
          Alert.alert(
            'Delete your account and research data?',
            'Uploaded and locally saved sessions for this account will be removed. This cannot be undone. The study team also completes deletion of your sign-in identity.',
            [
              { text: 'Keep account', style: 'cancel' },
              {
                text: 'Delete my data',
                style: 'destructive',
                onPress: () =>
                  operation(async () => {
                    const deletionKey = `deletion-confirmed.${session.user.id}`;
                    if (!(await secureStorage.getItem(deletionKey))) {
                      await api(
                        '/account',
                        { method: 'DELETE' },
                        session.user.id,
                      );
                      await secureStorage.setItem(deletionKey, 'true');
                    }
                    await measurementStore.deleteAccountRecords(
                      session.user.id,
                    );
                    await secureStorage.removeItem(
                      `profile.${session.user.id}`,
                    );
                    await secureStorage.removeItem(deletionKey);
                    await signOut();
                  }),
              },
            ],
          )
        }
      >
        Delete account and data
      </Button>
      <List.Accordion
        title="Historical experiments on this phone"
        description="Older ownerless experiments are never uploaded to your account"
        onPress={() =>
          measurementStore
            .listSessions(10000)
            .then(rows => setLegacy(rows.filter(r => !r.ownerId)))
            .catch(e => setError(message(e)))
        }
      >
        {legacy.map(s => (
          <Button
            key={s.id}
            onPress={() =>
              operation(async () => {
                const saved = await measurementStore.getSession(s.id);
                if (saved?.ownerId)
                  throw new Error('Not a historical experiment');
                await shareSession(s.id, 'json');
              })
            }
          >
            Export {new Date(s.startedAt).toLocaleDateString()}
          </Button>
        ))}
      </List.Accordion>
    </Page>
  );
}

function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    setStatus(await getServiceStatus());
    setError(null);
  }, []);
  useEffect(() => {
    let alive = true;
    const apply = async (next: Session | null) => {
      const token = ++revision.current;
      setSession(next);
      setProfile(null);
      setError(null);
      try {
        if (next) {
          const cached = await secureStorage.getItem(`profile.${next.user.id}`);
          if (cached && alive && token === revision.current) {
            setProfile(JSON.parse(cached));
            setLoading(false);
          }
          // Cached consent permits offline collection. A failed online refresh
          // never grants roles or erases the previously accepted local profile.
          try {
            const p = await loadProfile(next.user.id);
            if (alive && token === revision.current) setProfile(p);
          } catch (e) {
            if (alive && token === revision.current) {
              // Offline cache remains useful, but an explicit deletion response
              // must not keep presenting a deleted account as ready to collect.
              if (
                e instanceof ResearchAccessError &&
                e.reason === 'account_deleted'
              )
                setProfile(null);
              if (!cached || e instanceof ResearchAccessError)
                setError(message(e));
            }
          }
        }
      } finally {
        if (alive && token === revision.current) setLoading(false);
      }
    };
    localSession()
      .then(apply)
      .catch(e => {
        setError(message(e));
        setLoading(false);
      });
    const { data: listener } = auth.auth.onAuthStateChange((event, next) => {
      // Auth callbacks must not await other Supabase methods under its lock.
      if (event === 'SIGNED_IN' && next)
        setTimeout(() => {
          rememberParticipant(next).catch(e => setError(message(e)));
        }, 0);
    });
    const removeParticipant = subscribeParticipant(next => {
      apply(next);
    });
    const links = Linking.addEventListener('url', e =>
      handleAuthCallback(e.url).catch(err => setError(message(err))),
    );
    Linking.getInitialURL()
      .then(url => {
        if (url) return handleAuthCallback(url);
      })
      .catch(e => setError(message(e)));
    refresh().catch(e => setError(message(e)));
    const unsubscribe = subscribeToStatus(s => {
      setStatus(s);
      if (s.state === 'stopped') syncAccount().catch(e => setError(message(e)));
    });
    configureUploads().catch(() =>
      setError(
        'Background retries are unavailable. Reopen the app to retry uploads.',
      ),
    );
    const state = AppState.addEventListener('change', next => {
      if (next === 'active') {
        refresh().catch(e => setError(message(e)));
        syncAccount().catch(() => {});
      }
    });
    const network = NetInfo.addEventListener(() => {
      syncAccount().catch(() => {});
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
      removeParticipant();
      links.remove();
      unsubscribe();
      state.remove();
      network();
    };
  }, [refresh]);
  useEffect(() => {
    if (session && profile?.consentVersion) syncAccount().catch(() => {});
  }, [session, profile]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <Page>
        <Heading
          title="SkyMeasure"
          subtitle="Getting your contributions ready…"
        />
        <ActivityIndicator />
      </Page>
    );
  if (!session)
    return (
      <Page>
        <View style={styles.brand}>
          <MaterialDesignIcons
            name="airplane"
            size={24}
            color={theme.colors.primary}
          />
          <Text variant="titleMedium" style={styles.brandName}>
            SkyMeasure
          </Text>
        </View>
        <View
          style={styles.welcomeArtwork}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.artIcon}>
            <MaterialDesignIcons
              name="airplane-takeoff"
              size={42}
              color={theme.colors.primary}
            />
          </View>
          <View style={styles.flightPath} />
          <View style={styles.artIcon}>
            <MaterialDesignIcons
              name="wifi"
              size={36}
              color={theme.colors.primary}
            />
          </View>
        </View>
        <Heading
          title="Better Wi-Fi. Better journeys."
          subtitle="Help us understand internet in the sky."
        />
        <Enrollment
          onEnroll={token => perform(() => enrollParticipant(token))}
          busy={busy}
        />
        <Text style={styles.welcomeNote}>
          No account needed. Just bring your phone.
        </Text>
        <Button
          onPress={() => perform(signIn)}
          disabled={busy}
          textColor={theme.colors.onSurfaceVariant}
        >
          Researcher Google sign-in
        </Button>
        {!configured && (
          <Text>The app can’t connect yet. Please contact the study team.</Text>
        )}
        <Failure text={error} />
      </Page>
    );
  if (!profile)
    return (
      <Page>
        <Heading
          title="Reconnect to SkyMeasure"
          subtitle="Retry your connection or choose your Google account again."
        />
        <Failure text={error} />
        <Button
          mode="contained"
          disabled={busy}
          loading={busy}
          onPress={() =>
            perform(async () => {
              const release = acquireActivity('account');
              try {
                await signIn();
              } finally {
                release();
              }
            })
          }
        >
          Sign in with Google
        </Button>
        <Button
          disabled={busy}
          onPress={() =>
            perform(async () => setProfile(await loadProfile(session.user.id)))
          }
        >
          Retry connection
        </Button>
        <Text>
          Choosing a different account keeps existing recordings with their
          original identity.
        </Text>
        <Button disabled={busy} onPress={() => perform(signOutParticipant)}>
          Sign out
        </Button>
      </Page>
    );
  if (profile.consentVersion !== CONSENT)
    return (
      <Page>
        <Heading
          title="Before you begin"
          subtitle="How SkyMeasure uses your data."
        />
        <ParticipationInfo />
        <Button
          mode="contained"
          style={styles.primaryButton}
          contentStyle={styles.primaryButtonContent}
          loading={busy}
          disabled={busy}
          onPress={() =>
            perform(async () => {
              const p = await api<Profile>(
                '/profile',
                {
                  method: 'PATCH',
                  body: JSON.stringify({
                    consentVersion: CONSENT,
                    mobileUploads: false,
                  }),
                },
                session.user.id,
              );
              await secureStorage.setItem(
                `profile.${session.user.id}`,
                JSON.stringify(p),
              );
              setProfile(p);
            })
          }
        >
          I agree to participate
        </Button>
        <Button
          onPress={() =>
            perform(async () => {
              await signOutParticipant();
            })
          }
        >
          Not now
        </Button>
        <Failure text={error} />
      </Page>
    );
  return (
    <Context.Provider
      key={session.user.id}
      value={{ session, profile, updateProfile: setProfile, status, refresh }}
    >
      {error && <Failure text={error} />}
      <NavigationContainer>
        <Tabs.Navigator
          screenOptions={({ route }) => ({
            headerTitle: 'SkyMeasure',
            headerShadowVisible: false,
            tabBarActiveTintColor: theme.colors.primary,
            tabBarStyle: styles.tabBar,
            tabBarLabelStyle: styles.tabLabel,
            tabBarIcon: ({ color, size }) => (
              <MaterialDesignIcons
                name={
                  route.name === 'Home'
                    ? 'home-outline'
                    : route.name === 'Sessions'
                    ? 'airplane'
                    : 'account-circle-outline'
                }
                color={color}
                size={size}
              />
            ),
          })}
        >
          <Tabs.Screen name="Home" component={Home} />
          <Tabs.Screen
            name="Sessions"
            component={Sessions}
            options={{ tabBarLabel: 'Trips' }}
          />
          <Tabs.Screen name="Account" component={Account} />
        </Tabs.Navigator>
      </NavigationContainer>
    </Context.Provider>
  );
}
export default function SkyMeasure() {
  return (
    <SafeAreaProvider>
      <PaperProvider
        theme={theme}
        settings={{
          icon: props => (
            <MaterialDesignIcons
              {...props}
              name={
                props.name as React.ComponentProps<
                  typeof MaterialDesignIcons
                >['name']
              }
            />
          ),
        }}
      >
        <StatusBar barStyle="dark-content" />
        <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
          <Root />
        </SafeAreaView>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F5F8FA' },
  page: {
    padding: 24,
    gap: 20,
    paddingBottom: 40,
    flexGrow: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  heading: { gap: 12, marginVertical: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  brandName: { fontWeight: '700', letterSpacing: 0.2 },
  welcomeArtwork: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8F5F1',
    borderRadius: 28,
    padding: 28,
    marginTop: 16,
    minHeight: 150,
  },
  artIcon: {
    backgroundColor: '#FFFFFF',
    width: 76,
    height: 76,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flightPath: {
    flex: 1,
    maxWidth: 80,
    borderTopWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#8DBEB4',
    marginHorizontal: 12,
  },
  welcomeNote: { color: theme.colors.onSurfaceVariant, textAlign: 'center' },
  primaryButton: { borderRadius: 18 },
  primaryButtonContent: { minHeight: 56 },
  hero: { backgroundColor: '#D9F2EE', paddingVertical: 12 },
  chip: { alignSelf: 'flex-start', marginTop: 8 },
  control: { minHeight: 56 },
  space: { marginVertical: 20 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    gap: 16,
  },
  flex: { flex: 1 },
  tabBar: { minHeight: 72 },
  tabLabel: { fontSize: 13, paddingBottom: 6 },
});

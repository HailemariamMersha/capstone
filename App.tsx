import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Button,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  getServiceStatus,
  isMeasurementSupported,
  startSession,
  stopSession,
  subscribeToStatus,
} from './src/services/measurement';
import type { ServiceStatus } from './src/services/measurement';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function App() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const operation = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    // Ignore a query result if a newer native event arrived while it was in flight.
    const requestedRevision = ++revision.current;
    try {
      const current = await getServiceStatus();
      if (mounted.current && revision.current === requestedRevision) {
        setStatus(current);
        setError(null);
      }
    } catch (err) {
      if (mounted.current && revision.current === requestedRevision) {
        setError(message(err));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!isMeasurementSupported) {
      return () => {
        mounted.current = false;
      };
    }
    const unsubscribe = subscribeToStatus(current => {
      revision.current += 1;
      if (mounted.current) {
        setStatus(current);
      }
    });
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') {
        refresh();
      }
    });
    refresh();
    return () => {
      mounted.current = false;
      revision.current += 1;
      unsubscribe();
      appState.remove();
    };
  }, [refresh]);

  async function control(start: boolean) {
    if (operation.current) {
      return;
    }
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      if (start) {
        if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
          const permission = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
          if (mounted.current) {
            setNotice(
              permission === PermissionsAndroid.RESULTS.GRANTED
                ? null
                : 'Notifications are disabled. The service can run, but its notification may be hidden. Stop the session here.',
            );
          }
        }
        if (!mounted.current) {
          return;
        }
        await startSession({});
      } else {
        await stopSession();
      }
      await refresh();
    } catch (err) {
      if (mounted.current) {
        setError(message(err));
      }
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  const transitioning =
    status?.state === 'starting' || status?.state === 'stopping';
  const disabled = busy || transitioning || !isMeasurementSupported || !status;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>CAPSTONE · MILESTONE 1</Text>
          <Text style={styles.title}>Satellite network measurements</Text>
          <Text style={styles.description}>
            Start a native service session to verify background operation.
            Network probes and local history arrive in later milestones.
          </Text>
          {!isMeasurementSupported && (
            <Text accessibilityRole="alert" style={styles.error}>
              This milestone requires the Android native build.
            </Text>
          )}
          <View style={styles.card}>
            <Text style={styles.label}>Service status</Text>
            <Text testID="service-state" style={styles.state}>
              {status?.state ?? 'unavailable'}
            </Text>
            <Text selectable>Session: {status?.sessionId ?? '—'}</Text>
            <Text>
              Started:{' '}
              {status?.startedAt
                ? new Date(status.startedAt).toLocaleString()
                : '—'}
            </Text>
            <Text>
              Elapsed at last update:{' '}
              {Math.floor((status?.elapsedMs ?? 0) / 1000)} seconds
            </Text>
            <Text>Native heartbeats: {status?.heartbeatCount ?? 0}</Text>
            <Text>
              Last heartbeat:{' '}
              {status?.lastHeartbeatAt
                ? new Date(status.lastHeartbeatAt).toLocaleTimeString()
                : '—'}
            </Text>
          </View>
          <View style={styles.button}>
            <Button
              title="Start session"
              disabled={disabled || status?.state !== 'stopped'}
              onPress={() => control(true)}
            />
          </View>
          <View style={styles.button}>
            <Button
              title="Stop session"
              disabled={disabled || status?.state !== 'running'}
              onPress={() => control(false)}
            />
          </View>
          <View style={styles.button}>
            <Button
              title="Refresh status"
              disabled={busy || !isMeasurementSupported}
              onPress={refresh}
            />
          </View>
          {(error || status?.error) && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error || status?.error}
            </Text>
          )}
          {notice && (
            <Text accessibilityRole="alert" style={styles.description}>
              {notice}
            </Text>
          )}
          <Text style={styles.description}>
            Lock the phone and reopen this screen to check the same session.
            Force-stopping the app ends this milestone’s in-memory session.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f7fa' },
  content: { padding: 24, gap: 16 },
  eyebrow: {
    fontSize: 12,
    fontWeight: '700',
    color: '#375976',
    letterSpacing: 1,
  },
  title: { fontSize: 30, fontWeight: '700', color: '#112d42' },
  description: { fontSize: 15, lineHeight: 22, color: '#40576a' },
  card: { padding: 20, gap: 10, borderRadius: 12, backgroundColor: '#ffffff' },
  label: { fontSize: 14, color: '#40576a' },
  state: { fontSize: 24, fontWeight: '600', color: '#112d42' },
  button: { minHeight: 44 },
  error: { color: '#a51f2b', fontSize: 15 },
});

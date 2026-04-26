import React, {useEffect, useRef, useState} from 'react';
import {
  Alert,
  AppState,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import ControlPanel from './src/components/ControlPanel';
import LogList from './src/components/LogList';
import {
  ensureCsvExists,
  getMeasurementCount,
  getCsvPath,
  readRecentCsvRows,
} from './src/services/csvService';
import {
  isAndroidBackgroundMeasurementRunning,
  startAndroidBackgroundMeasurement,
  stopAndroidBackgroundMeasurement,
} from './src/services/backgroundService';
import {
  isBatteryOptimizationDisabled,
  requestBatteryOptimizationExemption,
} from './src/services/deviceSettingsService';
import {
  hasPromptBeenShown,
  markPromptAsShown,
} from './src/services/preferencesService';
import {performMeasurement} from './src/services/measurementService';
import {normalizeUrl} from './src/utils/url';

const MAX_LOG_ITEMS = 30;
const PING_INTERVAL_MS = 10000;
const LOG_REFRESH_INTERVAL_MS = 3000;
const NOTIFICATION_PROMPT_KEY = 'notification_prompt_shown';
const BATTERY_PROMPT_KEY = 'battery_prompt_shown';

export default function App() {
  const [urlInput, setUrlInput] = useState('');
  const [status, setStatus] = useState('Idle');
  const [lastLatency, setLastLatency] = useState(null);
  const [appState, setAppState] = useState(AppState.currentState);
  const [recentLogs, setRecentLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [requestCount, setRequestCount] = useState(0);
  const [batteryOptimizationDisabled, setBatteryOptimizationDisabled] = useState(false);

  const appStateRef = useRef(AppState.currentState);
  const foregroundIntervalRef = useRef(null);
  const activeTargetUrlRef = useRef('');
  const isMountedRef = useRef(true);
  const measurementEnabledRef = useRef(false);
  const transitionInProgressRef = useRef(false);
  const isForegroundPingInFlightRef = useRef(false);
  const syncAndroidMeasurementModeRef = useRef(null);
  const startupChecksRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      console.log(
        `[app-state] Changed from ${appStateRef.current} to ${nextAppState}`,
      );
      appStateRef.current = nextAppState;
      setAppState(nextAppState);

      if (
        Platform.OS === 'android' &&
        measurementEnabledRef.current &&
        syncAndroidMeasurementModeRef.current
      ) {
        syncAndroidMeasurementModeRef.current(nextAppState);
      }

      if (nextAppState === 'active') {
        refreshLogsAndStatus();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    refreshLogsAndStatus();

    const logsTimer = setInterval(() => {
      refreshLogsAndStatus();
    }, LOG_REFRESH_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(logsTimer);

      if (foregroundIntervalRef.current) {
        clearInterval(foregroundIntervalRef.current);
        foregroundIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (startupChecksRef.current) {
      return;
    }

    startupChecksRef.current = true;

    const runStartupChecks = async () => {
      if (Platform.OS !== 'android') {
        return;
      }

      const notificationPromptShown = await hasPromptBeenShown(
        NOTIFICATION_PROMPT_KEY,
      );

      if (!notificationPromptShown) {
        await requestAndroidNotificationPermission();
        await markPromptAsShown(NOTIFICATION_PROMPT_KEY);
      }

      const batteryPromptShown = await hasPromptBeenShown(BATTERY_PROMPT_KEY);
      const batteryUnrestricted = await isBatteryOptimizationDisabled();

      if (!batteryPromptShown && !batteryUnrestricted) {
        await requestBatteryOptimizationExemption();
        await markPromptAsShown(BATTERY_PROMPT_KEY);
      }

      await refreshLogsAndStatus();
    };

    runStartupChecks();
  }, []);

  const refreshLogsAndStatus = async () => {
    try {
      const logs = await readRecentCsvRows(MAX_LOG_ITEMS);
      const totalRequests = await getMeasurementCount();
      const batteryUnrestricted = await isBatteryOptimizationDisabled();
      if (!isMountedRef.current) {
        return;
      }

      setRecentLogs(logs);
      setRequestCount(totalRequests);
      setBatteryOptimizationDisabled(batteryUnrestricted);

      if (logs.length > 0) {
        setLastLatency(logs[0].latencyMs);
      } else {
        setLastLatency(null);
      }

      if (Platform.OS === 'android') {
        const running = isAndroidBackgroundMeasurementRunning();
        setIsRunning(running || Boolean(foregroundIntervalRef.current));

        if (running) {
          setStatus(currentStatus =>
            currentStatus === 'Idle' || currentStatus === 'Stopped'
              ? 'Running'
              : currentStatus,
          );
        }
      }
    } catch (error) {
      console.log(`[logs] Failed to refresh logs: ${error?.message || String(error)}`);
    }
  };

  const requestAndroidNotificationPermission = async () => {
    if (Platform.OS !== 'android' || Platform.Version < 33) {
      return true;
    }

    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        {
          title: 'Notification Permission',
          message:
            'Allow notifications so the Android foreground service stays visible while measurements run in the background.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );
      console.log(`[permissions] POST_NOTIFICATIONS result: ${result}`);
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch (error) {
      console.log(
        `[permissions] Failed to request notification permission: ${error?.message || String(error)}`,
      );
      return false;
    }
  };

  const stopForegroundLoop = () => {
    if (foregroundIntervalRef.current) {
      clearInterval(foregroundIntervalRef.current);
      foregroundIntervalRef.current = null;
      console.log('[loop] Foreground measurement loop stopped');
    }
  };

  const runForegroundMeasurementOnce = async targetUrl => {
    if (isForegroundPingInFlightRef.current) {
      console.log('[loop] Foreground ping skipped because a previous ping is still running');
      return;
    }

    isForegroundPingInFlightRef.current = true;

    try {
      await performMeasurement({
        appState: appStateRef.current,
        targetUrl,
      });
      await refreshLogsAndStatus();
    } finally {
      isForegroundPingInFlightRef.current = false;
    }
  };

  const startForegroundLoop = async targetUrl => {
    if (foregroundIntervalRef.current) {
      console.log('[loop] Foreground loop start ignored because it is already running');
      return;
    }

    setIsRunning(true);
    setStatus('Running');

    await runForegroundMeasurementOnce(targetUrl);

    foregroundIntervalRef.current = setInterval(async () => {
      await runForegroundMeasurementOnce(activeTargetUrlRef.current);
    }, PING_INTERVAL_MS);

    console.log(`[loop] Foreground measurement loop started for ${targetUrl}`);
  };

  const syncAndroidMeasurementMode = async nextAppState => {
    if (Platform.OS !== 'android' || !measurementEnabledRef.current) {
      return;
    }

    if (!activeTargetUrlRef.current) {
      console.log('[background-service] Sync skipped because no active target URL is set');
      return;
    }

    if (transitionInProgressRef.current) {
      console.log(
        `[background-service] Sync skipped because a transition is already running for appState=${nextAppState}`,
      );
      return;
    }

    transitionInProgressRef.current = true;

    try {
      if (nextAppState === 'active') {
        if (isAndroidBackgroundMeasurementRunning()) {
          console.log('[background-service] App returned to foreground, stopping Android background service');
          await stopAndroidBackgroundMeasurement();
        }

        await startForegroundLoop(activeTargetUrlRef.current);
        setStatus('Running');
        return;
      }

      stopForegroundLoop();

      if (isAndroidBackgroundMeasurementRunning()) {
        setStatus('Running');
        return;
      }

      console.log(
        `[background-service] App moved to ${nextAppState}, starting Android background service`,
      );
      await startAndroidBackgroundMeasurement(activeTargetUrlRef.current);
      setIsRunning(true);
      setStatus('Running');
    } catch (error) {
      const message = error?.message || String(error);
      console.log(`[background-service] Sync failed: ${message}`);

      if (appStateRef.current === 'active') {
        setStatus('Transition Failed');
        Alert.alert(
          'Measurement Transition Error',
          `Could not switch measurement mode.\n\n${message}`,
        );
      } else {
        setStatus('Background Start Failed');
      }
    } finally {
      transitionInProgressRef.current = false;
      await refreshLogsAndStatus();
    }
  };

  syncAndroidMeasurementModeRef.current = syncAndroidMeasurementMode;

  const handleStart = async () => {
    const normalizedUrl = normalizeUrl(urlInput);
    activeTargetUrlRef.current = normalizedUrl;
    setUrlInput(normalizedUrl);
    setStatus('Starting');

    try {
      await ensureCsvExists();
    } catch (error) {
      const message = error?.message || String(error);
      Alert.alert('CSV Error', `Could not create the CSV file.\n\n${message}`);
      setStatus('CSV Error');
      return;
    }

    measurementEnabledRef.current = true;
    setIsRunning(true);

    if (Platform.OS === 'android') {
      await requestAndroidNotificationPermission();
      await syncAndroidMeasurementMode(appStateRef.current);
      return;
    }

    await startForegroundLoop(normalizedUrl);
  };

  const handleStop = async () => {
    measurementEnabledRef.current = false;

    if (Platform.OS === 'android') {
      stopForegroundLoop();

      if (isAndroidBackgroundMeasurementRunning()) {
        await stopAndroidBackgroundMeasurement();
        console.log('[background-service] Android background measurement stopped');
      }
      setIsRunning(false);
      setStatus('Stopped');
      await refreshLogsAndStatus();
      return;
    }

    stopForegroundLoop();
    setIsRunning(false);
    setStatus('Stopped');
    await refreshLogsAndStatus();
  };

  const handleShowCsvPath = () => {
    const csvPath = getCsvPath();
    Alert.alert('CSV Path', csvPath);
  };

  const latencyLabel =
    typeof lastLatency === 'number' ? `${lastLatency} ms` : 'No measurements yet';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.container}>
        <Text style={styles.title}>Lab Practice App</Text>
        <Text style={styles.subtitle}>Network measurements every 10 seconds</Text>
        {Platform.OS === 'android' ? (
          <Text style={styles.androidNote}>
            Android keeps measuring through a persistent notification when the app goes to the background.
          </Text>
        ) : null}

        <View style={styles.statusCard}>
          <Text style={styles.statusText}>Status: {status}</Text>
          <Text style={styles.statusText}>Request count: {requestCount}</Text>
          <Text style={styles.statusText}>Last latency: {latencyLabel}</Text>
          <Text style={styles.statusText}>App state: {appState}</Text>
          <Text style={styles.statusText}>
            Battery optimization: {batteryOptimizationDisabled ? 'Unrestricted' : 'Optimized'}
          </Text>
        </View>

        <ControlPanel
          isRunning={isRunning || status === 'Starting'}
          onChangeUrl={setUrlInput}
          onShowCsvPath={handleShowCsvPath}
          onStart={handleStart}
          onStop={handleStop}
          urlInput={urlInput}
        />

        <LogList logs={recentLogs} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  title: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: '#4b5563',
    fontSize: 13,
    marginTop: 4,
    marginBottom: 6,
  },
  androidNote: {
    color: '#92400e',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 10,
  },
  statusCard: {
    backgroundColor: '#f3f4f6',
    borderColor: '#d1d5db',
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
    marginBottom: 10,
  },
  statusText: {
    color: '#111827',
    fontSize: 14,
    marginBottom: 4,
  },
});

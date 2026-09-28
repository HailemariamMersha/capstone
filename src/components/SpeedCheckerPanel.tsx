import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Button,
  Linking,
  PermissionsAndroid,
  Switch,
  Text,
  View,
} from 'react-native';
import { measurementStore } from '../storage/database';
import {
  runSpeedChecker,
  speedCheckerAdapter,
} from '../reference/speedchecker';

export default function SpeedCheckerPanel({
  idle,
  onBusyChange,
  onSaved,
}: {
  idle: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        current.current?.abort();
      }
    });
    return () => {
      mounted.current = false;
      listener.remove();
      current.current?.abort();
    };
  }, []);
  async function start() {
    if (
      !idle ||
      !accepted ||
      current.current ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    const abort = new AbortController();
    current.current = abort;
    setBusy(true);
    onBusyChange(true);
    setAccepted(false);
    setMessage('Preparing SpeedChecker reference test…');
    try {
      const outcome = await runSpeedChecker(
        measurementStore,
        true,
        abort.signal,
        async () => {
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);
          return (
            results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
            PermissionsAndroid.RESULTS.GRANTED
          );
        },
      );
      if (mounted.current) {
        setMessage(outcome);
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      current.current = null;
      onBusyChange(false);
      if (mounted.current) {
        setBusy(false);
        onSaved();
      }
    }
  }
  return (
    <View>
      <Text>SpeedChecker reference test</Text>
      {!speedCheckerAdapter ? (
        <Text>SpeedChecker is unavailable in this build.</Text>
      ) : (
        <>
          <Text>
            Optional free SDK test. SpeedChecker collects location and
            device/network data and shares data with its clients. Precise
            location permission and system Location are required.
          </Text>
          <Button
            title="Read SpeedChecker privacy policy"
            onPress={() =>
              Linking.openURL(
                'https://www.speedchecker.com/privacy-policy.html',
              ).catch(error => setMessage(String(error)))
            }
          />
          <Text>
            Runs separately from collection and sync. Stops on leaving the app,
            after 90 seconds, or at a reported 100 MB combined transfer.
            Buffered traffic can exceed that threshold; it is not a hard data
            cap.
          </Text>
          <Text>
            I agree to SpeedChecker’s data sharing, location access, and test
            data usage.
          </Text>
          <Switch
            accessibilityLabel="Accept SpeedChecker reference test"
            value={accepted}
            disabled={busy}
            onValueChange={setAccepted}
          />
          <Button
            title="Start SpeedChecker reference test"
            disabled={!idle || busy || !accepted}
            onPress={start}
          />
          <Button
            title="Cancel SpeedChecker reference test"
            disabled={!busy}
            onPress={() => current.current?.abort()}
          />
          <Text accessibilityLiveRegion="polite">{message}</Text>
        </>
      )}
    </View>
  );
}

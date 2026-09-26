import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Button, Switch, Text, TextInput, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { createSyncClient } from '../sync/client';
import { measurementStore } from '../storage/database';

export default function SyncPanel({
  idle,
  onSynced,
  onBusyChange,
}: {
  idle: boolean;
  onSynced: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const client = useMemo(() => createSyncClient(measurementStore), []);
  const [url, setUrl] = useState('http://127.0.0.1:8000');
  const [token, setToken] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    'Sync sends saved data to the server you enter. Stop measurement before syncing.',
  );
  const mounted = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sync = useCallback(async () => {
    if (!idle || working.current) {
      return;
    }
    working.current = true;
    onBusyChange(true);
    setBusy(true);
    try {
      const count = await client.sync(url, token);
      if (mounted.current) {
        setMessage(
          `${count} records acknowledged. Only finished sessions are sent; retries may be waiting for backoff.`,
        );
        onSynced();
      }
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      working.current = false;
      onBusyChange(false);
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [client, idle, onSynced, onBusyChange, token, url]);
  useEffect(() => {
    if (!automatic || !idle) {
      return;
    }
    const run = () => {
      if (AppState.currentState === 'active') {
        sync();
      }
    };
    const timer = setInterval(run, 30000);
    const remove = NetInfo.addEventListener(state => {
      if (state.isConnected) {
        run();
      }
    });
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') {
        run();
      }
    });
    run();
    return () => {
      clearInterval(timer);
      remove();
      listener.remove();
    };
  }, [automatic, idle, sync]);
  return (
    <View>
      <Text>Synchronize saved sessions</Text>
      <TextInput
        accessibilityLabel="Sync server URL"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        editable={!busy}
      />
      <TextInput
        accessibilityLabel="Sync access token"
        placeholder="Access token (required for a remote server)"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        editable={!busy}
      />
      <Text>
        Retry automatically while this screen is open and measurement is stopped
      </Text>
      <Switch
        accessibilityLabel="Automatic sync"
        value={automatic}
        onValueChange={setAutomatic}
      />
      <Button
        title={busy ? 'Syncing…' : 'Sync now'}
        disabled={busy || !idle}
        onPress={sync}
      />
      <Text accessibilityLiveRegion="polite">{message}</Text>
    </View>
  );
}

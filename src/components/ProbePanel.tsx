import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DEFAULT_PROBE_CONFIG,
  MIB,
  prototypeId,
  validateProbeConfig,
} from '../measurements/config';
import { runSuite } from '../measurements/runSuite';
import type { Measurement } from '../measurements/types';

export default function ProbePanel() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_PROBE_CONFIG.serverUrl);
  const [timeout, setTimeoutValue] = useState(
    String(DEFAULT_PROBE_CONFIG.timeoutMs),
  );
  const [downloadBytes, setDownloadBytes] = useState(
    DEFAULT_PROBE_CONFIG.downloadBytes,
  );
  const [uploadBytes, setUploadBytes] = useState(
    DEFAULT_PROBE_CONFIG.uploadBytes,
  );
  const [rounds, setRounds] = useState('1');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Measurement[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        active.current?.abort();
      }
    });
    return () => {
      mounted.current = false;
      active.current?.abort();
      subscription.remove();
    };
  }, []);
  async function run() {
    if (active.current) {
      return;
    }
    setError(null);
    let config;
    const count = Number(rounds);
    try {
      config = validateProbeConfig({
        serverUrl,
        timeoutMs: Number(timeout),
        downloadBytes,
        uploadBytes,
      });
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new Error('Choose between 1 and 10 rounds.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const abort = new AbortController();
    active.current = abort;
    const id = prototypeId('prototype');
    setBatchId(id);
    setResults([]);
    setRunning(true);
    try {
      await runSuite(config, id, count, abort.signal, result => {
        if (mounted.current) {
          setResults(previous => [...previous, result].slice(-30));
        }
      });
      if (abort.signal.aborted && mounted.current) {
        setError(
          'Run cancelled. Completed and interrupted results remain below.',
        );
      }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      active.current = null;
      if (mounted.current) {
        setRunning(false);
      }
    }
  }
  const estimatedMiB = ((downloadBytes + uploadBytes) * Number(rounds)) / MIB;
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Measurement prototype</Text>
      <Text>
        Run RTT, download and upload in sequence. Keep this screen open;
        backgrounding cancels this prototype run.
      </Text>
      <Text>Probe server URL</Text>
      <TextInput
        accessibilityLabel="Probe server URL"
        value={serverUrl}
        onChangeText={setServerUrl}
        editable={!running}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />
      <Text>Timeout per probe (milliseconds)</Text>
      <TextInput
        accessibilityLabel="Probe timeout"
        value={timeout}
        onChangeText={setTimeoutValue}
        editable={!running}
        keyboardType="number-pad"
        style={styles.input}
      />
      <Text>Download payload</Text>
      <View style={styles.options}>
        {[1, 5, 10].map(size => (
          <Button
            key={size}
            title={`${size} MiB${downloadBytes === size * MIB ? ' ✓' : ''}`}
            disabled={running}
            onPress={() => setDownloadBytes(size * MIB)}
          />
        ))}
      </View>
      <Text>Upload payload</Text>
      <View style={styles.options}>
        {[256 * 1024, MIB].map(size => (
          <Button
            key={size}
            title={`${size === MIB ? '1 MiB' : '256 KiB'}${
              uploadBytes === size ? ' ✓' : ''
            }`}
            disabled={running}
            onPress={() => setUploadBytes(size)}
          />
        ))}
      </View>
      <Text>Rounds (1–10)</Text>
      <TextInput
        accessibilityLabel="Probe rounds"
        value={rounds}
        onChangeText={setRounds}
        editable={!running}
        keyboardType="number-pad"
        style={styles.input}
      />
      <Text>
        Planned payload:{' '}
        {Number.isFinite(estimatedMiB) && Number(rounds) >= 1
          ? estimatedMiB.toFixed(2)
          : '—'}{' '}
        MiB, plus request/response overhead.
      </Text>
      <Button
        title={running ? 'Probes running…' : 'Run probes'}
        disabled={running}
        onPress={run}
      />
      <Button
        title="Cancel probes"
        disabled={!running}
        onPress={() => active.current?.abort()}
      />
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Text>
        Temporary results only. A new run clears this list; app restart also
        loses it. SQLite history arrives in M4.
      </Text>
      {batchId && <Text selectable>Batch: {batchId}</Text>}
      {results.map(result => (
        <View key={result.id} style={styles.result}>
          <Text style={styles.resultTitle}>
            {result.type}:{' '}
            {result.success
              ? `${result.value?.toFixed(2)} ${result.unit}`
              : `failed (${result.errorType})`}
          </Text>
          <Text>{result.timestamp}</Text>
          <Text>
            Duration: {result.durationMs.toFixed(1)} ms · HTTP:{' '}
            {result.httpStatus ?? '—'}
          </Text>
          <Text>
            Payload bytes: {result.transferredBytes ?? 'unconfirmed'} · Region:{' '}
            {result.probeRegion ?? '—'}
          </Text>
          {result.errorMessage && (
            <Text style={styles.error}>{result.errorMessage}</Text>
          )}
          <Text selectable>{result.id}</Text>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '700', color: '#112d42' },
  input: {
    borderWidth: 1,
    borderColor: '#75899b',
    borderRadius: 6,
    padding: 10,
    color: '#112d42',
  },
  options: { flexDirection: 'row', justifyContent: 'space-between' },
  error: { color: '#a51f2b' },
  result: {
    borderTopWidth: 1,
    borderTopColor: '#d5dfe8',
    paddingTop: 12,
    gap: 5,
  },
  resultTitle: { fontWeight: '700', color: '#112d42' },
});

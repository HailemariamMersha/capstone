import React, { useState } from 'react';
import { Button, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  DEFAULT_SESSION_CONFIG,
  validateSessionConfig,
} from '../sessions/config';
import { MIB } from '../measurements/config';
import type { MeasurementConfig } from '../sessions/types';

export default function SessionSettings({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: (config: MeasurementConfig) => Promise<void>;
}) {
  const [url, setUrl] = useState(DEFAULT_SESSION_CONFIG.serverUrl);
  const [timeout, setTimeoutValue] = useState('30');
  const [rtt, setRtt] = useState('60');
  const [download, setDownload] = useState('300');
  const [upload, setUpload] = useState('300');
  const [downloadBytes, setDownloadBytes] = useState(MIB);
  const [uploadBytes, setUploadBytes] = useState(MIB / 4);
  const [error, setError] = useState<string | null>(null);
  const fields = [
    { label: 'Probe server URL', value: url, change: setUrl },
    {
      label: 'Probe timeout (seconds)',
      value: timeout,
      change: setTimeoutValue,
    },
    { label: 'RTT interval (seconds)', value: rtt, change: setRtt },
    {
      label: 'Download interval (seconds)',
      value: download,
      change: setDownload,
    },
    { label: 'Upload interval (seconds)', value: upload, change: setUpload },
  ];
  const estimate =
    ((downloadBytes * 3600) / Number(download) +
      (uploadBytes * 3600) / Number(upload)) /
    MIB;
  async function start() {
    setError(null);
    try {
      const config = validateSessionConfig({
        serverUrl: url,
        timeoutMs: Number(timeout) * 1000,
        rttIntervalMs: Number(rtt) * 1000,
        downloadIntervalMs: Number(download) * 1000,
        uploadIntervalMs: Number(upload) * 1000,
        downloadBytes,
        uploadBytes,
      });
      await onStart(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Session settings</Text>
      {fields.map((field, index) => (
        <View key={field.label}>
          <Text>{field.label}</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel={field.label}
            value={field.value}
            onChangeText={field.change}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={index === 0 ? 'url' : 'number-pad'}
          />
        </View>
      ))}
      <Text>Download payload</Text>
      {[1, 5, 10].map(size => (
        <Button
          key={size}
          title={`${size} MiB${downloadBytes === size * MIB ? ' ✓' : ''}`}
          disabled={disabled}
          onPress={() => setDownloadBytes(size * MIB)}
        />
      ))}
      <Text>Upload payload</Text>
      {[MIB / 4, MIB].map(size => (
        <Button
          key={size}
          title={`${size === MIB ? '1 MiB' : '256 KiB'}${
            uploadBytes === size ? ' ✓' : ''
          }`}
          disabled={disabled}
          onPress={() => setUploadBytes(size)}
        />
      ))}
      <Text>
        Approximate payload:{' '}
        {Number.isFinite(estimate) && estimate > 0 ? estimate.toFixed(2) : '—'}{' '}
        MiB/hour, plus an initial batch and protocol overhead. Runs until
        stopped. Intervals: 10–3600 seconds.
      </Text>
      <Button title="Start session" disabled={disabled} onPress={start} />
      {error && <Text accessibilityRole="alert">{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 16, backgroundColor: '#fff', borderRadius: 12, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: '#112d42' },
  input: {
    borderWidth: 1,
    borderColor: '#75899b',
    borderRadius: 6,
    padding: 10,
    color: '#112d42',
  },
});

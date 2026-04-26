import React from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

function ActionButton({backgroundColor, disabled, onPress, title}) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        {backgroundColor},
        disabled ? styles.buttonDisabled : null,
      ]}>
      <Text style={styles.buttonText}>{title}</Text>
    </TouchableOpacity>
  );
}

export default function ControlPanel({
  isRunning,
  onChangeUrl,
  onShowCsvPath,
  onStart,
  onStop,
  urlInput,
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Target URL</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={onChangeUrl}
        placeholder="https://example.com"
        placeholderTextColor="#9ca3af"
        style={styles.input}
        value={urlInput}
      />

      <View style={styles.buttonRow}>
        <ActionButton
          backgroundColor="#16a34a"
          disabled={isRunning}
          onPress={onStart}
          title="Start"
        />
        <ActionButton
          backgroundColor="#dc2626"
          disabled={!isRunning}
          onPress={onStop}
          title="Stop"
        />
      </View>

      <ActionButton
        backgroundColor="#2563eb"
        disabled={false}
        onPress={onShowCsvPath}
        title="Show CSV Path"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 10,
  },
  label: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    borderColor: '#cbd5e1',
    borderRadius: 10,
    borderWidth: 1,
    color: '#111827',
    fontSize: 15,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    paddingVertical: 9,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});

import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_PAYLOAD_BYTES, payloadBytesFromMiB } from '../measurements/config';

export default function PayloadSizeFields({
  downloadMiB,
  uploadMiB,
  onDownloadChange,
  onUploadChange,
  disabled,
}: {
  downloadMiB: string;
  uploadMiB: string;
  onDownloadChange: (value: string) => void;
  onUploadChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.fields}>
      {[
        {
          label: 'Download size (MiB)',
          value: downloadMiB,
          change: onDownloadChange,
        },
        {
          label: 'Upload size (MiB)',
          value: uploadMiB,
          change: onUploadChange,
        },
      ].map(field => {
        const bytes = payloadBytesFromMiB(field.value);
        return (
          <View key={field.label}>
            <Text>{field.label}</Text>
            <TextInput
              accessibilityLabel={field.label}
              style={styles.input}
              value={field.value}
              onChangeText={field.change}
              editable={!disabled}
              keyboardType="decimal-pad"
              autoCorrect={false}
            />
            <Text>
              {bytes >= 1 && bytes <= MAX_PAYLOAD_BYTES
                ? `${bytes.toLocaleString()} bytes per probe`
                : 'Enter a size between 1 byte and 100 MiB.'}
            </Text>
          </View>
        );
      })}
      <Text>
        Choose each size before starting. Decimal MiB values are rounded to the
        nearest byte; 1 MiB = 1,048,576 bytes. Maximum 100 MiB per probe,
        subject to the session payload budget. Larger transfers may need a
        longer timeout. These sizes also apply to loaded-latency tests.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  fields: { gap: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#75899b',
    borderRadius: 6,
    padding: 10,
    color: '#112d42',
  },
});

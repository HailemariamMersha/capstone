import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';

function LogField({label, value}) {
  return (
    <Text style={styles.logField}>
      <Text style={styles.logFieldLabel}>{label}: </Text>
      {value}
    </Text>
  );
}

export default function LogList({logs}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Recent Logs</Text>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled={true}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={true}
        style={styles.scrollView}>
        {logs.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No logs yet. Start the measurement loop to see results.</Text>
          </View>
        ) : (
          logs.map((logItem, index) => (
            <View key={`${logItem.timestamp}-${index}`} style={styles.logCard}>
              <LogField label="Timestamp" value={logItem.timestamp} />
              <LogField label="Target URL" value={logItem.targetUrl} />
              <LogField label="Success" value={String(logItem.success)} />
              <LogField label="Latency" value={`${logItem.latencyMs} ms`} />
              <LogField
                label="HTTP status"
                value={logItem.httpStatus === '' ? 'N/A' : String(logItem.httpStatus)}
              />
              <LogField label="App state" value={logItem.appState} />
              <LogField label="Error" value={logItem.error || 'None'} />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  title: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  scrollView: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  emptyCard: {
    backgroundColor: '#f9fafb',
    borderColor: '#e5e7eb',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  emptyText: {
    color: '#4b5563',
    fontSize: 15,
    lineHeight: 22,
  },
  logCard: {
    backgroundColor: '#f8fafc',
    borderColor: '#dbe2ea',
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    padding: 14,
  },
  logField: {
    color: '#111827',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 4,
  },
  logFieldLabel: {
    fontWeight: '700',
  },
});

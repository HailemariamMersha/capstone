import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { measurementStore } from '../storage/database';
import { shareSession } from '../export/shareSession';
import type { SessionRecord } from '../sessions/types';
import type { SessionEvent, StoredMeasurement } from '../storage/types';

export default function SessionHistory({
  revision,
  canResume,
  onResume,
}: {
  revision: number;
  canResume: boolean;
  onResume: (session: SessionRecord) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [limit, setLimit] = useState(20);
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<StoredMeasurement[]>([]);
  const [resultLimit, setResultLimit] = useState(50);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const request = useRef(0);
  async function exportData(id: string, format: 'csv' | 'json') {
    setExporting(true);
    try {
      await shareSession(id, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const [nextSessions, count, measurements, nextEvents] = await Promise.all(
        [
          measurementStore.listSessions(limit),
          measurementStore.pendingCount(),
          selected
            ? measurementStore.listMeasurements(selected, resultLimit)
            : Promise.resolve([]),
          selected
            ? measurementStore.listEvents(selected)
            : Promise.resolve([]),
        ],
      );
      if (current !== request.current) {
        return;
      }
      setSessions(nextSessions);
      setPending(count);
      setResults(measurements);
      setEvents(nextEvents);
      setError(null);
    } catch (err) {
      if (current === request.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [limit, selected, resultLimit]);
  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh, revision]);
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Saved sessions</Text>
      <Text>{pending} records awaiting server acknowledgement.</Text>
      <Button title="Refresh history" onPress={refresh} />
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {sessions.length === 0 && <Text>No saved sessions yet.</Text>}
      {sessions.map(session => (
        <View key={session.id} style={styles.record}>
          <Text selectable>{session.id}</Text>
          {session.config.mode === 'ndt7_reference' && (
            <Text>M-Lab NDT7 reference test</Text>
          )}
          {session.config.mode === 'speedchecker_reference' && (
            <Text>SpeedChecker reference test</Text>
          )}
          <Text>
            {session.state} · {session.measurementCount} results ·{' '}
            {new Date(session.startedAt).toLocaleString()}
          </Text>
          {session.resumedFromId && (
            <Text>Continues session {session.resumedFromId}</Text>
          )}
          <Button
            title={`View ${session.id.slice(0, 8)}`}
            onPress={() => {
              setSelected(session.id);
              setResultLimit(50);
            }}
          />
          <Button
            title={`Export CSV ${session.id.slice(0, 8)}`}
            disabled={exporting}
            onPress={() => exportData(session.id, 'csv')}
          />
          <Button
            title={`Export JSON ${session.id.slice(0, 8)}`}
            disabled={exporting}
            onPress={() => exportData(session.id, 'json')}
          />
          {session.state !== 'active' && !session.config.mode && (
            <Button
              title={`Resume ${session.id.slice(0, 8)}`}
              disabled={!canResume}
              onPress={() => onResume(session)}
            />
          )}
        </View>
      ))}
      {sessions.length === limit && (
        <Button title="Older sessions" onPress={() => setLimit(limit + 20)} />
      )}
      {selected && (
        <View>
          <Text selectable>Results for {selected}</Text>
          {results.map(({ measurement: m, state, scheduledAt }) => (
            <View key={m.id} style={styles.record}>
              <Text>
                {m.type}:{' '}
                {state === 'pending'
                  ? 'in progress'
                  : m.success
                  ? `${m.value?.toFixed(2)} ${m.unit}`
                  : `failed (${m.errorType})`}
              </Text>
              <Text>Scheduled: {scheduledAt}</Text>
              <Text>
                Started: {m.timestamp} · {m.durationMs.toFixed(1)} ms
                {m.httpStatus != null ? ` · HTTP ${m.httpStatus}` : ''}
              </Text>
              <Text>
                Payload: {m.transferredBytes ?? 'unconfirmed'} bytes · Region:{' '}
                {m.probeRegion ?? '—'}
              </Text>
              {m.targetHost && (
                <Text>
                  Target: {m.targetHost} · TTL {m.ttl ?? '—'}
                </Text>
              )}
              {m.packet?.tcpInfoAfter && (
                <Text>
                  TCP kernel RTT: {m.packet.tcpInfoAfter.tcpi_rtt ?? '—'} μs ·
                  Retransmissions:{' '}
                  {m.packet.tcpInfoAfter.tcpi_total_retrans ?? '—'}
                </Text>
              )}
              {m.details && (
                <View>
                  <Text>
                    Replies: {m.details.summary.replies} · Median:{' '}
                    {m.details.summary.medianMs?.toFixed(2) ?? '—'} ms · p95:{' '}
                    {m.details.summary.p95Ms?.toFixed(2) ?? '—'} ms
                  </Text>
                  <Text>
                    Successive RTT difference:{' '}
                    {m.details.summary.successiveDifferenceMs?.toFixed(2) ??
                      '—'}{' '}
                    ms
                  </Text>
                  {m.details.nonResponsePercent != null && (
                    <Text>
                      ICMP non-response:{' '}
                      {m.details.nonResponsePercent.toFixed(1)}%
                    </Text>
                  )}
                  {m.details.lossPercent != null && (
                    <Text>
                      UDP round-trip loss: {m.details.lossPercent.toFixed(1)}%
                    </Text>
                  )}
                  {m.details.samples
                    .filter(sample => sample.packet)
                    .map(sample => (
                      <Text key={sample.sequence}>
                        Probe {sample.sequence}: {sample.packet!.outcome}
                        {sample.packet!.response?.icmpType != null
                          ? ` · ICMP ${sample.packet!.response!.icmpType}/${
                              sample.packet!.response!.icmpCode
                            }`
                          : ''}
                        {sample.packet!.response?.icmpSequence != null
                          ? ` · sequence ${
                              sample.packet!.response!.icmpSequence
                            }`
                          : ''}
                        {sample.packet!.response?.responderAddress
                          ? ` · ${sample.packet!.response!.responderAddress}`
                          : ''}
                      </Text>
                    ))}
                  <Text>
                    Full socket results and payload bytes are included in the
                    export bundle.
                  </Text>
                  {m.details.baselineSummary && (
                    <Text>
                      Before load:{' '}
                      {m.details.baselineSummary.medianMs?.toFixed(2) ?? '—'} ms
                      · Fully overlapping replies:{' '}
                      {m.details.loadedOverlapCount ?? 0}
                    </Text>
                  )}
                  {m.details.load && (
                    <Text>
                      Load transfer:{' '}
                      {m.details.load.success
                        ? `${m.details.load.value?.toFixed(2)} Mbps`
                        : `failed (${m.details.load.errorType})`}
                    </Text>
                  )}
                </View>
              )}
              {m.reference && (
                <Text>
                  NDT7 {m.reference.version} ·{' '}
                  {m.reference.source ?? 'no sample'} speed source ·{' '}
                  {m.reference.stopReason}. Reported client bytes:{' '}
                  {m.reference.clientBytes ?? 'unknown'}; server bytes:{' '}
                  {m.reference.serverBytes ?? 'unknown'}. Byte counts are last
                  reported samples, not total carrier usage.
                </Text>
              )}
              {m.route && (
                <View>
                  <Text>
                    UDP route:{' '}
                    {m.route.reached
                      ? `destination at hop ${m.route.reachedHop}`
                      : 'destination not confirmed'}{' '}
                    · {m.route.stopReason}
                  </Text>
                  {m.route.samples.map(sample => (
                    <Text key={`${sample.hop}-${sample.sequence}`}>
                      Hop {sample.hop}: {sample.address ?? '*'} ·{' '}
                      {sample.rttMs == null
                        ? 'RTT unavailable'
                        : `${sample.rttMs.toFixed(2)} ms`}{' '}
                      · {sample.kind}
                      {sample.icmpType != null
                        ? ` · ICMP ${sample.icmpType}/${sample.icmpCode}`
                        : ''}
                    </Text>
                  ))}
                </View>
              )}
              {m.speedchecker && (
                <Text>
                  SpeedChecker {m.speedchecker.sdkVersion} ·{' '}
                  {m.speedchecker.stopReason}. SDK reported download:{' '}
                  {m.speedchecker.downloadMb ?? 'unknown'} MB; upload:{' '}
                  {m.speedchecker.uploadMb ?? 'unknown'} MB. SDK jitter:{' '}
                  {m.speedchecker.jitterMs ?? 'unavailable'} ms.
                </Text>
              )}
              {m.networkSnapshot && (
                <Text>
                  Network: {m.networkSnapshot.type} · Battery:{' '}
                  {m.networkSnapshot.batteryPercent ?? 'unknown'}% · Charging:{' '}
                  {String(m.networkSnapshot.isCharging ?? 'unknown')} · Public
                  IP: {m.networkSnapshot.publicIp ?? 'unavailable'} · ASN:{' '}
                  {m.networkSnapshot.asn ?? 'unavailable'}
                </Text>
              )}
              {state === 'complete' && m.errorMessage && (
                <Text>{m.errorMessage}</Text>
              )}
            </View>
          ))}
          {results.length === resultLimit && (
            <Button
              title="Older measurements"
              onPress={() => setResultLimit(resultLimit + 50)}
            />
          )}
          <Text>Latest session events</Text>
          {events.map(event => (
            <Text key={event.id}>
              {event.timestamp} · {event.kind} · {JSON.stringify(event.details)}
            </Text>
          ))}
        </View>
      )}
      <Text>
        Resume starts a new session with the saved settings and a link to the
        previous session. Missed probes are not replayed.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 16, backgroundColor: '#fff', borderRadius: 12, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: '#112d42' },
  record: {
    borderTopWidth: 1,
    borderTopColor: '#d5dfe8',
    paddingTop: 12,
    gap: 6,
  },
});

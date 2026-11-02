import React, { useEffect, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  ScrollView,
  View,
  StyleSheet,
} from 'react-native';
import {
  Button,
  Card,
  Chip,
  HelperText,
  Text,
  TextInput,
} from 'react-native-paper';
import {
  currentTrip,
  startTrip,
  stopTrip,
  subscribeTrip,
  tripRunning,
  tripProgress,
} from '../trips/runtime';
import { measurementStore } from '../storage/database';
import type { FlightDetails, Trip } from '../trips/model';
import { syncAccount } from '../sync/background';
export default function FlightHome({
  owner,
  researcher,
  manual,
}: {
  owner: string;
  researcher: boolean;
  manual(): void;
}) {
  const [trip, setTrip] = useState(currentTrip());
  const [flight, setFlight] = useState<FlightDetails>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shadow, setShadow] = useState(false);
  useEffect(() => subscribeTrip(() => setTrip(currentTrip())), []);
  const active = tripRunning();
  const progress = tripProgress();
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const update = () =>
      measurementStore
        .accountSessions(owner)
        .then(rows => {
          if (alive)
            setPending(
              rows.filter(
                s =>
                  s.config.tripId === trip?.id &&
                  s.state !== 'active' &&
                  s.uploadStatus !== 'Uploaded',
              ).length,
            );
        })
        .catch(() => {});
    update();
    const timer = setInterval(update, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [owner, trip?.id]);
  async function act() {
    setBusy(true);
    setError(null);
    try {
      if (active) {
        await stopTrip();
        await syncAccount();
      } else {
        if (Platform.OS !== 'android')
          throw new Error(
            'Automatic flight collection is currently available on Android.',
          );
        const permissions = [
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ];
        if (Platform.Version >= 33)
          permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        const granted = await PermissionsAndroid.requestMultiple(permissions);
        if (
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] !==
            'granted' ||
          (Platform.Version >= 33 &&
            granted[PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] !==
              'granted')
        )
          throw new Error(
            'Allow precise location and notifications to monitor this trip in the background.',
          );
        await startTrip(owner, flight, shadow);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update trip.');
    } finally {
      setBusy(false);
      setTrip(currentTrip());
    }
  }
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Text variant="headlineLarge">Your journey, understood.</Text>
      <Text>
        Add flight details if you know them. Start once; SkyMeasure watches for
        suitable in-flight Wi-Fi.
      </Text>
      {!active && (
        <>
          {(['flightNumber', 'departure', 'arrival'] as const).map((key, i) => (
            <TextInput
              key={key}
              mode="outlined"
              maxLength={120}
              label={
                [
                  'Flight number (optional)',
                  'Departure airport or city (optional)',
                  'Arrival airport or city (optional)',
                ][i]
              }
              value={flight[key] ?? ''}
              onChangeText={value => setFlight(f => ({ ...f, [key]: value }))}
            />
          ))}
          <TextInput
            mode="outlined"
            label="Expected flight length in minutes (optional)"
            keyboardType="numeric"
            value={
              flight.expectedMinutes == null
                ? ''
                : String(flight.expectedMinutes)
            }
            onChangeText={value =>
              setFlight(f => ({
                ...f,
                expectedMinutes: value.trim() ? Number(value) : undefined,
              }))
            }
          />
          <Text>
            This estimate spreads speed samples across the journey. It does not
            set a stop time.
          </Text>
          <Button onPress={() => setFlight({})}>Skip flight details</Button>
        </>
      )}
      <Card>
        <Card.Content>
          <Text variant="titleLarge">
            {active
              ? trip?.phase === 'watching'
                ? 'Watching for flight Wi-Fi'
                : trip?.phase === 'paused'
                ? 'Waiting for flight Wi-Fi'
                : 'Collecting observations'
              : 'Ready when you are'}
          </Text>
          <Text>
            {active && trip
              ? `${Math.floor(
                  (Date.now() - trip.startedAt) / 60000,
                )} minutes since Start`
              : '300 MiB per trip · battery safeguard'}
          </Text>
          <Text>{trip?.evidence?.provider ?? 'Provider unavailable'}</Text>
          <Text>
            {trip?.evidence?.confidence?.replaceAll('_', ' ') ?? 'Unconfirmed'}{' '}
            · an inference, not a verified flight
          </Text>
          {trip && (
            <Text>
              {(
                (trip.policy.transferBytes +
                  trip.policy.diagnosticBytes +
                  trip.policy.liveUploadBytes) /
                  1048576 -
                (trip.used.transfers +
                  trip.used.diagnostics +
                  trip.used.uploads) /
                  1048576
              ).toFixed(1)}{' '}
              MiB application allowance remaining
            </Text>
          )}
          {trip && (
            <>
              <Text>{progress.count} saved measurements in this trip</Text>
              {progress.latest && (
                <Text>
                  Latest {progress.latest.type.replaceAll('_', ' ')}:{' '}
                  {progress.latest.success && progress.latest.value != null
                    ? `${progress.latest.value.toFixed(2)} ${
                        progress.latest.unit
                      }`
                    : 'unavailable (attempt saved)'}
                </Text>
              )}
              <Text>
                {progress.uploading
                  ? 'Pausing probes for an upload attempt'
                  : pending == null
                  ? 'Checking upload status'
                  : pending > 0
                  ? `${pending} closed segments waiting to upload`
                  : 'No closed segments waiting to upload'}
              </Text>
            </>
          )}
          <Button mode="contained" loading={busy} disabled={busy} onPress={act}>
            {active ? 'Stop trip' : 'Start trip'}
          </Button>
        </Card.Content>
      </Card>
      <Text>
        Records save on this phone. Every 15 minutes, probes briefly pause for
        an upload attempt. Unsent records stay queued. Post-trip uploads and
        network overhead use additional data.
      </Text>
      <HelperText type="error" visible={!!(error || progress.error)}>
        {error || progress.error}
      </HelperText>
      {researcher && !active && (
        <>
          <Button onPress={() => setShadow(v => !v)}>
            Detector shadow mode: {shadow ? 'on' : 'off'}
          </Button>
          <Button onPress={manual}>Researcher manual collection</Button>
        </>
      )}
      <Text>
        Start trip also schedules one M-Lab speed test after suitable Wi-Fi is
        detected. M-Lab publishes results and your public IP. Up to 200 MiB is
        reserved for that test; a capped test is marked incomplete. No second
        Start is needed.
      </Text>
      {trip?.mlab && (
        <Text>M-Lab: {trip.mlab.status.replaceAll('_', ' ')}</Text>
      )}
    </ScrollView>
  );
}
export function TripHistory({ owner }: { owner: string }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  useEffect(() => {
    let alive = true;
    const update = () =>
      measurementStore
        .accountTrips(owner)
        .then(rows => {
          if (alive) setTrips(rows.sort((a, b) => b.startedAt - a.startedAt));
        })
        .catch(() => {});
    update();
    const timer = setInterval(update, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [owner]);
  return (
    <View style={styles.history}>
      {trips.map(t => (
        <Card key={t.id}>
          <Card.Content>
            <Text variant="titleLarge">
              {t.flight.flightNumber || 'Your trip'}
            </Text>
            <Text>
              {t.flight.departure || 'Departure not entered'} →{' '}
              {t.flight.arrival || 'Arrival not entered'}
            </Text>
            <Text>
              {new Date(t.startedAt).toLocaleString()} · {t.segmentCount} saved
              segments
            </Text>
            <Chip>{t.state === 'active' ? t.phase : t.state}</Chip>
            <Text>
              {t.evidence?.confidence.replaceAll('_', ' ') ?? 'Unconfirmed'} ·
              upload status is shown on each segment below.
            </Text>
          </Card.Content>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, gap: 18 },
  history: { gap: 12 },
});

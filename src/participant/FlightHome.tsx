import React, { useEffect, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  NativeModules,
  AppState,
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
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
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
import { theme } from './theme';

function routeLabel(flight: FlightDetails) {
  if (flight.departure && flight.arrival)
    return `${flight.departure} → ${flight.arrival}`;
  return flight.departure || flight.arrival || 'Your journey';
}
export default function FlightHome({
  owner,
  researcher,
  manual,
}: {
  owner: string;
  researcher: boolean;
  manual(): void;
}) {
  const ownedTrip = () => {
    const saved = currentTrip();
    return saved?.ownerId === owner ? saved : null;
  };
  const [trip, setTrip] = useState(ownedTrip);
  const [flight, setFlight] = useState<FlightDetails>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shadow, setShadow] = useState(false);
  const [includeMlab, setIncludeMlab] = useState(true);
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () =>
      NativeModules.FlightNetwork?.runtimeState?.()
        .then((state: { batteryExempt: boolean }) =>
          setBatteryExempt(state.batteryExempt),
        )
        .catch(() => {});
    refresh();
    const listener = AppState.addEventListener('change', refresh);
    return () => listener.remove();
  }, []);
  useEffect(() => {
    const update = () => {
      const saved = currentTrip();
      setTrip(saved?.ownerId === owner ? saved : null);
    };
    update();
    return subscribeTrip(update);
  }, [owner]);
  const active = tripRunning() && trip?.ownerId === owner;
  const progress = tripProgress();
  async function act(details: FlightDetails = flight) {
    setBusy(true);
    setError(null);
    try {
      if (active) {
        await stopTrip();
        await syncAccount();
      } else {
        if (Platform.OS !== 'android')
          throw new Error('Trip collection is currently available on Android.');
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
        ) {
          throw new Error(
            'Allow precise location and notifications to start your trip.',
          );
        }
        if (shadow) await startTrip(owner, details, true, { includeMlab });
        else await startTrip(owner, details, false);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not update your trip. Please try again.',
      );
    } finally {
      setBusy(false);
      setTrip(ownedTrip());
    }
  }
  const title = active
    ? trip.phase === 'watching'
      ? 'You’re all set.'
      : trip.phase === 'paused'
      ? 'Waiting for Wi-Fi'
      : 'Your trip is underway.'
    : 'Where are you flying?';
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={styles.intro}>
        {active && (
          <View style={styles.symbol} accessible={false}>
            <MaterialDesignIcons
              name="wifi"
              size={32}
              color={theme.colors.primary}
            />
          </View>
        )}
        <Text
          variant="headlineLarge"
          style={styles.title}
          accessibilityRole="header"
        >
          {title}
        </Text>
        <Text variant="bodyLarge" style={styles.subtitle}>
          {active
            ? trip.phase === 'watching'
              ? 'Connect to your flight’s Wi-Fi. We’ll take it from there.'
              : trip.phase === 'paused'
              ? 'Your trip will continue when your flight’s Wi-Fi returns.'
              : 'SkyMeasure is taking care of the rest.'
            : 'Add your flight, or skip straight to your trip.'}
        </Text>
      </View>
      {active ? (
        <Card style={styles.card} mode="contained">
          <Card.Content style={styles.form}>
            <Text variant="titleLarge" style={styles.flightTitle}>
              {trip.flight.flightNumber || 'Your flight'}
            </Text>
            {(trip.flight.departure || trip.flight.arrival) && (
              <Text variant="bodyLarge">{routeLabel(trip.flight)}</Text>
            )}
            <Chip style={styles.badge} accessibilityLiveRegion="polite">
              {progress.uploading
                ? 'Saving your progress'
                : trip.phase === 'watching'
                ? 'Waiting for flight Wi-Fi'
                : trip.phase === 'paused'
                ? 'Paused'
                : 'Trip in progress'}
            </Chip>
            <Text style={styles.subtitle}>
              {Math.max(0, Math.floor((Date.now() - trip.startedAt) / 60000))}{' '}
              min since you started
            </Text>
          </Card.Content>
        </Card>
      ) : (
        <Card style={styles.card} mode="contained">
          <Card.Content style={styles.form}>
            <View style={styles.formHeading}>
              <Text variant="titleMedium" style={styles.flightTitle}>
                Flight details
              </Text>
              <Text variant="bodySmall" style={styles.subtitle}>
                Optional
              </Text>
            </View>
            <TextInput
              mode="outlined"
              label="Flight number"
              placeholder="e.g. QR123"
              maxLength={120}
              autoCapitalize="characters"
              autoCorrect={false}
              value={flight.flightNumber ?? ''}
              onChangeText={value =>
                setFlight(f => ({ ...f, flightNumber: value }))
              }
              style={styles.input}
            />
            <TextInput
              mode="outlined"
              label="From"
              placeholder="Departure airport or city"
              maxLength={120}
              autoCapitalize="words"
              value={flight.departure ?? ''}
              onChangeText={value =>
                setFlight(f => ({ ...f, departure: value }))
              }
              style={styles.input}
            />
            <TextInput
              mode="outlined"
              label="To"
              placeholder="Arrival airport or city"
              maxLength={120}
              autoCapitalize="words"
              value={flight.arrival ?? ''}
              onChangeText={value => setFlight(f => ({ ...f, arrival: value }))}
              style={styles.input}
            />
          </Card.Content>
        </Card>
      )}
      <View style={styles.actions}>
        <Button
          mode={active ? 'outlined' : 'contained'}
          loading={busy}
          disabled={busy}
          contentStyle={styles.buttonContent}
          style={styles.button}
          labelStyle={styles.buttonLabel}
          onPress={() => act()}
        >
          {active ? 'Stop trip' : 'Start trip'}
        </Button>
        {!active && (
          <Button
            disabled={busy}
            contentStyle={styles.secondaryButton}
            onPress={() => act({})}
          >
            Skip and start
          </Button>
        )}
      </View>
      {(error || (active && progress.error)) && (
        <HelperText type="error" accessibilityLiveRegion="polite">
          {error || progress.error}
        </HelperText>
      )}
      {researcher && !active && (
        <View style={styles.researchTools}>
          <Button onPress={() => setShadow(v => !v)}>
            Detector shadow mode: {shadow ? 'on' : 'off'}
          </Button>
          <Button onPress={manual}>Researcher manual collection</Button>
          {shadow && (
            <Button onPress={() => setIncludeMlab(value => !value)}>
              Include M-Lab in shadow test: {includeMlab ? 'on' : 'off'}
            </Button>
          )}
          <Text variant="bodySmall">
            Background battery access:{' '}
            {batteryExempt == null
              ? 'unavailable'
              : batteryExempt
              ? 'unrestricted'
              : 'optimized'}
            . For the locked-phone test, allow unrestricted battery use for
            SkyMeasure.
          </Text>
          <Button
            onPress={() =>
              NativeModules.FlightNetwork?.openBatterySettings?.().catch(() =>
                setError(
                  'Open Android Settings → Battery to adjust background access.',
                ),
              )
            }
          >
            Background battery settings
          </Button>
        </View>
      )}
    </ScrollView>
  );
}
export function TripHistory({ owner }: { owner: string }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  useEffect(() => {
    let alive = true;
    setTrips([]);
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
        <Card key={t.id} style={styles.card} mode="contained">
          <Card.Content style={styles.historyContent}>
            <Text variant="titleLarge" style={styles.flightTitle}>
              {t.flight.flightNumber || 'Your trip'}
            </Text>
            {(t.flight.departure || t.flight.arrival) && (
              <Text>{routeLabel(t.flight)}</Text>
            )}
            <Text style={styles.subtitle}>
              {new Date(t.startedAt).toLocaleString()}
            </Text>
            <Chip style={styles.badge}>
              {t.state === 'active'
                ? 'In progress'
                : t.state === 'interrupted'
                ? 'Progress saved'
                : 'Finished'}
            </Chip>
          </Card.Content>
        </Card>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  page: {
    padding: 24,
    paddingTop: 20,
    paddingBottom: 36,
    gap: 24,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    flexGrow: 1,
  },
  intro: { gap: 12, paddingVertical: 8 },
  symbol: {
    backgroundColor: '#D9F2EE',
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  title: { fontWeight: '700', letterSpacing: -0.8 },
  subtitle: { color: theme.colors.onSurfaceVariant, lineHeight: 24 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 24 },
  form: { gap: 16, paddingVertical: 24, paddingHorizontal: 20 },
  formHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  flightTitle: { fontWeight: '600' },
  input: { backgroundColor: '#FFFFFF' },
  badge: { alignSelf: 'flex-start', backgroundColor: '#EAF5F2' },
  actions: { gap: 4 },
  button: { borderRadius: 18 },
  buttonContent: { minHeight: 58 },
  buttonLabel: { fontSize: 17, fontWeight: '600' },
  secondaryButton: { minHeight: 48 },
  researchTools: { marginTop: 12 },
  history: { gap: 12 },
  historyContent: { gap: 8, padding: 20 },
});

jest.mock('@react-native-community/geolocation', () => ({
  setRNConfiguration: jest.fn(),
  watchPosition: jest.fn(),
  clearWatch: jest.fn(),
}));
import { derivedFix } from '../src/trips/location';
test('location mapping strips coordinates and extras; missing native flags stay unavailable', () => {
  const raw = {
    coords: { latitude: 25, longitude: 55, altitude: 0, speed: 0, accuracy: 0 },
    extras: { secret: 'must not survive' },
    fixAgeMs: 0,
    mocked: false,
  };
  expect(derivedFix(raw, 1)).toMatchObject({
    altitudeM: null,
    speedMps: null,
    horizontalAccuracyM: null,
  });
  const result = derivedFix(
    {
      ...raw,
      coords: {
        ...raw.coords,
        hasAltitude: true,
        hasSpeed: true,
        hasAccuracy: true,
      },
    },
    1,
  );
  expect(result).toMatchObject({
    altitudeM: 0,
    speedMps: 0,
    horizontalAccuracyM: 0,
  });
  for (const forbidden of ['latitude', 'longitude', 'extras', 'secret'])
    expect(JSON.stringify(result)).not.toContain(forbidden);
});

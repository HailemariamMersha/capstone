jest.mock('../src/trips/runtime', () => ({
  currentTrip: () => null,
  tripRunning: () => false,
  tripProgress: () => ({
    count: 0,
    uploading: false,
    latest: null,
    error: null,
  }),
  subscribeTrip: () => () => {},
  startTrip: jest.fn(),
  stopTrip: jest.fn(),
}));
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import {
  Button,
  Text,
  TextInput,
  PermissionsAndroid,
  Platform,
} from 'react-native';
const mockSession = {
  user: { id: 'account-a', email: 'a@example.invalid', user_metadata: {} },
};
const mockProfile = {
  participantId: 'p',
  role: 'participant',
  consentVersion: 'skymeasure-flight-pilot-2026-11-14',
  requiredConsentVersion: 'skymeasure-flight-pilot-2026-11-14',
  mobileUploads: false,
};
jest.mock('../src/auth/client', () => ({
  configured: true,
  ResearchAccessError: class extends Error {
    reason: string;
    constructor(_status: number, reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
  auth: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(),
    },
  },
  api: jest.fn().mockResolvedValue({ items: [] }),
  loadProfile: jest.fn(),
  signIn: jest.fn(),
  enrollParticipant: jest.fn(),
  handleAuthCallback: jest.fn(),
  localSession: jest.fn(),
  subscribeParticipant: jest.fn(() => () => {}),
  rememberParticipant: jest.fn(),
  signOutParticipant: jest.fn(),
  secureStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('../src/sync/background', () => ({
  syncAccount: jest.fn().mockResolvedValue(undefined),
  configureUploads: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/measurement', () => ({
  getServiceStatus: jest
    .fn()
    .mockResolvedValue({ state: 'stopped', error: null }),
  subscribeToStatus: jest.fn(() => () => {}),
  startSession: jest.fn(),
  stopSession: jest.fn(),
}));
jest.mock('../src/storage/database', () => ({
  measurementStore: {
    accountSessions: jest.fn().mockResolvedValue([]),
    accountTrips: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../src/export/shareSession', () => ({ shareSession: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
  useNetInfo: () => ({ isConnected: true, type: 'wifi' }),
}));
jest.mock('@react-native-vector-icons/material-design-icons', () => ({
  MaterialDesignIcons: () => null,
}));
jest.mock('react-native-safe-area-context', () => {
  const { View: V } = require('react-native');
  return { SafeAreaProvider: V, SafeAreaView: V };
});
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: any) => children,
  useIsFocused: () => true,
}));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('@react-navigation/bottom-tabs', () => {
  const ReactLocal = require('react');
  const { View: V, Button: B } = require('react-native');
  return {
    createBottomTabNavigator: () => ({
      Screen: () => null,
      Navigator: ({ children }: any) => {
        const [index, setIndex] = ReactLocal.useState(0);
        const screens = ReactLocal.Children.toArray(children);
        const C = screens[index].props.component;
        return (
          <V>
            {screens.map((s: any, i: number) => (
              <B
                key={s.props.name}
                title={s.props.name}
                onPress={() => setIndex(i)}
              />
            ))}
            <C />
          </V>
        );
      },
    }),
  };
});
jest.mock('react-native-paper', () => {
  const {
    View: V,
    Text: T,
    Button: B,
    TextInput: I,
    Switch: S,
  } = require('react-native');
  const Card = Object.assign(V, { Content: V });
  return {
    MD3LightTheme: { colors: {} },
    PaperProvider: V,
    Text: T,
    TextInput: I,
    Switch: S,
    Button: ({ children, ...props }: any) => <B {...props} title={children} />,
    Card,
    Chip: T,
    HelperText: T,
    Divider: V,
    ActivityIndicator: V,
    List: {
      Accordion: ({ title }: any) => <T>{title}</T>,
      Item: ({ title }: any) => <T>{title}</T>,
    },
  };
});
import SkyMeasure from '../src/participant/SkyMeasure';
import {
  localSession,
  loadProfile,
  secureStorage,
  signIn,
} from '../src/auth/client';
import { startSession } from '../src/services/measurement';
let renderer: ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
  (localSession as jest.Mock).mockResolvedValue(mockSession);
  (loadProfile as jest.Mock).mockResolvedValue(mockProfile);
  (secureStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify(mockProfile),
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
const render = async () => {
  await act(async () => {
    renderer = create(<SkyMeasure />);
  });
};
const press = async (title: string) =>
  act(async () =>
    renderer.root
      .findAllByType(Button)
      .find(b => b.props.title === title)!
      .props.onPress(),
  );
const contains = (text: string) =>
  renderer.root
    .findAllByType(Text)
    .some(n => String(n.props.children).includes(text));
test('participants enroll without visible sign-in or researcher controls', async () => {
  (localSession as jest.Mock).mockResolvedValue(null);
  await render();
  await press('Get started');
  expect(require('../src/auth/client').enrollParticipant).toHaveBeenCalled();
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => /Google|shadow|manual collection/.test(String(b.props.title))),
  ).toBe(false);
  expect(signIn).not.toHaveBeenCalled();
  expect(startSession).not.toHaveBeenCalled();
});
test('accepted participants see required trip details and Settings without account controls', async () => {
  await render();
  await press('Sessions');
  expect(contains('Your contributions')).toBe(true);
  await press('Settings');
  expect(contains('Settings')).toBe(true);
  await press('Home');
  expect(contains('Where are you flying?')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start trip'),
  ).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start session'),
  ).toBe(false);
});
test('cached consent enables offline startup without a fresh profile response', async () => {
  (loadProfile as jest.Mock).mockRejectedValue(new Error('Offline'));
  await render();
  expect(contains('Where are you flying?')).toBe(true);
});
test('missing consent cannot start collection', async () => {
  (loadProfile as jest.Mock).mockResolvedValue({
    ...mockProfile,
    consentVersion: null,
  });
  (secureStorage.getItem as jest.Mock).mockResolvedValue(null);
  await render();
  expect(contains('Before you begin')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start session'),
  ).toBe(false);
});
test('existing participants review the combined M-Lab publication disclosure before Start', async () => {
  const old = {
    ...mockProfile,
    consentVersion: 'skymeasure-flight-2026-11-01',
  };
  (loadProfile as jest.Mock).mockResolvedValue(old);
  (secureStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(old));
  await render();
  expect(contains('M-Lab collects and publicly publishes')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'M-Lab public data policy'),
  ).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start trip'),
  ).toBe(false);
});
test('accepted participant Home has one Start and no separate speed-test button', async () => {
  await render();
  const titles = renderer.root.findAllByType(Button).map(b => b.props.title);
  expect(titles.filter(t => t === 'Start trip')).toHaveLength(1);
  expect(titles).not.toContain('Start speed test');
});

test('Start needs notification permission but does not request GPS access', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(36);
  const permissions = jest
    .spyOn(PermissionsAndroid, 'request')
    .mockResolvedValue('granted');
  const locationRequests = jest.spyOn(PermissionsAndroid, 'requestMultiple');
  try {
    await render();
    await act(async () => {
      for (const [label, value] of [
        ['Flight number', 'QR123'],
        ['From', 'Doha'],
        ['To', 'London'],
        ['Expected hours', '8'],
      ])
        renderer.root
          .findAllByType(TextInput)
          .find(input => input.props.label === label)!
          .props.onChangeText(value);
    });
    await press('Start trip');
    expect(permissions).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    expect(locationRequests).not.toHaveBeenCalled();
    expect(require('../src/trips/runtime').startTrip).toHaveBeenCalledWith(
      'account-a',
      {
        flightNumber: 'QR123',
        departure: 'Doha',
        arrival: 'London',
        expectedMinutes: 480,
      },
      false,
    );
  } finally {
    jest.restoreAllMocks();
  }
});
test('incomplete flight details cannot start and there is no Skip button', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  try {
    await render();
    expect(
      renderer.root
        .findAllByType(Button)
        .some(b => b.props.title === 'Skip and start'),
    ).toBe(false);
    await press('Start trip');
    expect(require('../src/trips/runtime').startTrip).not.toHaveBeenCalled();
    expect(contains('Expected flight length')).toBe(true);
  } finally {
    jest.restoreAllMocks();
  }
});
test('full study details are accessible while the publication disclosure stays visible', async () => {
  (loadProfile as jest.Mock).mockResolvedValue({
    ...mockProfile,
    consentVersion: null,
  });
  (secureStorage.getItem as jest.Mock).mockResolvedValue(null);
  await render();
  expect(contains('300 MiB')).toBe(false);
  expect(contains('M-Lab collects and publicly publishes')).toBe(true);
  await press('Read full study details');
  expect(contains('300 MiB')).toBe(true);
  await press('Hide study details');
  expect(contains('300 MiB')).toBe(false);
});

test('missing profile offers retry without creating an identity or opening Google', async () => {
  (loadProfile as jest.Mock).mockRejectedValue(
    new Error('Sign-in needs to be restored'),
  );
  (secureStorage.getItem as jest.Mock).mockResolvedValue(null);
  await render();
  expect(contains('Reconnect to SkyMeasure')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => /Google/.test(String(b.props.title))),
  ).toBe(false);
  const profileCalls = (loadProfile as jest.Mock).mock.calls.length;
  await press('Retry connection');
  expect(loadProfile).toHaveBeenCalledTimes(profileCalls + 1);
  expect(signIn).not.toHaveBeenCalled();
});
test('a deleted account response replaces cached Home with explicit recovery', async () => {
  const { ResearchAccessError } = require('../src/auth/client');
  (loadProfile as jest.Mock).mockRejectedValue(
    new ResearchAccessError(
      403,
      'account_deleted',
      'This account has been deleted',
    ),
  );
  await render();
  expect(contains('Reconnect to SkyMeasure')).toBe(true);
  expect(contains('This account has been deleted')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start trip'),
  ).toBe(false);
});

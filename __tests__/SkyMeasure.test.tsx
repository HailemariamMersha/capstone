import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Button, Text } from 'react-native';
const mockSession = {
  user: { id: 'account-a', email: 'a@example.invalid', user_metadata: {} },
};
const mockProfile = {
  participantId: 'p',
  role: 'participant',
  consentVersion: 'skymeasure-staging-2026-10-22',
  requiredConsentVersion: 'skymeasure-staging-2026-10-22',
  mobileUploads: false,
};
jest.mock('../src/auth/client', () => ({
  configured: true,
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
  measurementStore: { accountSessions: jest.fn().mockResolvedValue([]) },
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
}));
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
test('signed-out users see the common Google registration/sign-in control', async () => {
  (localSession as jest.Mock).mockResolvedValue(null);
  await render();
  await press('Continue with Google');
  expect(signIn).toHaveBeenCalled();
  expect(startSession).not.toHaveBeenCalled();
});
test('accepted participant can navigate and starts with owned ten-minute packet settings', async () => {
  await render();
  await press('Sessions');
  expect(contains('Your contributions')).toBe(true);
  await press('Account');
  expect(contains('Your account')).toBe(true);
  await press('Home');
  await press('Start session');
  expect(startSession).toHaveBeenCalledWith(
    expect.objectContaining({
      maxDurationMs: 600000,
      maxPayloadBytes: 104857600,
      httpEnabled: false,
    }),
    undefined,
    'account-a',
  );
});
test('cached consent enables offline startup without a fresh profile response', async () => {
  (loadProfile as jest.Mock).mockRejectedValue(new Error('Offline'));
  await render();
  expect(contains('Your network, understood.')).toBe(true);
});
test('missing consent cannot start collection', async () => {
  (loadProfile as jest.Mock).mockResolvedValue({
    ...mockProfile,
    consentVersion: null,
  });
  (secureStorage.getItem as jest.Mock).mockResolvedValue(null);
  await render();
  expect(contains('Take part, informed.')).toBe(true);
  expect(
    renderer.root
      .findAllByType(Button)
      .some(b => b.props.title === 'Start session'),
  ).toBe(false);
});

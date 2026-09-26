import React from 'react';
import {
  AppState,
  Button,
  PermissionsAndroid,
  Platform,
  Text,
} from 'react-native';
import { act, create } from 'react-test-renderer';
import App from '../App';
import {
  getServiceStatus,
  startSession,
  stopSession,
  subscribeToStatus,
} from '../src/services/measurement';

jest.mock('../src/components/SyncPanel', () => () => null);
jest.mock('../src/components/SessionHistory', () => () => null);
import { DEFAULT_SESSION_CONFIG } from '../src/sessions/config';

jest.mock('../src/services/measurement', () => ({
  isMeasurementSupported: true,
  getServiceStatus: jest.fn(),
  startSession: jest.fn(),
  stopSession: jest.fn(),
  subscribeToStatus: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaProvider: View, SafeAreaView: View };
});

const stopped = {
  state: 'stopped',
  sessionId: null,
  startedAt: null,
  elapsedMs: 0,
  heartbeatCount: 0,
  lastHeartbeatAt: null,
  error: null,
};
const running = {
  ...stopped,
  state: 'running',
  sessionId: 'shared-session',
  startedAt: 1000,
  elapsedMs: 60000,
  heartbeatCount: 2,
};
let renderer;
let statusListener;
let appStateListener;
let unsubscribe;
let removeAppState;
const button = title =>
  renderer.root.findAllByType(Button).find(node => node.props.title === title);
const state = () =>
  renderer.root.findByProps({ testID: 'service-state' }).props.children;
const textIncludes = value =>
  renderer.root
    .findAllByType(Text)
    .some(node => JSON.stringify(node.props.children).includes(value));

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(36);
  getServiceStatus.mockResolvedValue(stopped);
  startSession.mockResolvedValue('shared-session');
  stopSession.mockResolvedValue(undefined);
  unsubscribe = jest.fn();
  removeAppState = jest.fn();
  subscribeToStatus.mockImplementation(listener => {
    statusListener = listener;
    return unsubscribe;
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event, listener) => {
      appStateListener = listener;
      return { remove: removeAppState };
    });
  jest
    .spyOn(PermissionsAndroid, 'request')
    .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
});
afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount());
    renderer = undefined;
  }
  jest.restoreAllMocks();
});
const render = async () => {
  await act(async () => {
    renderer = create(<App />);
  });
};

test('restores an existing shared session on mount without starting another', async () => {
  getServiceStatus.mockResolvedValue(running);
  await render();
  expect(state()).toBe('running');
  expect(textIncludes('shared-session')).toBe(true);
  expect(startSession).not.toHaveBeenCalled();
  expect(button('Start session').props.disabled).toBe(true);
  expect(button('Stop session').props.disabled).toBe(false);
});

test('starts and stops through the session controller and refreshes authoritative status', async () => {
  await render();
  getServiceStatus.mockResolvedValue(running);
  await act(async () => button('Start session').props.onPress());
  expect(startSession).toHaveBeenCalledWith(DEFAULT_SESSION_CONFIG, undefined);
  expect(state()).toBe('running');
  getServiceStatus.mockResolvedValue(stopped);
  await act(async () => button('Stop session').props.onPress());
  expect(stopSession).toHaveBeenCalledTimes(1);
  expect(state()).toBe('stopped');
});

test('accepts session status events and refreshes when reopened', async () => {
  getServiceStatus.mockResolvedValue(running);
  await render();
  await act(async () => statusListener(stopped));
  expect(state()).toBe('stopped');
  await act(async () => appStateListener('active'));
  expect(state()).toBe('running');
  expect(startSession).not.toHaveBeenCalled();
});

test('permission denial explains hidden notification and still starts', async () => {
  PermissionsAndroid.request.mockResolvedValue(
    PermissionsAndroid.RESULTS.DENIED,
  );
  await render();
  await act(async () => button('Start session').props.onPress());
  expect(startSession).toHaveBeenCalledTimes(1);
  expect(textIncludes('Notifications are disabled')).toBe(true);
});

test('startup rejection displays an error and releases controls', async () => {
  startSession.mockRejectedValue(new Error('Foreground startup rejected'));
  await render();
  await act(async () => button('Start session').props.onPress());
  expect(textIncludes('Foreground startup rejected')).toBe(true);
  expect(button('Start session').props.disabled).toBe(false);
});

test('ignores stale status responses after a newer service event', async () => {
  await render();
  let resolve;
  getServiceStatus.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  let refresh;
  await act(async () => {
    refresh = button('Refresh status').props.onPress();
  });
  await act(async () => statusListener(running));
  await act(async () => {
    resolve(stopped);
    await refresh;
  });
  expect(state()).toBe('running');
});

test('unsubscribes on unmount without stopping the background task', async () => {
  await render();
  await act(async () => renderer.unmount());
  renderer = undefined;
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(removeAppState).toHaveBeenCalledTimes(1);
  expect(stopSession).not.toHaveBeenCalled();
});

test('coalesces rapid taps while a background startup is pending', async () => {
  let resolveStart;
  startSession.mockImplementation(
    () =>
      new Promise(resolve => {
        resolveStart = resolve;
      }),
  );
  await render();
  let first;
  await act(async () => {
    first = button('Start session').props.onPress();
    button('Start session').props.onPress();
  });
  expect(startSession).toHaveBeenCalledTimes(1);
  expect(button('Start session').props.disabled).toBe(true);
  getServiceStatus.mockResolvedValue(running);
  await act(async () => {
    resolveStart('shared-session');
    await first;
  });
  expect(state()).toBe('running');
});

test('a failed initial status query can be retried without starting a service', async () => {
  getServiceStatus.mockRejectedValueOnce(new Error('Bridge unavailable'));
  await render();
  expect(textIncludes('Bridge unavailable')).toBe(true);
  expect(button('Start session').props.disabled).toBe(true);
  await act(async () => button('Refresh status').props.onPress());
  expect(state()).toBe('stopped');
  expect(button('Start session').props.disabled).toBe(false);
  expect(startSession).not.toHaveBeenCalled();
});

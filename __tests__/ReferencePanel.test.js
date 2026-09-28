import React from 'react';
import { AppState, Button, Switch } from 'react-native';
import { act, create } from 'react-test-renderer';
import ReferencePanel from '../src/components/ReferencePanel';
import { createReferenceSession } from '../src/reference/session';
jest.mock('../src/storage/database', () => ({ measurementStore: {} }));
jest.mock('../src/reference/session', () => ({
  createReferenceSession: jest.fn(),
}));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
let renderer, listener, finish, onBusyChange, onSaved;
const button = title =>
  renderer.root.findAllByType(Button).find(node => node.props.title === title);
const webviews = () => renderer.root.findAllByType('WebView');
async function render() {
  await act(async () => {
    renderer = create(
      <ReferencePanel idle onBusyChange={onBusyChange} onSaved={onSaved} />,
    );
  });
}
async function acceptAndStart() {
  await act(async () =>
    renderer.root.findByType(Switch).props.onValueChange(true),
  );
  await act(async () => button('Start NDT7 reference test').props.onPress());
}
beforeEach(() => {
  jest.useFakeTimers();
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, fn) => {
    listener = fn;
    return { remove: jest.fn() };
  });
  finish = jest.fn().mockResolvedValue();
  createReferenceSession.mockResolvedValue({ id: 'reference', finish });
  onBusyChange = jest.fn();
  onSaved = jest.fn();
});
afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount());
    renderer = undefined;
  }
  jest.clearAllMocks();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});
test('mounts no network-capable WebView before explicit consent and start', async () => {
  await render();
  expect(button('Start NDT7 reference test').props.disabled).toBe(true);
  expect(webviews()).toHaveLength(0);
  expect(createReferenceSession).not.toHaveBeenCalled();
  await acceptAndStart();
  expect(createReferenceSession).toHaveBeenCalledWith({}, true);
  expect(webviews()).toHaveLength(1);
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
});
test('backgrounding destroys WebView and saves cancellation', async () => {
  await render();
  await acceptAndStart();
  await act(async () => listener('background'));
  expect(webviews()).toHaveLength(0);
  expect(finish).toHaveBeenCalledWith([], 'cancelled');
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});
test('cancellation during database initialization never mounts WebView', async () => {
  let resolve;
  createReferenceSession.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  await render();
  await act(async () =>
    renderer.root.findByType(Switch).props.onValueChange(true),
  );
  let starting;
  await act(async () => {
    starting = button('Start NDT7 reference test').props.onPress();
  });
  await act(async () => listener('background'));
  await act(async () => {
    resolve({ id: 'reference', finish });
    await starting;
  });
  expect(webviews()).toHaveLength(0);
  expect(finish).toHaveBeenCalledWith([], 'cancelled');
});
test('native watchdog ends a WebView that never posts back', async () => {
  await render();
  await acceptAndStart();
  await act(async () => jest.advanceTimersByTime(50000));
  expect(finish).toHaveBeenCalledWith([], 'timeout');
  expect(webviews()).toHaveLength(0);
});

import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppState, Button, Switch } from 'react-native';
import ReferencePanel from '../src/components/ReferencePanel';
import { measurementStore } from '../src/storage/database';
import { currentActivity } from '../src/services/activityGate';

jest.mock('react-native-webview', () => ({
  WebView: props => require('react').createElement('MockWebView', props),
}));
jest.mock('../src/reference/html', () => ({
  referenceHtml: () => '<html></html>',
  NDT7_VERSION: '0.1.5',
  REFERENCE_BYTE_THRESHOLD: 52428800,
}));
jest.mock('../src/storage/database', () => ({
  measurementStore: {
    createSession: jest.fn(),
    addEvent: jest.fn(),
    beginAttempt: jest.fn(),
    finishAttempt: jest.fn(),
    endSession: jest.fn(),
  },
}));
let tree;
const props = () => ({
  idle: true,
  participant: { ownerId: 'account-a', collectorVersion: 'test' },
  onBusyChange: jest.fn(),
  onSaved: jest.fn(),
});
const button = title =>
  tree.root.findAllByType(Button).find(node => node.props.title === title);
beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
  measurementStore.createSession.mockResolvedValue('speed-session');
  measurementStore.beginAttempt.mockImplementation(async (id, type) => ({
    id: type,
    sessionId: id,
    type,
  }));
  for (const method of ['addEvent', 'finishAttempt', 'endSession'])
    measurementStore[method].mockResolvedValue();
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  expect(currentActivity()).toBeNull();
});
async function acceptAndStart() {
  await act(async () => tree.root.findByType(Switch).props.onValueChange(true));
  await act(async () => button('Start speed test').props.onPress());
}
test('requires fresh consent, saves owned results, and releases the gate before upload callback', async () => {
  const options = props();
  options.onSaved.mockImplementation(() =>
    expect(currentActivity()).toBeNull(),
  );
  await act(async () => {
    tree = create(<ReferencePanel {...options} />);
  });
  expect(button('Start speed test').props.disabled).toBe(true);
  await act(async () => button('Start speed test').props.onPress());
  expect(measurementStore.createSession).not.toHaveBeenCalled();
  await acceptAndStart();
  expect(measurementStore.createSession.mock.calls[0][2]).toBe('account-a');
  expect(tree.root.findByType(Switch).props.value).toBe(false);
  const results = ['download', 'upload'].map(direction => ({
    direction,
    host: 'ndt-test.measurement-lab.org',
    reason: 'complete',
    opened: true,
    cleanClose: true,
    clientBytes: 2000000,
    clientSeconds: 1,
    serverBytes: 1000000,
    serverSeconds: 1,
  }));
  await act(async () =>
    tree.root.findByType('MockWebView').props.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          version: 1,
          runId: 'speed-session',
          type: 'finished',
          reason: 'complete',
          results,
        }),
      },
    }),
  );
  expect(options.onSaved).toHaveBeenCalledTimes(1);
  expect(
    measurementStore.finishAttempt.mock.calls.map(([m]) => m.value),
  ).toEqual([16, 8]);
  expect(tree.root.findAllByType('MockWebView')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('16.00 Mbps');
});
test('leaving Home cancels the active WebView and retains failed observations', async () => {
  const options = props();
  await act(async () => {
    tree = create(<ReferencePanel {...options} />);
  });
  await acceptAndStart();
  await act(async () =>
    tree.update(<ReferencePanel {...options} idle={false} />),
  );
  expect(tree.root.findAllByType('MockWebView')).toHaveLength(0);
  expect(
    measurementStore.finishAttempt.mock.calls.every(
      ([m]) => m.value === null && !m.success,
    ),
  ).toBe(true);
  expect(options.onSaved).toHaveBeenCalledTimes(1);
});
test('navigation during session creation never starts network traffic', async () => {
  let resolve;
  measurementStore.createSession.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const options = props();
  await act(async () => {
    tree = create(<ReferencePanel {...options} />);
  });
  await act(async () => tree.root.findByType(Switch).props.onValueChange(true));
  let start;
  await act(async () => {
    start = button('Start speed test').props.onPress();
  });
  await act(async () =>
    tree.update(<ReferencePanel {...options} idle={false} />),
  );
  await act(async () => {
    resolve('speed-session');
    await start;
  });
  expect(tree.root.findAllByType('MockWebView')).toHaveLength(0);
  expect(measurementStore.endSession).toHaveBeenCalledWith(
    'speed-session',
    'completed',
    expect.stringContaining('cancelled'),
  );
});

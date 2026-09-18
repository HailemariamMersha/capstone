import React from 'react';
import { AppState, Button, Text, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import ProbePanel from '../src/components/ProbePanel';
import { runSuite } from '../src/measurements/runSuite';
import type { Measurement } from '../src/measurements/types';
jest.mock('../src/measurements/runSuite', () => ({ runSuite: jest.fn() }));
const suite = jest.mocked(runSuite);
let renderer: ReactTestRenderer;
let onState: (state: string) => void;
const button = (title: string) =>
  renderer.root.findAllByType(Button).find(node => node.props.title === title)!;
const hasText = (text: string) =>
  renderer.root
    .findAllByType(Text)
    .some(node => JSON.stringify(node.props.children).includes(text));
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onState = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
  suite.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  jest.restoreAllMocks();
});
const render = async () => {
  await act(async () => {
    renderer = create(<ProbePanel />);
  });
};
test('invalid configuration does not start a data-consuming run', async () => {
  await render();
  await act(async () =>
    renderer.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === 'Probe rounds')!
      .props.onChangeText('99'),
  );
  await act(async () => button('Run probes').props.onPress());
  expect(suite).not.toHaveBeenCalled();
  expect(hasText('between 1 and 10')).toBe(true);
});
test('displays the data estimate and structured probe results', async () => {
  suite.mockImplementation(
    async (_config, sessionId, _rounds, _signal, onResult) => {
      onResult({
        id: 'm1',
        sessionId,
        type: 'http_rtt',
        success: true,
        value: 42,
        unit: 'ms',
        durationMs: 42,
        timestamp: '2026-09-18',
        httpStatus: 200,
        transferredBytes: 4,
        probeRegion: 'local',
      } as Measurement);
    },
  );
  await render();
  expect(hasText('1.25')).toBe(true);
  await act(async () => button('Run probes').props.onPress());
  expect(hasText('42.00 ms')).toBe(true);
  expect(suite).toHaveBeenCalledTimes(1);
});
test('backgrounding cancels the run and rapid taps cannot start another', async () => {
  let finish!: () => void;
  suite.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await render();
  let pending!: Promise<void>;
  await act(async () => {
    pending = button('Run probes').props.onPress();
    button('Run probes').props.onPress();
  });
  expect(suite).toHaveBeenCalledTimes(1);
  await act(async () => {
    onState('background');
    finish();
    await pending;
  });
  expect(suite.mock.calls[0][3].aborted).toBe(true);
  expect(hasText('Run cancelled')).toBe(true);
  expect(button('Run probes').props.disabled).toBe(false);
});

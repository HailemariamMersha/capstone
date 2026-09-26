import React from 'react';
import { Button, Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import SessionHistory from '../src/components/SessionHistory';
import { measurementStore } from '../src/storage/database';
import { DEFAULT_SESSION_CONFIG } from '../src/sessions/config';
jest.mock('../src/export/shareSession', () => ({ shareSession: jest.fn() }));
jest.mock('../src/storage/database', () => ({
  measurementStore: {
    listSessions: jest.fn(),
    pendingCount: jest.fn(),
    listMeasurements: jest.fn(),
    listEvents: jest.fn(),
  },
}));
let renderer;
const session = {
  id: 'durable123',
  state: 'interrupted',
  startedAt: '2026-09-18T00:00:00Z',
  measurementCount: 1,
  config: DEFAULT_SESSION_CONFIG,
};
const button = title =>
  renderer.root.findAllByType(Button).find(n => n.props.title === title);
afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount());
    renderer = undefined;
  }
  jest.clearAllMocks();
});
test('loads stored history and resumes with the original configuration and identity', async () => {
  measurementStore.listSessions.mockResolvedValue([session]);
  measurementStore.pendingCount.mockResolvedValue(3);
  measurementStore.listMeasurements.mockResolvedValue([
    {
      state: 'complete',
      scheduledAt: session.startedAt,
      measurement: {
        id: 'm',
        type: 'download',
        success: false,
        errorType: 'interrupted',
        durationMs: 0,
        timestamp: session.startedAt,
      },
    },
  ]);
  measurementStore.listEvents.mockResolvedValue([]);
  const resume = jest.fn();
  await act(async () => {
    renderer = create(
      <SessionHistory revision={0} canResume onResume={resume} />,
    );
  });
  await act(async () => button('View durable1').props.onPress());
  expect(measurementStore.listMeasurements).toHaveBeenCalledWith(
    'durable123',
    50,
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .some(n =>
        JSON.stringify(n.props.children).includes('failed (interrupted)'),
      ),
  ).toBe(true);
  await act(async () => button('Resume durable1').props.onPress());
  expect(resume).toHaveBeenCalledWith(session);
  await act(async () =>
    renderer.update(
      <SessionHistory revision={1} canResume={false} onResume={resume} />,
    ),
  );
  expect(button('Resume durable1').props.disabled).toBe(true);
});

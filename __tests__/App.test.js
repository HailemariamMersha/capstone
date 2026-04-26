import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  appendFile: jest.fn(() => Promise.resolve()),
  exists: jest.fn(() => Promise.resolve(true)),
  readFile: jest.fn(() =>
    Promise.resolve(
      'timestamp,target_url,success,latency_ms,http_status,app_state,error\n',
    ),
  ),
  writeFile: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-background-actions', () => ({
  isRunning: jest.fn(() => false),
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  updateNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/services/deviceSettingsService', () => ({
  isBatteryOptimizationDisabled: jest.fn(() => Promise.resolve(false)),
  requestBatteryOptimizationExemption: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../src/services/preferencesService', () => ({
  hasPromptBeenShown: jest.fn(() => Promise.resolve(true)),
  markPromptAsShown: jest.fn(() => Promise.resolve()),
}));

test('renders correctly', async () => {
  jest.useFakeTimers();

  let renderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });

  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });

  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

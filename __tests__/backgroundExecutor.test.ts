import BackgroundService from 'react-native-background-actions';
import { createBackgroundExecutor } from '../src/background/backgroundExecutor';

jest.mock('react-native-background-actions', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
}));
const background = jest.mocked(BackgroundService);
let executor: ReturnType<typeof createBackgroundExecutor>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  background.start.mockImplementation(async task => {
    // Match the library: resolving the inner task automatically calls stop.
    task().then(() => BackgroundService.stop());
  });
  background.stop.mockResolvedValue(undefined);
  executor = createBackgroundExecutor();
});
afterEach(async () => {
  await executor.stop();
  jest.useRealTimers();
});

test('reports ready only once the actual JS task has been invoked', async () => {
  let invokeTask!: () => Promise<void>;
  background.start.mockImplementation(async task => {
    invokeTask = task;
  });
  let started = false;
  const start = executor.start(jest.fn(), jest.fn()).then(() => {
    started = true;
  });
  await Promise.resolve();
  expect(started).toBe(false);
  invokeTask();
  await start;
  expect(started).toBe(true);
  expect(background.start.mock.calls[0][1]).toMatchObject({
    foregroundServiceType: ['specialUse'],
  });
});

test('ticks every minute and stop cancels future heartbeats', async () => {
  const tick = jest.fn();
  await executor.start(tick, jest.fn());
  await jest.advanceTimersByTimeAsync(120_000);
  expect(tick).toHaveBeenCalledTimes(2);
  await executor.stop();
  await jest.advanceTimersByTimeAsync(120_000);
  expect(tick).toHaveBeenCalledTimes(2);
});

test('missing JS task invocation times out and a late task cannot restart timers', async () => {
  let invokeTask!: () => Promise<void>;
  background.start.mockImplementation(async task => {
    invokeTask = task;
  });
  const tick = jest.fn();
  const start = executor.start(tick, jest.fn());
  await Promise.all([
    expect(start).rejects.toThrow('did not start within 10 seconds'),
    jest.advanceTimersByTimeAsync(10_000),
  ]);
  invokeTask();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(tick).not.toHaveBeenCalled();
});

test('rapid stop/restart does not let the old task terminate the new session', async () => {
  const oldTick = jest.fn();
  const newTick = jest.fn();
  await executor.start(oldTick, jest.fn());
  await executor.stop();
  await executor.start(newTick, jest.fn());
  await jest.advanceTimersByTimeAsync(60_000);
  expect(oldTick).not.toHaveBeenCalled();
  expect(newTick).toHaveBeenCalledTimes(1);
  expect(background.stop).toHaveBeenCalledTimes(1);
});

test('OS expiry is forwarded and its listener is removed at stop', async () => {
  const error = jest.fn();
  await executor.start(jest.fn(), error);
  const expire = background.on.mock.calls[0][1] as () => void;
  expire();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'The operating system ended background execution.',
    }),
  );
  await executor.stop();
  expect(background.removeListener).toHaveBeenCalledWith('expiration', expire);
});

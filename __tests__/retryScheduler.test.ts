import { createRetryScheduler } from '../src/sync/retryScheduler';
import { normalizeNetId } from '../src/trips/payment';
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100000);
});
afterEach(() => jest.useRealTimers());
test('automatic retry wakes at persisted deadline without a button or new network event', async () => {
  const run = jest.fn();
  const nextAttempt = jest
    .fn()
    .mockResolvedValueOnce(115000)
    .mockResolvedValue(null);
  const scheduler = createRetryScheduler({ run, nextAttempt, now: Date.now });
  scheduler.setActive(true);
  await jest.advanceTimersByTimeAsync(14999);
  expect(run).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.setActive(false);
});
test('failure schedules another bounded opportunity; inactive apps cancel wake-ups', async () => {
  const nextAttempt = jest
    .fn()
    .mockResolvedValueOnce(100000)
    .mockResolvedValue(131000);
  const run = jest.fn().mockRejectedValue(new Error('retry later'));
  const scheduler = createRetryScheduler({ run, nextAttempt, now: Date.now });
  scheduler.setActive(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.setActive(false);
  await jest.advanceTimersByTimeAsync(60000);
  expect(run).toHaveBeenCalledTimes(1);
});
test('duplicate network wake-ups cannot overlap an existing upload', async () => {
  let finish!: () => void;
  const run = jest.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const scheduler = createRetryScheduler({
    run,
    nextAttempt: async () => 100000,
    now: Date.now,
  });
  scheduler.setActive(true);
  await jest.advanceTimersByTimeAsync(1000);
  scheduler.wake();
  scheduler.wake();
  await jest.advanceTimersByTimeAsync(5000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.setActive(false);
  finish();
});
test.each(['', 'a', 'abc@nyu.edu', 'ab c', '../abc', 'a'.repeat(33)])(
  'invalid NetID %j is rejected',
  input => {
    expect(() => normalizeNetId(input)).toThrow('NetID');
  },
);
test('NetID normalization accepts common NYU identifiers without claiming verification', () => {
  expect(normalizeNetId(' ABC123 ')).toBe('abc123');
});

test('a trip closing after an idle app start is discovered without another lifecycle event', async () => {
  const run = jest.fn();
  const nextAttempt = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(100000)
    .mockResolvedValue(null);
  const scheduler = createRetryScheduler({ run, nextAttempt, now: Date.now });
  scheduler.setActive(true);
  await jest.advanceTimersByTimeAsync(30000);
  expect(run).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.setActive(false);
});

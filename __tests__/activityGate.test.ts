import {
  acquireActivity,
  acquireMeasurementActivity,
  currentActivity,
} from '../src/services/activityGate';

afterEach(() => {
  expect(currentActivity()).toBeNull();
  jest.useRealTimers();
});
test('Start cancels sync and transfers its lease only after the request settles', async () => {
  const interrupt = jest.fn();
  const releaseSync = acquireActivity('sync', interrupt);
  const pending = acquireMeasurementActivity();
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(currentActivity()).toBe('sync');
  expect(() => acquireActivity('sync')).toThrow();
  releaseSync();
  expect(currentActivity()).toBe('measurement');
  const releaseMeasurement = await pending;
  releaseSync(); // A late/duplicate cleanup cannot clear the new lease.
  expect(currentActivity()).toBe('measurement');
  releaseMeasurement();
});
test('duplicate Start does not create a second handoff', async () => {
  const releaseSync = acquireActivity('sync', jest.fn());
  const pending = acquireMeasurementActivity();
  await expect(acquireMeasurementActivity()).rejects.toThrow(
    'already starting',
  );
  releaseSync();
  (await pending)();
});
test('an unresponsive request is never force-unlocked or given an orphan measurement lease', async () => {
  jest.useFakeTimers();
  const releaseSync = acquireActivity('sync', jest.fn());
  const pending = acquireMeasurementActivity();
  const assertion = expect(pending).rejects.toThrow('still stopping');
  await jest.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(currentActivity()).toBe('sync');
  releaseSync();
  expect(currentActivity()).toBeNull();
});

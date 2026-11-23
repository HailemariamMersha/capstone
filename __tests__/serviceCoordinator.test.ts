import { createServiceCoordinator } from '../src/background/serviceCoordinator';
jest.mock('../src/background/backgroundExecutor', () => ({
  createBackgroundExecutor: () => ({ start: jest.fn(), stop: jest.fn() }),
}));
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function fixture() {
  const executor = {
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    setPhase: jest.fn(async () => {}),
  };
  return { executor, coordinator: createServiceCoordinator(executor) };
}
test('Stop hands the existing task to uploads and stops it only after drain completion', async () => {
  const { executor, coordinator } = fixture();
  let finish!: () => void;
  const done = new Promise<void>(r => {
    finish = r;
  });
  const drain = jest.fn(async () => done);
  coordinator.registerDrain(drain);
  await coordinator.startCollection(jest.fn(), jest.fn());
  expect(await coordinator.handoffToUploads()).toBe(true);
  await flush();
  expect(executor.start).toHaveBeenCalledTimes(1);
  expect(executor.stop).not.toHaveBeenCalled();
  expect(executor.setPhase).toHaveBeenCalledWith('upload');
  expect(coordinator.uploading()).toBe(true);
  finish();
  await flush();
  expect(executor.stop).toHaveBeenCalledTimes(1);
  expect(coordinator.uploading()).toBe(false);
});
test('a new trip preempts draining and stale cleanup cannot terminate its service', async () => {
  const { executor, coordinator } = fixture();
  let signal!: AbortSignal, finish!: () => void;
  coordinator.registerDrain(async s => {
    signal = s;
    await new Promise<void>(r => {
      finish = r;
    });
  });
  await coordinator.startCollection(jest.fn(), jest.fn());
  await coordinator.handoffToUploads();
  await flush();
  await coordinator.startCollection(jest.fn(), jest.fn());
  expect(signal.aborted).toBe(true);
  finish();
  await flush();
  expect(executor.start).toHaveBeenCalledTimes(1);
  expect(executor.stop).not.toHaveBeenCalled();
  expect(executor.setPhase).toHaveBeenLastCalledWith('collection');
  await coordinator.stop();
});
test('native expiration cancels the uploader without acknowledging unfinished work', async () => {
  const { executor, coordinator } = fixture();
  let uploadSignal!: AbortSignal;
  coordinator.registerDrain(async signal => {
    uploadSignal = signal;
    await new Promise<void>(resolve =>
      signal.addEventListener('abort', () => resolve()),
    );
  });
  await coordinator.startUploads();
  await flush();
  const expire = (executor.start.mock.calls[0] as any)[1];
  expire(new Error('OS timeout'));
  await flush();
  expect(uploadSignal.aborted).toBe(true);
  expect(executor.stop).toHaveBeenCalledTimes(1);
});
test('with no eligible drain handler a finished collector releases the service', async () => {
  const { executor, coordinator } = fixture();
  await coordinator.startCollection(jest.fn(), jest.fn());
  expect(await coordinator.handoffToUploads()).toBe(false);
  expect(executor.stop).toHaveBeenCalledTimes(1);
});

test('a delayed previous Stop cannot hand a newly started collector to the uploader', async () => {
  const { executor, coordinator } = fixture();
  coordinator.registerDrain(async () => {});
  const previous = await coordinator.startCollection(jest.fn(), jest.fn());
  await coordinator.startCollection(jest.fn(), jest.fn());
  expect(await coordinator.handoffToUploads(previous)).toBe(false);
  expect(await coordinator.startUploads()).toBe(false);
  expect(executor.setPhase).not.toHaveBeenCalledWith('upload');
  await coordinator.stop();
});

test('an automatic retry queued behind collection startup cannot take its service', async () => {
  const { executor, coordinator } = fixture();
  coordinator.registerDrain(async () => {});
  const starting = coordinator.startCollection(jest.fn(), jest.fn());
  const retry = coordinator.startUploads();
  await starting;
  expect(await retry).toBe(false);
  expect(executor.setPhase).not.toHaveBeenCalledWith('upload');
  await coordinator.stop();
});

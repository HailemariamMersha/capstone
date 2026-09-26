import type { MeasurementStore } from '../src/storage/types';
import { createSessionController } from '../src/sessions/sessionController';

function setup() {
  const executor = {
    start: jest.fn(
      async (_tick: () => void, _error: (error: Error) => void) => {},
    ),
    stop: jest.fn(async () => {}),
  };
  let next = 0;
  const store = {
    initialize: jest.fn(async () => {}),
    createSession: jest.fn(async () => `session-${++next}`),
    endSession: jest.fn(async () => {}),
    touchSession: jest.fn(async () => {}),
  };
  const loop = {
    done: new Promise<void>(() => {}),
    stop: jest.fn(async () => {}),
  };
  return {
    executor,
    store,
    loop,
    controller: createSessionController(
      executor,
      store as unknown as MeasurementStore,
      () => loop,
    ),
  };
}

test('concurrent starts share one task and one session ID', async () => {
  const { executor, controller } = setup();
  const [first, second] = await Promise.all([
    controller.startSession(),
    controller.startSession(),
  ]);
  expect(first).toBe(second);
  expect(executor.start).toHaveBeenCalledTimes(1);
  expect((await controller.getServiceStatus()).state).toBe('running');
});

test('a queued stop waits for startup and clears session state', async () => {
  const { executor, controller } = setup();
  let ready!: () => void;
  executor.start.mockImplementation(
    () =>
      new Promise(resolve => {
        ready = resolve;
      }),
  );
  const start = controller.startSession();
  const stop = controller.stopSession();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  expect((await controller.getServiceStatus()).state).toBe('starting');
  expect(executor.stop).not.toHaveBeenCalled();
  ready();
  await start;
  await stop;
  expect(await controller.getServiceStatus()).toMatchObject({
    state: 'stopped',
    sessionId: null,
    heartbeatCount: 0,
  });
});

test('startup rejection cleans up, reports the error, and permits retry', async () => {
  const { executor, controller } = setup();
  executor.start.mockRejectedValueOnce(new Error('Start refused'));
  await expect(controller.startSession()).rejects.toThrow('Start refused');
  expect(executor.stop).toHaveBeenCalledTimes(1);
  expect(await controller.getServiceStatus()).toMatchObject({
    state: 'stopped',
    error: 'Start refused',
  });
  await controller.startSession();
  expect(await controller.getServiceStatus()).toMatchObject({
    state: 'running',
    error: null,
  });
});

test('heartbeats update shared state and stale callbacks cannot affect a new session', async () => {
  const { executor, controller } = setup();
  const first = await controller.startSession();
  const oldTick = executor.start.mock.calls[0][0];
  oldTick();
  expect((await controller.getServiceStatus()).heartbeatCount).toBe(2);
  await controller.stopSession();
  const second = await controller.startSession();
  expect(second).not.toBe(first);
  oldTick();
  expect((await controller.getServiceStatus()).heartbeatCount).toBe(1);
});

test('an OS expiration ends the session and preserves the reason', async () => {
  const { executor, controller } = setup();
  await controller.startSession();
  executor.start.mock.calls[0][1](new Error('Background time expired'));
  // Enqueue behind error cleanup to observe its completed state.
  await controller.stopSession();
  expect(await controller.getServiceStatus()).toMatchObject({
    state: 'stopped',
    error: 'Background time expired',
  });
});

test('cleanup failure preserves a retryable Stop control', async () => {
  const { executor, controller } = setup();
  await controller.startSession();
  executor.stop.mockRejectedValueOnce(new Error('Stop refused'));
  await expect(controller.stopSession()).rejects.toThrow('Stop refused');
  expect(await controller.getServiceStatus()).toMatchObject({
    state: 'running',
    error: 'Stop refused',
  });
  await controller.stopSession();
  expect((await controller.getServiceStatus()).state).toBe('stopped');
});

test('unsubscribe and repeated stop are harmless; elapsed time is monotonic', async () => {
  const { executor, controller } = setup();
  const listener = jest.fn();
  const unsubscribe = controller.subscribeToStatus(listener);
  const clock = jest.spyOn(performance, 'now').mockReturnValue(100);
  await controller.startSession();
  clock.mockReturnValue(700);
  expect((await controller.getServiceStatus()).elapsedMs).toBe(600);
  unsubscribe();
  listener.mockClear();
  await controller.stopSession();
  await controller.stopSession();
  expect(executor.stop).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
  clock.mockRestore();
});

test('records startup failure and stops probes before closing the session', async () => {
  const { executor, store, loop, controller } = setup();
  executor.start.mockRejectedValueOnce(new Error('permission'));
  await expect(controller.startSession()).rejects.toThrow('permission');
  expect(store.endSession).toHaveBeenCalledWith(
    'session-1',
    'interrupted',
    'Startup failed: permission',
  );
  await controller.startSession();
  await controller.stopSession();
  expect(loop.stop.mock.invocationCallOrder[0]).toBeLessThan(
    store.endSession.mock.invocationCallOrder[1],
  );
});
test('storage failure prevents starting the platform service', async () => {
  const { executor, store, controller } = setup();
  store.createSession.mockRejectedValueOnce(new Error('disk full'));
  await expect(controller.startSession()).rejects.toThrow('disk full');
  expect(executor.start).not.toHaveBeenCalled();
});

test('a naturally completed schedule closes the service and session', async () => {
  const { controller, loop, executor, store } = setup();
  loop.done = Promise.resolve();
  await controller.startSession();
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  expect((await controller.getServiceStatus()).state).toBe('stopped');
  expect(executor.stop).toHaveBeenCalledTimes(1);
  expect(store.endSession).toHaveBeenCalledWith(
    'session-1',
    'completed',
    expect.stringContaining('limit'),
  );
});

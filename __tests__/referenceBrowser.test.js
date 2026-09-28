const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('scripts/ndt7-browser.js', 'utf8');
let messages, workers, discover, context;
const urls = {
  '///ndt/v7/download':
    'wss://ndt-test.measurement-lab.org/ndt/v7/download?token=secret',
  '///ndt/v7/upload':
    'wss://ndt-test.measurement-lab.org/ndt/v7/upload?token=secret',
};
const flush = async () => {
  for (let n = 0; n < 8; n++) {
    await Promise.resolve();
  }
};
async function start(accepted = true) {
  context.window.capstoneReference.accepted = accepted;
  vm.runInNewContext(source, context);
  await flush();
}
function emit(data, index = workers.length - 1) {
  workers[index].onmessage({ data });
}
function sample(direction, bytes = 1000, seconds = 1) {
  emit({
    MsgType: 'measurement',
    Source: 'client',
    ClientData: { NumBytes: bytes, ElapsedTime: seconds },
  });
  if (direction === 'upload') {
    emit({
      MsgType: 'measurement',
      Source: 'server',
      ServerMessage: JSON.stringify({
        AppInfo: { NumBytes: bytes / 2, ElapsedTime: seconds * 1000000 },
      }),
    });
  }
}
async function complete(direction) {
  emit({ MsgType: 'start' });
  sample(direction);
  emit({ MsgType: 'transport_close', clean: true, code: 1000 });
  emit({ MsgType: 'complete' });
  await flush();
}
beforeEach(() => {
  jest.useFakeTimers();
  messages = [];
  workers = [];
  discover = jest.fn().mockResolvedValue(urls);
  class FakeWorker {
    constructor() {
      workers.push(this);
    }
    postMessage = jest.fn();
    terminate = jest.fn();
  }
  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => 'blob:test';
  FakeURL.revokeObjectURL = jest.fn();
  context = {
    window: {
      capstoneReference: {
        runId: 'run',
        workers: { download: '', upload: '' },
        byteThreshold: 5000,
      },
      ReactNativeWebView: {
        postMessage: value => messages.push(JSON.parse(value)),
      },
    },
    ndt7: { discoverServerURLs: discover },
    Worker: FakeWorker,
    URL: FakeURL,
    Blob: class {},
    setTimeout,
    clearTimeout,
  };
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});
test('does not discover a server or start a worker without consent', async () => {
  await start(false);
  expect(discover).not.toHaveBeenCalled();
  expect(workers).toHaveLength(0);
  expect(messages.at(-1).reason).toBe('consent_required');
});
test('uses download client and upload server counters and strips discovery tokens', async () => {
  await start();
  await complete('download');
  await complete('upload');
  expect(messages.at(-1)).toMatchObject({
    type: 'finished',
    reason: 'complete',
    results: [
      {
        direction: 'download',
        clientBytes: 1000,
        clientSeconds: 1,
        reason: 'complete',
      },
      {
        direction: 'upload',
        serverBytes: 500,
        serverSeconds: 1,
        reason: 'complete',
      },
    ],
  });
  expect(JSON.stringify(messages)).not.toContain('secret');
  expect(
    workers.every(worker => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
});
test('connection watchdog and empty close cannot be successful measurements', async () => {
  await start();
  jest.advanceTimersByTime(10000);
  await flush();
  expect(messages.at(-1).results[0].reason).toBe('timeout');
  emit({ MsgType: 'complete' });
  await flush();
  expect(messages.at(-1).results[1].reason).toBe('invalid_response');
});
test('abnormal closure is a failure even with valid counters', async () => {
  await start();
  emit({ MsgType: 'start' });
  sample('download');
  emit({ MsgType: 'transport_close', clean: false, code: 1006 });
  emit({ MsgType: 'complete' });
  await flush();
  expect(messages.at(-1).results[0].reason).toBe('invalid_response');
});
test('threshold cancels traffic and prevents starting the second direction', async () => {
  await start();
  emit({ MsgType: 'start' });
  sample('download', 5500);
  await flush();
  expect(messages.at(-1)).toMatchObject({
    reason: 'data_threshold',
    results: [{ clientBytes: 5500, reason: 'data_threshold' }],
  });
  expect(workers).toHaveLength(1);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
test('cancels during discovery and ignores a late discovery response', async () => {
  let resolve;
  discover.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  await start();
  context.window.stopReference();
  resolve(urls);
  await flush();
  expect(workers).toHaveLength(0);
  expect(messages.at(-1).reason).toBe('cancelled');
});
test('refuses insecure or unexpected discovery destinations', async () => {
  discover.mockResolvedValue({
    ...urls,
    '///ndt/v7/upload': 'wss://unrelated.example/ndt/v7/upload',
  });
  await start();
  expect(workers).toHaveLength(0);
  expect(messages.at(-1).reason).toBe('network');
});
test('malformed server telemetry becomes a failure, not a hung run', async () => {
  await start();
  emit({ MsgType: 'measurement', Source: 'server', ServerMessage: '{' });
  await flush();
  expect(messages.at(-1).results[0].reason).toBe('invalid_response');
});
test('whole-run watchdog bounds stalled discovery', async () => {
  discover.mockReturnValue(new Promise(() => {}));
  await start();
  jest.advanceTimersByTime(45000);
  expect(messages.at(-1).reason).toBe('timeout');
});

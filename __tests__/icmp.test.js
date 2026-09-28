import { runIcmp } from '../src/measurements/icmp';
import { ICMP } from 'ping-react-native';
jest.mock('ping-react-native', () => ({
  ICMP: jest.fn(),
  ICMPStatus: { ECHO: 2, TIMEDOUT: 0 },
}));
const attempt = {
  id: 'durable',
  type: 'icmp_rtt',
  success: false,
  value: null,
  errorType: 'interrupted',
  unit: 'ms',
};
let callback, stop;
beforeEach(() => {
  jest.useFakeTimers();
  stop = jest.fn();
  ICMP.mockImplementation(() => ({
    ping: fn => {
      callback = fn;
    },
    stop,
  }));
});
afterEach(() => jest.useRealTimers());
test('stores native RTT separately from total adapter duration', async () => {
  const pending = runIcmp(
    attempt,
    'example.org',
    3000,
    new AbortController().signal,
  );
  callback({ status: 2, rtt: 12.5, ttl: 50, isEnded: true });
  expect(await pending).toMatchObject({
    id: 'durable',
    success: true,
    value: 12.5,
    ttl: 50,
    method: 'icmp_echo',
    targetHost: 'example.org',
    unit: 'ms',
  });
  expect(stop).toHaveBeenCalled();
});
test('cancellation stops the native runner and retains a failure record', async () => {
  const abort = new AbortController();
  const pending = runIcmp(attempt, 'example.org', 3000, abort.signal);
  abort.abort();
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
    value: null,
  });
  expect(stop).toHaveBeenCalled();
});
test('a missing native callback times out instead of hanging the scheduler', async () => {
  const pending = runIcmp(
    attempt,
    'example.org',
    1000,
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ success: false, errorType: 'timeout' });
});

test('preserves the callback and multiline native output without inventing ICMP headers', async () => {
  const pending = runIcmp(
    attempt,
    '192.0.2.1',
    1000,
    new AbortController().signal,
  );
  const native = {
    status: 2,
    rtt: 8,
    ttl: 52,
    isEnded: true,
    rawStdout: 'PING 192.0.2.1\n64 bytes: icmp_seq=1 ttl=52 time=8 ms\n\n',
    rawStderr: '',
  };
  callback(native);
  const result = await pending;
  expect(result.raw.callbacks[0].value).toEqual(native);
  expect(result.raw.request).toMatchObject({ ttl: 54, packetSize: 64 });
  expect(result.raw.callbacks[0].value.icmpType).toBeUndefined();
  callback({ status: 0, isEnded: true });
  expect(result.raw.callbacks).toHaveLength(1);
});

test('keeps negative native status and sentinel values on a failed probe', async () => {
  const pending = runIcmp(
    attempt,
    'bad.invalid',
    1000,
    new AbortController().signal,
  );
  const native = {
    status: -3,
    rtt: -1,
    ttl: -1,
    isEnded: true,
    rawStderr: 'unknown host\n',
  };
  callback(native);
  const result = await pending;
  expect(result.success).toBe(false);
  expect(result.raw.callbacks[0].value).toEqual(native);
});

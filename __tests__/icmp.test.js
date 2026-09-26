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

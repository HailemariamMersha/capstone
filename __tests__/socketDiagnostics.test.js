import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import TcpSocket from 'react-native-tcp-socket';
import UdpSocket from 'react-native-udp';
import { runTcpConnect } from '../src/measurements/tcp';
import { runUdpEcho } from '../src/measurements/udp';

jest.mock('react-native-tcp-socket', () => ({ Socket: jest.fn() }));
jest.mock('react-native-udp', () => ({ createSocket: jest.fn() }));
const attempt = {
  id: 'a'.repeat(32),
  success: false,
  value: null,
  errorType: 'interrupted',
  unit: 'ms',
};
let socket;
beforeEach(() => {
  jest.useFakeTimers();
  socket = Object.assign(new EventEmitter(), {
    destroy: jest.fn(),
    connect: jest.fn(),
    bind: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
  });
  TcpSocket.Socket.mockImplementation(() => socket);
  UdpSocket.createSocket.mockReturnValue(socket);
});
afterEach(() => jest.useRealTimers());

test('TCP connects to the HTTPS port without claiming TLS timing and ignores late errors', async () => {
  socket.connect.mockImplementation((_options, done) => setTimeout(done, 25));
  const pending = runTcpConnect(
    attempt,
    'https://example.org',
    1000,
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(25);
  expect(await pending).toMatchObject({
    success: true,
    value: 25,
    errorType: null,
    method: 'tcp_connect_with_resolution',
    details: { targetPort: 443 },
  });
  socket.emit('error', new Error('late'));
  expect(socket.destroy).toHaveBeenCalledTimes(1);
});

test('TCP cancellation destroys the socket and timeout preserves a failed attempt', async () => {
  const abort = new AbortController();
  const pending = runTcpConnect(
    attempt,
    'http://127.0.0.1:8000',
    1000,
    abort.signal,
  );
  abort.abort();
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
    value: null,
  });
  const timeout = runTcpConnect(
    attempt,
    'http://127.0.0.1:8000',
    1000,
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(1000);
  expect(await timeout).toMatchObject({ success: false, errorType: 'timeout' });
});

test('UDP counts only matching unique replies, detects duplicates and missing echoes', async () => {
  socket.bind.mockImplementation((_port, _address, done) => done());
  let count = 0;
  socket.send.mockImplementation(
    (packet, _offset, _length, port, address, done) => {
      done();
      count++;
      if (count <= 18) {
        setTimeout(() => {
          socket.emit('message', packet, { port: port + 1, address });
          socket.emit('message', Buffer.alloc(128), { port, address });
          socket.emit('message', packet, { port, address });
          socket.emit('message', packet, { port, address });
        }, 20);
      }
    },
  );
  const pending = runUdpEcho(
    attempt,
    '192.168.1.1',
    9876,
    1000,
    new AbortController().signal,
  );
  await jest.runAllTimersAsync();
  expect(await pending).toMatchObject({
    success: true,
    value: 20,
    details: {
      sentCount: 20,
      complete: true,
      duplicateCount: 18,
      lossPercent: 10,
      summary: { replies: 18 },
    },
  });
  expect(socket.close).toHaveBeenCalledTimes(1);
});

test('UDP cancellation never labels unsent packets as network loss', async () => {
  socket.bind.mockImplementation((_port, _address, done) => done());
  socket.send.mockImplementation(
    (_packet, _offset, _length, _port, _address, done) => done(),
  );
  const abort = new AbortController();
  const pending = runUdpEcho(attempt, '192.168.1.1', 9876, 1000, abort.signal);
  abort.abort();
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
    details: { sentCount: 1, complete: false, lossPercent: null },
  });
  await jest.runAllTimersAsync();
  expect(socket.send).toHaveBeenCalledTimes(1);
});

test('UDP bind silence cannot hang the scheduler', async () => {
  const pending = runUdpEcho(
    attempt,
    '192.168.1.1',
    9876,
    1000,
    new AbortController().signal,
  );
  await jest.runAllTimersAsync();
  expect(await pending).toMatchObject({
    errorType: 'timeout',
    details: { lossPercent: null, sentCount: 0 },
  });
});

test('UDP retains matching payloads and explicitly bounds duplicate observations', async () => {
  socket.bind.mockImplementation((_p, _a, done) => done());
  socket.send.mockImplementation((packet, _o, _l, port, address, done) => {
    done();
    for (let i = 0; i < 300; i++)
      socket.emit('message', packet, { address, port });
  });
  const abort = new AbortController();
  const pending = runUdpEcho(attempt, '192.0.2.1', 9876, 1000, abort.signal);
  abort.abort();
  const result = await pending;
  expect(result.raw.callbacks).toHaveLength(256);
  expect(result.raw.droppedCallbacks).toBeGreaterThan(0);
  const sent = result.raw.callbacks.find(
    c => c.value.event === 'send_requested',
  ).value;
  const received = result.raw.callbacks.find(
    c => c.value.event === 'matched_reply',
  ).value;
  expect(received.payloadBase64).toBe(sent.payloadBase64);
  expect(received.remote).toEqual({ address: '192.0.2.1', port: 9876 });
});

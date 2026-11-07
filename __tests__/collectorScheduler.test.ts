import {
  advance,
  takeDue,
  resetProbes,
  transferTimeout,
} from '../src/trips/scheduler';
import { deadline } from '../src/services/deadline';

test('minute deadlines keep their phase with a one-second dispatch tolerance', () => {
  let due = 60000;
  for (const now of [59300, 120200, 179999, 240800]) {
    const slot = takeDue(due, now, 60000)!;
    expect(slot.skipped).toBe(0);
    expect(slot.scheduledAt % 60000).toBe(0);
    due = slot.next;
  }
  expect(due).toBe(300000);
  expect(takeDue(due, 298000, 60000)).toBeNull();
});
test('missed slots advance once, count skips and restart staggered after a gap', () => {
  expect(takeDue(60000, 215000, 60000)).toEqual({
    scheduledAt: 180000,
    next: 240000,
    skipped: 2,
  });
  expect(advance(900000, 7200000, 900000)).toBe(8100000);
  const due = resetProbes(7200000);
  expect(new Set(Object.values(due)).size).toBe(4);
  expect(Object.values(due).every(at => at > 7200000)).toBe(true);
});
test('transfer deadlines scale with payload without exceeding the bounded policy', () => {
  expect(transferTimeout(1000000)).toBe(30000);
  expect(transferTimeout(5000000)).toBe(90000);
  expect(transferTimeout(100000000)).toBe(90000);
});
test('a supplied cancellation signal does not disable the request timeout', async () => {
  jest.useFakeTimers();
  const parent = new AbortController();
  const request = deadline(100, parent.signal);
  await jest.advanceTimersByTimeAsync(100);
  expect(parent.signal.aborted).toBe(false);
  expect(request.signal.aborted).toBe(true);
  expect(request.timedOut()).toBe(true);
  request.dispose();
  const second = deadline(10000, parent.signal);
  parent.abort();
  expect(second.signal.aborted).toBe(true);
  expect(second.timedOut()).toBe(false);
  second.dispose();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

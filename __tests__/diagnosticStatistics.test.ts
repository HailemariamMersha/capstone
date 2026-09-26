import { latencySummary } from '../src/measurements/statistics';
import { runIcmpBurst } from '../src/measurements/icmpBurst';
import type { Measurement } from '../src/measurements/types';
jest.mock('../src/measurements/icmp', () => ({ runIcmp: jest.fn() }));

test('uses nearest-rank p95 and never bridges missing samples for RTT variation', () => {
  const samples = [10, 20, null, 50, 70].map((rttMs, sequence) => ({
    rttMs,
    sequence,
    timestamp: '',
    errorType: null,
  }));
  expect(latencySummary(samples)).toEqual({
    replies: 4,
    medianMs: 35,
    p95Ms: 70,
    successiveDifferenceMs: 15,
  });
  expect(latencySummary([]).medianMs).toBeNull();
});

test('a complete burst retains failures and computes ICMP non-response', async () => {
  jest.useFakeTimers();
  try {
    let calls = 0;
    const probe = jest.fn(async (attempt: Measurement) => ({
      ...attempt,
      value: ++calls <= 8 ? calls : null,
      errorType: calls <= 8 ? null : ('timeout' as const),
    }));
    const pending = runIcmpBurst(
      {} as Measurement,
      'example.org',
      3000,
      new AbortController().signal,
      probe,
    );
    await jest.runAllTimersAsync();
    expect(await pending).toMatchObject({
      success: true,
      value: 4.5,
      details: {
        complete: true,
        nonResponsePercent: 20,
        summary: { replies: 8 },
      },
    });
    expect(probe).toHaveBeenCalledTimes(10);
  } finally {
    jest.useRealTimers();
  }
});

test('cancelling between samples retains partial data without reporting packet loss', async () => {
  const abort = new AbortController();
  const probe = jest.fn(async (attempt: Measurement) => {
    abort.abort();
    return { ...attempt, value: 12, errorType: null };
  });
  const result = await runIcmpBurst(
    {} as Measurement,
    'example.org',
    3000,
    abort.signal,
    probe,
  );
  expect(result).toMatchObject({
    success: false,
    value: null,
    errorType: 'cancelled',
    details: {
      complete: false,
      nonResponsePercent: null,
      summary: { replies: 1 },
    },
  });
});

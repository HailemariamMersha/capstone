import { ICMP, ICMPStatus } from 'ping-react-native';
import type { Measurement, RawProbeOutput } from './types';

/** A single native ICMP sample; duration includes adapter work, value is native RTT. */
export async function runIcmp(
  attempt: Measurement,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Measurement> {
  const started = performance.now();
  const raw: RawProbeOutput = {
    library: 'ping-react-native',
    version: '2.1.1',
    source: 'library_callback_with_optional_android_ping_text',
    request: {
      host,
      count: 1,
      packetSize: 64,
      ttl: 54,
      timeoutMs: Math.min(timeoutMs, 10000),
    },
    callbacks: [],
    unavailable: ['packetCapture', 'icmpHeader', 'kernelSendReceiveTimestamps'],
  };
  const ping = new ICMP({
    host,
    count: 1,
    packetSize: 64,
    timeout: Math.min(timeoutMs, 10000),
  });
  return new Promise(resolve => {
    let finished = false;
    const finish = (patch: Partial<Measurement>) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      try {
        ping.stop();
      } catch {
        /* Native cleanup may fail after process teardown. */
      }
      resolve({
        ...attempt,
        method: 'icmp_echo',
        targetHost: host,
        ttl: null,
        raw,
        ...patch,
        durationMs: performance.now() - started,
      });
    };
    const cancel = () =>
      finish({ errorType: 'cancelled', errorMessage: 'ICMP probe cancelled.' });
    const timer = setTimeout(
      () =>
        finish({
          errorType: 'timeout',
          errorMessage:
            'ICMP reply deadline exceeded; this does not prove an internet outage.',
        }),
      Math.min(timeoutMs, 10000) + 1000,
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      ping.ping(result => {
        if (finished) {
          return;
        }
        raw.callbacks.push({
          observedAt: new Date().toISOString(),
          elapsedMs: performance.now() - started,
          value: { ...result },
        });
        if (
          result.status === ICMPStatus.ECHO &&
          Number.isFinite(result.rtt) &&
          result.rtt >= 0
        ) {
          finish({
            success: true,
            value: result.rtt,
            errorType: null,
            errorMessage: null,
            transferredBytes: 64,
            ttl: result.ttl,
          });
        } else if (result.status === ICMPStatus.TIMEDOUT) {
          finish({ errorType: 'timeout', errorMessage: 'No ICMP echo reply.' });
        } else if (result.isEnded || result.status < 0) {
          finish({
            errorType: 'network',
            errorMessage: `ICMP failed (native status ${result.status}).`,
          });
        }
      });
    } catch (error) {
      finish({
        errorType: 'network',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

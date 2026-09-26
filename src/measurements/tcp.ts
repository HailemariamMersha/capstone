import TcpSocket from 'react-native-tcp-socket';
import { latencySummary } from './statistics';
import type { Measurement, ProbeErrorType, ProbeSample } from './types';

/** Includes resolver/native dispatch/callback time; does not isolate a TCP SYN RTT or TLS. */
export async function runTcpConnect(
  attempt: Measurement,
  serverUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Measurement> {
  const url = new URL(serverUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const started = performance.now();
  const timestamp = new Date().toISOString();
  return new Promise(resolve => {
    let socket: InstanceType<typeof TcpSocket.Socket> | undefined;
    let finished = false;
    const finish = (
      errorType: ProbeErrorType | null,
      errorMessage: string | null,
    ) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      const durationMs = performance.now() - started;
      try {
        socket?.destroy();
      } catch {
        /* Already closed by the native module. */
      }
      const samples: ProbeSample[] = [
        {
          sequence: 0,
          timestamp,
          rttMs: errorType ? null : durationMs,
          errorType,
        },
      ];
      resolve({
        ...attempt,
        timestamp,
        method: 'tcp_connect_with_resolution',
        targetHost: host,
        durationMs,
        value: errorType ? null : durationMs,
        success: !errorType,
        errorType,
        errorMessage,
        transferredBytes: 0,
        details: {
          protocolVersion: 1,
          samples,
          summary: latencySummary(samples),
          targetPort: port,
        },
      });
    };
    const cancel = () => finish('cancelled', 'TCP connection cancelled.');
    const timer = setTimeout(
      () => finish('timeout', 'TCP connection deadline exceeded.'),
      timeoutMs,
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      socket = new TcpSocket.Socket();
      socket.on('error', error => finish('network', String(error)));
      socket.on('close', () =>
        finish('network', 'TCP socket closed before connecting.'),
      );
      socket.connect({ host, port, connectTimeout: timeoutMs }, () =>
        finish(null, null),
      );
    } catch (error) {
      finish('network', String(error));
    }
  });
}

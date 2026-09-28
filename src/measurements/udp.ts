import UdpSocket from 'react-native-udp';
import { Buffer } from 'buffer';
import {
  UDP_PACKET_BYTES,
  UDP_SAMPLE_COUNT,
  SAMPLE_INTERVAL_MS,
} from './diagnosticConfig';
import { latencySummary } from './statistics';
import type {
  Measurement,
  ProbeErrorType,
  ProbeSample,
  RawProbeOutput,
} from './types';

export function udpPacket(nonce: string, sequence: number): Buffer {
  return Buffer.from(
    `CPSUDP1:${nonce}:${String(sequence).padStart(4, '0')}:`.padEnd(
      UDP_PACKET_BYTES,
      '.',
    ),
    'ascii',
  );
}

type EchoSocket = ReturnType<typeof UdpSocket.createSocket> & {
  on(event: 'error', listener: (error: unknown) => void): void;
  on(
    event: 'message',
    listener: (
      message: Buffer,
      remote: { address: string; port: number },
    ) => void,
  ): void;
};

/** IPv4, fixed 128-byte correlated echoes; no raw socket or traceroute claims. */
export async function runUdpEcho(
  attempt: Measurement,
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Measurement> {
  const started = performance.now();
  const timestamp = new Date().toISOString();
  // Correlation only, not an authentication credential. Durable IDs are random 128-bit hex.
  const nonce = attempt.id
    .replace(/[^a-f0-9]/g, '')
    .slice(-32)
    .padStart(32, '0');
  const graceMs = Math.min(timeoutMs, 3000);
  const raw: RawProbeOutput = {
    library: 'react-native-udp',
    version: '4.1.7',
    source: 'udp_socket_callbacks',
    request: {
      host,
      port,
      packetSize: UDP_PACKET_BYTES,
      count: UDP_SAMPLE_COUNT,
      graceMs,
      nonce,
    },
    callbacks: [],
    droppedCallbacks: 0,
    unavailable: ['ipHeader', 'icmpHeader', 'kernelSendReceiveTimestamps'],
  };
  const observe = (value: unknown) => {
    // Duplicate/unrelated datagrams must not grow storage without bound.
    if (raw.callbacks.length >= 256) {
      raw.droppedCallbacks!++;
      return;
    }
    raw.callbacks.push({
      observedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      value,
    });
  };
  return new Promise(resolve => {
    let socket: EchoSocket | undefined;
    let finished = false;
    let sentCount = 0;
    let duplicateCount = 0;
    let reorderedCount = 0;
    let highestReply = -1;
    let nextSequence = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const sent = new Map<
      number,
      { at: number; timestamp: string; confirmed: boolean }
    >();
    const replies = new Map<number, number>();
    const finish = (
      errorType: ProbeErrorType | null,
      errorMessage: string | null,
    ) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(deadline);
      if (sendTimer !== undefined) {
        clearTimeout(sendTimer);
      }
      if (finalTimer !== undefined) {
        clearTimeout(finalTimer);
      }
      signal.removeEventListener('abort', cancel);
      try {
        socket?.close();
      } catch {
        /* Socket may not have bound successfully. */
      }
      const samples: ProbeSample[] = [...sent].map(([sequence, info]) => ({
        sequence,
        timestamp: info.timestamp,
        rttMs: replies.get(sequence) ?? null,
        errorType: replies.has(sequence) ? null : errorType ?? 'timeout',
      }));
      const summary = latencySummary(samples);
      const complete = errorType === null && sentCount === UDP_SAMPLE_COUNT;
      const success = complete && summary.replies > 0;
      resolve({
        ...attempt,
        timestamp,
        targetHost: host,
        method: 'udp_echo_round_trip',
        raw,
        durationMs: performance.now() - started,
        success,
        value: success ? summary.medianMs : null,
        errorType: errorType ?? (success ? null : 'timeout'),
        errorMessage:
          errorMessage ??
          (success
            ? null
            : 'No UDP replies; filtering and an unavailable server can also cause this.'),
        transferredBytes: null,
        details: {
          protocolVersion: 1,
          samples,
          summary,
          requestedCount: UDP_SAMPLE_COUNT,
          sentCount,
          complete,
          duplicateCount,
          reorderedCount,
          targetPort: port,
          lossPercent: complete
            ? (100 * (sentCount - replies.size)) / sentCount
            : null,
        },
      });
    };
    const cancel = () => finish('cancelled', 'UDP burst cancelled.');
    // Covers a missing bind or send callback as well as all packet deadlines.
    const deadline = setTimeout(
      () => finish('timeout', 'UDP burst deadline exceeded.'),
      graceMs * 2 + UDP_SAMPLE_COUNT * SAMPLE_INTERVAL_MS + 1000,
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) {
      cancel();
      return;
    }
    const send = () => {
      if (finished || !socket) {
        return;
      }
      const sequence = nextSequence++;
      const packet = udpPacket(nonce, sequence);
      observe({
        event: 'send_requested',
        sequence,
        payloadBase64: packet.toString('base64'),
        payloadBytes: packet.length,
        host,
        port,
      });
      sent.set(sequence, {
        at: performance.now(),
        timestamp: new Date().toISOString(),
        confirmed: false,
      });
      try {
        socket.send(packet, 0, packet.length, port, host, error => {
          if (finished) {
            return;
          }
          if (error) {
            observe({ event: 'send_error', sequence, error: String(error) });
            finish('network', String(error));
            return;
          }
          sent.get(sequence)!.confirmed = true;
          observe({ event: 'send_confirmed', sequence });
          sentCount++;
          if (nextSequence < UDP_SAMPLE_COUNT) {
            sendTimer = setTimeout(send, SAMPLE_INTERVAL_MS);
          } else {
            finalTimer = setTimeout(() => finish(null, null), graceMs);
            if (replies.size === UDP_SAMPLE_COUNT) {
              finish(null, null);
            }
          }
        });
      } catch (error) {
        finish('network', String(error));
      }
    };
    try {
      socket = UdpSocket.createSocket({ type: 'udp4' }) as EchoSocket;
      socket.on('error', error => {
        observe({ event: 'socket_error', error: String(error) });
        finish('network', String(error));
      });
      socket.on(
        'message',
        (message: Buffer, remote: { address: string; port: number }) => {
          if (finished) return;
          if (
            finished ||
            remote.address !== host ||
            remote.port !== port ||
            message.length !== UDP_PACKET_BYTES
          ) {
            return;
          }
          const text = message.toString('ascii');
          const sequence = Number(text.slice(41, 45));
          const info = sent.get(sequence);
          if (!info || !message.equals(udpPacket(nonce, sequence))) {
            return;
          }
          observe({
            event: 'matched_reply',
            sequence,
            remote: { ...remote },
            payloadBase64: message.toString('base64'),
            payloadBytes: message.length,
            duplicate: replies.has(sequence),
            reordered: sequence < highestReply,
          });
          if (replies.has(sequence)) {
            duplicateCount++;
            return;
          }
          if (sequence < highestReply) {
            reorderedCount++;
          }
          highestReply = Math.max(highestReply, sequence);
          replies.set(sequence, performance.now() - info.at);
          if (
            replies.size === UDP_SAMPLE_COUNT &&
            sentCount === UDP_SAMPLE_COUNT
          ) {
            finish(null, null);
          }
        },
      );
      socket.bind(0, '0.0.0.0', send);
    } catch (error) {
      finish('network', String(error));
    }
  });
}

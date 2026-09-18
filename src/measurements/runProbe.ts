import {
  PROBE_API_PATH,
  PROBE_PROTOCOL_HEADER,
  PROBE_PROTOCOL_VERSION,
} from '../api/probeProtocol';
import { prototypeId, validateProbeConfig } from './config';
import type {
  Measurement,
  ProbeConfig,
  ProbeErrorType,
  ProbeType,
} from './types';

class ProbeFailure extends Error {
  constructor(readonly kind: ProbeErrorType, message: string) {
    super(message);
  }
}
export interface ProbeDependencies {
  fetch: typeof fetch;
  now: () => number;
  timestamp: () => string;
}
const defaults: ProbeDependencies = {
  fetch: (...args) => fetch(...args),
  now: () => performance.now(),
  timestamp: () => new Date().toISOString(),
};

// ASCII gives a known UTF-8 byte count; prepare outside the measured interval.
function uploadPayload(size: number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const blocks: string[] = [];
  for (let offset = 0; offset < size; offset += 8192) {
    let block = '';
    for (let i = 0; i < Math.min(8192, size - offset); i++) {
      block += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    blocks.push(block);
  }
  return blocks.join('');
}

/** A complete application-level exchange, including response body consumption. */
export async function runProbe(
  type: ProbeType,
  input: ProbeConfig,
  sessionId: string,
  signal?: AbortSignal,
  dependencies: ProbeDependencies = defaults,
): Promise<Measurement> {
  const base: Measurement = {
    id: prototypeId('measurement'),
    sessionId,
    timestamp: dependencies.timestamp(),
    type,
    durationMs: 0,
    value: null,
    unit: type === 'http_rtt' ? 'ms' : 'Mbps',
    success: false,
    errorType: null,
    errorMessage: null,
    httpStatus: null,
    requestedBytes:
      type === 'download'
        ? input.downloadBytes
        : type === 'upload'
        ? input.uploadBytes
        : 4,
    transferredBytes: null,
    probeServer: input.serverUrl,
    probeRegion: null,
    networkSnapshot: null,
  };
  let config: ProbeConfig;
  try {
    config = validateProbeConfig(input);
  } catch (error) {
    return {
      ...base,
      errorType: 'invalid_config',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  base.probeServer = config.serverUrl;
  if (signal?.aborted) {
    return {
      ...base,
      errorType: 'cancelled',
      errorMessage: 'Probe cancelled.',
    };
  }
  const body =
    type === 'upload' ? uploadPayload(config.uploadBytes) : undefined;
  const path =
    type === 'http_rtt'
      ? '/ping'
      : type === 'download'
      ? `/download/${config.downloadBytes}`
      : '/upload';
  const controller = new AbortController();
  const started = dependencies.now();
  base.timestamp = dependencies.timestamp();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const interruption = new Promise<never>((_, reject) => {
    const interrupt = (kind: 'timeout' | 'cancelled') => {
      reject(
        new ProbeFailure(
          kind,
          kind === 'timeout'
            ? `Probe exceeded ${config.timeoutMs} ms.`
            : 'Probe cancelled.',
        ),
      );
      controller.abort();
    };
    abort = () => interrupt('cancelled');
    signal?.addEventListener('abort', abort);
    timer = setTimeout(() => interrupt('timeout'), config.timeoutMs);
  });

  const request = async (): Promise<number> => {
    const response = await dependencies.fetch(
      `${config.serverUrl}${PROBE_API_PATH}${path}?request=${base.id}`,
      {
        method: type === 'upload' ? 'POST' : 'GET',
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
          ...(type === 'upload'
            ? { 'Content-Type': 'application/octet-stream' }
            : {}),
        },
        ...(body === undefined ? {} : { body }),
      },
    );
    base.httpStatus = response.status;
    if (!response.ok) {
      throw new ProbeFailure(
        'http',
        `Probe server returned HTTP ${response.status}.`,
      );
    }
    if (
      response.headers.get(PROBE_PROTOCOL_HEADER) !== PROBE_PROTOCOL_VERSION
    ) {
      throw new ProbeFailure(
        'invalid_response',
        'Response is not from the expected probe server (possible captive portal).',
      );
    }
    const encoding = response.headers.get('Content-Encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      throw new ProbeFailure(
        'invalid_response',
        'Compressed responses are not valid throughput payloads.',
      );
    }
    base.probeRegion = response.headers.get('X-Probe-Region');
    if (type === 'http_rtt') {
      if ((await response.text()) !== 'pong') {
        throw new ProbeFailure(
          'invalid_response',
          'Unexpected RTT response body.',
        );
      }
      return 4;
    }
    if (type === 'download') {
      const bytes = (await response.arrayBuffer()).byteLength;
      if (bytes !== config.downloadBytes) {
        throw new ProbeFailure(
          'invalid_response',
          `Expected ${config.downloadBytes} download bytes, received ${bytes}.`,
        );
      }
      return bytes;
    }
    let ack: unknown;
    try {
      ack = await response.json();
    } catch {
      throw new ProbeFailure(
        'invalid_response',
        'Invalid upload acknowledgement.',
      );
    }
    if (
      !ack ||
      typeof ack !== 'object' ||
      !('receivedBytes' in ack) ||
      ack.receivedBytes !== config.uploadBytes
    ) {
      throw new ProbeFailure(
        'invalid_response',
        'Server did not acknowledge the complete upload.',
      );
    }
    return config.uploadBytes;
  };
  try {
    const bytes = await Promise.race([request(), interruption]);
    const durationMs = Math.max(0, dependencies.now() - started);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ProbeFailure(
        'invalid_response',
        'Elapsed time is too short to measure.',
      );
    }
    return {
      ...base,
      durationMs,
      transferredBytes: bytes,
      success: true,
      value:
        type === 'http_rtt' ? durationMs : (bytes * 8) / (durationMs * 1000),
    };
  } catch (error) {
    return {
      ...base,
      durationMs: Math.max(0, dependencies.now() - started),
      errorType: error instanceof ProbeFailure ? error.kind : 'network',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', abort);
  }
}

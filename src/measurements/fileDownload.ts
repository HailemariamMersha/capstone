import type * as FileSystem from '@dr.pogodin/react-native-fs';
import {
  PROBE_API_PATH,
  PROBE_PROTOCOL_HEADER,
  PROBE_PROTOCOL_VERSION,
} from '../api/probeProtocol';
import type { Measurement, ProbeConfig, ProbeErrorType } from './types';

type DownloadFileSystem = Pick<
  typeof FileSystem,
  'CachesDirectoryPath' | 'downloadFile' | 'stopDownload' | 'unlink'
>;
const header = (headers: Record<string, string> | undefined, name: string) =>
  Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

/** Large downloads stay in native file buffers, avoiding RN's full-body base64 copies. */
export async function runFileDownload(
  attempt: Measurement,
  config: ProbeConfig,
  signal: AbortSignal | undefined,
  clock: { now: () => number; timestamp: () => string },
  fs: DownloadFileSystem = require('@dr.pogodin/react-native-fs'),
): Promise<Measurement> {
  const result: Measurement = {
    ...attempt,
    method: 'http_download_to_file',
    timestamp: clock.timestamp(),
  };
  // The scheduler serializes downloads. A stable path also bounds leftovers after process loss.
  const path = `${fs.CachesDirectoryPath}/capstone-probe-download.bin`;
  let jobId: number | undefined;
  let failure: { kind: ProbeErrorType; message: string } | undefined;
  const stop = (kind: ProbeErrorType, message: string) => {
    failure ??= { kind, message };
    if (jobId !== undefined) fs.stopDownload(jobId);
  };
  const cancel = () => stop('cancelled', 'Download cancelled.');
  const started = clock.now();
  const timer = setTimeout(
    () => stop('timeout', `Probe exceeded ${config.timeoutMs} ms.`),
    config.timeoutMs,
  );
  signal?.addEventListener('abort', cancel);
  try {
    if (signal?.aborted) {
      cancel();
      throw new Error('Download cancelled.');
    }
    const task = fs.downloadFile({
      fromUrl: `${config.serverUrl}${PROBE_API_PATH}/download/${config.downloadBytes}?request=${attempt.id}`,
      toFile: path,
      headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
      cacheable: false,
      connectionTimeout: Math.min(config.timeoutMs, 10000),
      readTimeout: Math.min(config.timeoutMs, 10000),
      progressInterval: 250,
      begin: response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          stop('http', `Probe server returned HTTP ${response.statusCode}.`);
        } else if (
          header(response.headers, PROBE_PROTOCOL_HEADER) !==
          PROBE_PROTOCOL_VERSION
        ) {
          stop(
            'invalid_response',
            'Response is not from the expected probe server.',
          );
        } else if (
          header(response.headers, 'Content-Encoding') &&
          header(response.headers, 'Content-Encoding')?.toLowerCase() !==
            'identity'
        ) {
          stop(
            'invalid_response',
            'Compressed responses are not valid throughput payloads.',
          );
        } else if (response.contentLength !== config.downloadBytes) {
          stop(
            'invalid_response',
            'Server declared an unexpected download size.',
          );
        }
      },
      progress: response => {
        if (response.bytesWritten > config.downloadBytes)
          stop('invalid_response', 'Download exceeded its requested size.');
      },
    });
    jobId = task.jobId;
    if (failure || signal?.aborted) cancel();
    // Wait for the native worker to settle before deleting its file or starting another probe.
    const response = await task.promise;
    result.httpStatus = response.statusCode;
    result.probeRegion = header(response.headers, 'X-Probe-Region') ?? null;
    result.durationMs = clock.now() - started;
    if (failure) throw new Error(failure.message);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      failure = {
        kind: 'http',
        message: `Probe server returned HTTP ${response.statusCode}.`,
      };
      throw new Error(failure.message);
    }
    const encoding = header(response.headers, 'Content-Encoding');
    if (
      header(response.headers, PROBE_PROTOCOL_HEADER) !==
        PROBE_PROTOCOL_VERSION ||
      (encoding && encoding.toLowerCase() !== 'identity') ||
      response.bytesWritten !== config.downloadBytes ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs <= 0
    ) {
      failure = {
        kind: 'invalid_response',
        message: 'Download headers, byte count or elapsed time were invalid.',
      };
      throw new Error(failure.message);
    }
    return {
      ...result,
      success: true,
      errorType: null,
      errorMessage: null,
      transferredBytes: response.bytesWritten,
      value: (response.bytesWritten * 8) / (result.durationMs * 1000),
    };
  } catch (error) {
    return {
      ...result,
      success: false,
      value: null,
      transferredBytes: null,
      durationMs: Math.max(0, clock.now() - started),
      errorType: failure?.kind ?? 'network',
      errorMessage:
        failure?.message ??
        (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await fs.unlink(path).catch(() => {});
  }
}

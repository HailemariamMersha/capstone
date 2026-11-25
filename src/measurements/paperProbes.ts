import { NativeModules } from 'react-native';
import type { Measurement, ProbeErrorType } from './types';
import { runTraceroute } from './traceroute';
import type { MeasurementConfig } from '../sessions/types';
import {
  PAPER_REGISTRY,
  PAPER_SUITE_VERSION,
  PAPER_CDN_LIMIT,
  PAPER_DNS_LIMIT,
  type PaperJob,
} from './paperSuite';

interface PaperResponse {
  runId: string;
  apiLevel?: number;
  reason: string;
  bodyBytes?: number | null;
  bodyBytesKnown?: boolean;
  requestSent?: boolean;
  bodyComplete?: boolean;
  contentMatches?: boolean;
  byteLimit?: number;
  totalMs?: number;
  dnsLookupMs?: number;
  tcpConnectMs?: number;
  tlsHandshakeMs?: number;
  responseHeadersAfterMs?: number;
  bodyReadMs?: number;
  sha256?: string;
  remoteAddress?: string;
  httpVersion?: string;
  httpStatus?: number;
  headers?: Record<string, string>;
  callbacks?: {
    event: string;
    elapsedNs: string;
    elapsedMs: number;
    wallTimeMs?: number;
  }[];
  droppedCallbacks?: number;
  configuredDnsServers?: string[];
  observedResolverIp?: string | null;
  resolverStatus?: string | null;
  resolverUnavailableReason?: string | null;
  resolverResponse?: Record<string, unknown>;
  privateDnsActive?: boolean | null;
  address?: string;
  resolutionMs?: number;
}
export interface PaperAdapter {
  run(
    id: string,
    kind: string,
    target: string,
    nonce: string,
    handle: string,
  ): Promise<string>;
  resolve(id: string, host: string, handle: string): Promise<string>;
  cancel(id: string): void;
}
const number = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const ipv4 = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.split('.').length === 4 &&
  s
    .split('.')
    .every(x => /^\d+$/.test(x) && Number(x) <= 255 && String(Number(x)) === x);
function parse(text: string, id: string): PaperResponse {
  if (typeof text !== 'string' || text.length > 131072)
    throw new Error('Invalid library response');
  const result = JSON.parse(text);
  if (
    result?.runId !== id ||
    typeof result.reason !== 'string' ||
    (result.callbacks != null &&
      (!Array.isArray(result.callbacks) ||
        result.callbacks.length > 100 ||
        result.callbacks.some(
          (c: any) =>
            typeof c.event !== 'string' ||
            typeof c.elapsedNs !== 'string' ||
            !/^\d+$/.test(c.elapsedNs) ||
            number(c.elapsedMs) == null ||
            (c.wallTimeMs != null &&
              (!Number.isSafeInteger(c.wallTimeMs) || c.wallTimeMs < 0)),
        )))
  )
    throw new Error('Invalid library response');
  for (const key of [
    'bodyBytes',
    'totalMs',
    'dnsLookupMs',
    'tcpConnectMs',
    'tlsHandshakeMs',
    'responseHeadersAfterMs',
    'bodyReadMs',
  ])
    if (result[key] != null && number(result[key]) == null)
      throw new Error('Invalid library counter');
  return result;
}
export function paperCharge(result: Measurement | undefined, limit: number) {
  const wire = result?.raw?.callbacks.at(-1)?.value as
    | PaperResponse
    | undefined;
  if (wire?.bodyBytesKnown && number(wire.bodyBytes) != null)
    return Math.min(limit, wire.bodyBytes!);
  if (wire?.requestSent === false) return 0;
  return limit;
}
function errorType(reason: string): ProbeErrorType | null {
  if (reason === 'complete') return null;
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'http' || reason === 'http_redirect') return 'http';
  if (['unexpected_content', 'byte_limit', 'invalid_response'].includes(reason))
    return 'invalid_response';
  return 'network';
}
export async function runPaperProbe(
  attempt: Measurement,
  config: MeasurementConfig,
  job: PaperJob,
  handle: string,
  signal: AbortSignal,
  adapter: PaperAdapter | undefined = NativeModules.CapstonePaperProbes,
): Promise<Measurement> {
  const start = performance.now();
  const trace = PAPER_REGISTRY.traces.find(t => t.id === job.targetId);
  const cdn = PAPER_REGISTRY.cdns.find(t => t.id === job.targetId);
  let result: PaperResponse = {
    runId: attempt.id,
    reason: 'unsupported',
    requestSent: false,
  };
  const abort = () => adapter?.cancel(attempt.id);
  signal.addEventListener('abort', abort);
  try {
    if (signal.aborted) result.reason = 'cancelled';
    else if (adapter && job.type === 'traceroute' && trace) {
      let address = trace.host as string;
      let resolutionMs: number | null = null;
      if (trace.mode === 'hostname') {
        result = parse(
          await adapter.resolve(attempt.id, trace.host, handle),
          attempt.id,
        );
        if (result.reason !== 'complete' || !ipv4(result.address))
          throw new Error('Hostname resolution unavailable');
        address = result.address;
        resolutionMs = number(result.resolutionMs);
      }
      if (signal.aborted) throw new Error('Cancelled');
      const measured = await runTraceroute(
        attempt,
        { ...config, tracerouteHost: address, tracerouteMaxHops: 20 },
        signal,
      );
      return {
        ...measured,
        targetHost: trace.host,
        targetId: job.targetId,
        targetMode: trace.mode,
        resolvedAddress: address,
        resolutionMs,
        roundId: job.roundId,
        durationMs: performance.now() - start,
      };
    } else if (adapter && job.type !== 'traceroute') {
      const bytes = new Uint8Array(16);
      (
        globalThis as unknown as {
          crypto: { getRandomValues(b: Uint8Array): Uint8Array };
        }
      ).crypto.getRandomValues(bytes);
      const nonce = Array.from(bytes, b =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      result = parse(
        await adapter.run(attempt.id, job.type, job.targetId, nonce, handle),
        attempt.id,
      );
    }
  } catch {
    result = {
      ...result,
      reason: signal.aborted
        ? 'cancelled'
        : result.reason === 'complete'
        ? 'resolution_failed'
        : result.reason === 'unsupported'
        ? 'network'
        : result.reason,
    };
  } finally {
    signal.removeEventListener('abort', abort);
  }
  const headers = result.headers ?? {};
  const edgeCodes = [
    ...new Set(
      [
        headers['cf-ray']?.match(/-([A-Z]{3})$/)?.[1],
        ...((headers['x-served-by'] ?? '').match(/\b[A-Z]{3}\b/g) ?? []),
      ].filter((s): s is string => !!s),
    ),
  ];
  const durationMs = number(result.totalMs) ?? performance.now() - start;
  const success = result.reason === 'complete';
  return {
    ...attempt,
    type: job.type,
    targetId: job.targetId,
    targetHost: trace?.host ?? cdn?.url ?? PAPER_REGISTRY.resolverDomain,
    targetMode: trace?.mode ?? 'hostname',
    resolvedAddress: result.remoteAddress ?? result.address ?? null,
    resolutionMs: number(result.resolutionMs),
    roundId: job.roundId,
    durationMs,
    value: job.type === 'cdn_fetch' && success ? durationMs : null,
    unit: job.type === 'traceroute' ? 'hops' : 'ms',
    success,
    errorType: errorType(result.reason),
    errorMessage: success ? null : `Paper probe: ${result.reason}`,
    httpStatus: result.httpStatus ?? null,
    requestedBytes: null,
    transferredBytes: result.bodyBytesKnown ? result.bodyBytes ?? 0 : null,
    method:
      job.type === 'traceroute'
        ? 'selected_wifi_resolution'
        : 'okhttp_event_listener',
    paper:
      job.type === 'traceroute'
        ? undefined
        : {
            suiteVersion: PAPER_SUITE_VERSION,
            provider: cdn?.id,
            url: cdn?.url,
            bodyBytes: result.bodyBytesKnown ? result.bodyBytes ?? 0 : null,
            byteLimit:
              job.type === 'cdn_fetch' ? PAPER_CDN_LIMIT : PAPER_DNS_LIMIT,
            bodyComplete: result.bodyComplete === true,
            contentMatches: result.contentMatches ?? null,
            sha256: result.sha256 ?? null,
            dnsLookupMs: number(result.dnsLookupMs),
            tcpConnectMs: number(result.tcpConnectMs),
            tlsHandshakeMs: number(result.tlsHandshakeMs),
            responseHeadersAfterMs: number(result.responseHeadersAfterMs),
            bodyReadMs: number(result.bodyReadMs),
            totalMs: durationMs,
            remoteAddress: result.remoteAddress ?? null,
            httpVersion: result.httpVersion ?? null,
            headers,
            edgeCodes,
            ...(job.type === 'dns_resolver'
              ? {
                  configuredDnsServers: result.configuredDnsServers,
                  observedResolverIp: result.observedResolverIp ?? null,
                  resolverStatus: result.resolverStatus ?? null,
                  resolverUnavailableReason:
                    result.resolverUnavailableReason ??
                    'endpoint_did_not_report_resolver_ip',
                  privateDnsActive: result.privateDnsActive ?? null,
                }
              : {}),
          },
    raw: {
      library: job.type === 'traceroute' ? 'android.net.Network' : 'okhttp',
      version:
        job.type === 'traceroute'
          ? result.apiLevel == null
            ? 'unrecorded'
            : `API ${result.apiLevel}`
          : '4.12.0',
      source: 'selected_wifi_android_adapter',
      request: {
        suite: PAPER_SUITE_VERSION,
        targetId: job.targetId,
        requestedTarget:
          trace?.host ?? cdn?.url ?? PAPER_REGISTRY.resolverDomain,
        timeoutMs: job.timeoutMs,
        addressFamily: 'IPv4',
        ...(job.type === 'traceroute'
          ? {}
          : { httpVersion: 'HTTP/1.1', connectionReused: false }),
        dnsCacheState: 'unknown',
      },
      callbacks: [
        ...(result.callbacks ?? []).map(c => ({
          observedAt: new Date(c.wallTimeMs ?? Date.now()).toISOString(),
          elapsedMs: c.elapsedMs,
          value: c,
        })),
        {
          observedAt: new Date().toISOString(),
          elapsedMs: durationMs,
          value: { ...result, callbacks: undefined },
        },
      ],
      droppedCallbacks: result.droppedCallbacks ?? 0,
      unavailable: [
        'kernelTimestamps',
        'wireBytes',
        'dnsCacheState',
        'verifiedEdgeLocation',
      ],
    },
  };
}

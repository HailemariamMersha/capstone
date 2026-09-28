/* eslint-env browser */
/* global ndt7 */
// Runs inside the WebView. The upstream client and workers are bundled locally.
(function () {
  'use strict';
  const config = window.capstoneReference;
  let stopped = false;
  let activeWorker;
  let phaseTimer;
  let wholeTimer;
  let phase;
  const results = {};
  const send = (type, extra = {}) =>
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ version: 1, runId: config.runId, type, ...extra }),
    );
  const finite = value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function snapshot() {
    return { results: Object.values(results) };
  }
  function cleanup() {
    clearTimeout(phaseTimer);
    if (activeWorker) {
      activeWorker.terminate();
      activeWorker = undefined;
    }
  }
  function finish(reason) {
    if (stopped) {
      return;
    }
    stopped = true;
    cleanup();
    clearTimeout(wholeTimer);
    Object.values(results).forEach(result => {
      if (result.reason === 'running') {
        result.reason = reason;
      }
    });
    send('finished', { reason, ...snapshot() });
  }
  window.stopReference = () => finish('cancelled');
  if (config.accepted !== true) {
    finish('consent_required');
    return;
  }
  // Independent of upstream's watchdog (which can resolve a timeout as success).
  wholeTimer = setTimeout(() => finish('timeout'), 45000);
  const workerPrelude = `
    const OriginalWebSocket = self.WebSocket;
    self.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('close', event => self.postMessage({
          MsgType: 'transport_close', clean: event.wasClean, code: event.code
        }));
      }
    };
  `;
  async function run(direction, urls) {
    if (stopped) {
      return;
    }
    phase = direction;
    const result = (results[direction] = {
      direction,
      reason: 'running',
      host: new URL(urls['///ndt/v7/' + direction]).hostname,
      clientBytes: null,
      serverBytes: null,
      clientSeconds: null,
      serverSeconds: null,
      opened: false,
      cleanClose: false,
    });
    send('progress', snapshot());
    await new Promise(resolve => {
      let settled = false;
      const end = reason => {
        if (settled || stopped) {
          return;
        }
        settled = true;
        result.reason = reason;
        cleanup();
        send('progress', snapshot());
        resolve();
      };
      const source = workerPrelude + '\n' + config.workers[direction];
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      );
      let worker;
      try {
        worker = activeWorker = new Worker(url);
      } catch (_) {
        URL.revokeObjectURL(url);
        end('unsupported');
        return;
      }
      URL.revokeObjectURL(url);
      phaseTimer = setTimeout(() => end('timeout'), 10000);
      worker.onerror = () => end('network');
      worker.onmessage = event => {
        if (stopped || settled || phase !== direction) {
          return;
        }
        const message = event.data;
        if (!message || typeof message !== 'object') {
          end('invalid_response');
          return;
        }
        if (message.MsgType === 'start') {
          result.opened = true;
          clearTimeout(phaseTimer);
          phaseTimer = setTimeout(() => end('timeout'), 12000);
        } else if (message.MsgType === 'transport_close') {
          result.cleanClose =
            message.clean === true &&
            (message.code === 1000 || message.code === 1005);
        } else if (message.MsgType === 'measurement') {
          try {
            if (message.Source === 'client') {
              const data = message.ClientData;
              if (!finite(data.NumBytes) || !finite(data.ElapsedTime)) {
                throw new Error();
              }
              result.clientBytes = data.NumBytes;
              result.clientSeconds = data.ElapsedTime;
            } else if (message.Source === 'server') {
              if (
                typeof message.ServerMessage !== 'string' ||
                message.ServerMessage.length > 32768
              ) {
                throw new Error();
              }
              const data = JSON.parse(message.ServerMessage).AppInfo;
              if (data) {
                if (!finite(data.NumBytes) || !finite(data.ElapsedTime)) {
                  throw new Error();
                }
                result.serverBytes = data.NumBytes;
                result.serverSeconds = data.ElapsedTime / 1000000;
              }
            }
          } catch (_) {
            end('invalid_response');
            return;
          }
          send('progress', snapshot());
          if (
            Math.max(result.clientBytes || 0, result.serverBytes || 0) >=
            config.byteThreshold
          ) {
            // A best-effort threshold, not a hard byte cap: native buffers and the
            // upstream 250ms reporting interval can overshoot it.
            result.reason = 'data_threshold';
            finish('data_threshold');
          }
        } else if (message.MsgType === 'error') {
          end('network');
        } else if (message.MsgType === 'complete') {
          const bytes =
            direction === 'download' ? result.clientBytes : result.serverBytes;
          const seconds =
            direction === 'download'
              ? result.clientSeconds
              : result.serverSeconds;
          end(
            result.opened &&
              result.cleanClose &&
              finite(bytes) &&
              bytes > 0 &&
              finite(seconds) &&
              seconds > 0
              ? 'complete'
              : 'invalid_response',
          );
        }
      };
      worker.postMessage(urls);
    });
  }
  (async () => {
    try {
      const urls = await ndt7.discoverServerURLs(
        {
          metadata: {
            client_name: 'capstone-rn-reference',
            client_version: '0.1.0',
          },
        },
        {},
      );
      if (stopped) {
        return;
      }
      for (const direction of ['download', 'upload']) {
        const url = new URL(urls['///ndt/v7/' + direction]);
        if (
          url.protocol !== 'wss:' ||
          !url.hostname.endsWith('.measurement-lab.org') ||
          url.username ||
          url.password ||
          url.pathname !== '/ndt/v7/' + direction
        ) {
          throw new Error('Invalid discovery result');
        }
      }
      await run('download', urls);
      await run('upload', urls);
      if (!stopped) {
        finish('complete');
      }
    } catch (_) {
      finish('network');
    }
  })();
})();

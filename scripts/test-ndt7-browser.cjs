// Offline Chromium smoke test: real Web Workers and pinned NDT7 code, fake sockets.
// CHROME_BINARY can override the macOS default. No public speed test is performed.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const assets = require('../src/reference/ndt7Assets.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-browser-'));
const chrome = spawn(
  process.env.CHROME_BINARY ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless',
    '--remote-debugging-pipe',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    `--user-data-dir=${profile}`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
const pending = new Map();
let sequence = 0;
let buffer = '';
chrome.stdio[4].on('data', data => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(JSON.stringify(message.error)));
      } else {
        request.resolve(message.result);
      }
    }
  }
});
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(
      JSON.stringify({ id, method, params, sessionId }) + '\0',
    );
  });
}
const watchdog = setTimeout(() => {
  chrome.kill();
  process.exitCode = 1;
  console.error('Browser smoke test timed out');
}, 15000);
const fakeSocket = `
self.WebSocket = class {
  constructor() {
    this.bufferedAmount = 0; this.listeners = {}; this.bytes = 0;
    setTimeout(() => {
      this.onopen();
      this.timer = setInterval(() => {
        this.bufferedAmount = 0;
        if (this.bytes) {
          this.onmessage({data: JSON.stringify({AppInfo: {NumBytes: this.bytes, ElapsedTime: 600000}})});
        } else {
          this.onmessage({data: new Blob([new Uint8Array(1024)])});
        }
      }, 300);
      setTimeout(() => this.close(), 900);
    }, 0);
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  send(data) { this.bytes += data.byteLength; this.bufferedAmount += data.byteLength; }
  close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    this.listeners.close({wasClean: true, code: 1000}); this.onclose();
  }
};
`;
const cfg = {
  runId: 'offline',
  accepted: true,
  byteThreshold: 50 * 1048576,
  workers: {
    download: assets.download,
    upload: assets.upload,
  },
};
const fixtureRunner = assets.runner.replace(
  'const OriginalWebSocket = self.WebSocket;',
  fakeSocket + '\nconst OriginalWebSocket = self.WebSocket;',
);
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none'"></head><body><script>
window.capstoneReference=${json(cfg)};
window.ReactNativeWebView={postMessage(raw){const message=JSON.parse(raw);if(message.type==='finished')window.testResult=message;}};
(0,eval)(${json(assets.client)});
window.ndt7.discoverServerURLs=async()=>({'///ndt/v7/download':'wss://offline.measurement-lab.org/ndt/v7/download','///ndt/v7/upload':'wss://offline.measurement-lab.org/ndt/v7/upload'});
(0,eval)(${json(fixtureRunner)});
</script></body></html>`;
(async () => {
  try {
    const { targetId } = await command('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await command('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await command(
      'Runtime.evaluate',
      {
        expression: `document.open();document.write(${json(
          html,
        )});document.close();`,
      },
      sessionId,
    );
    const value = await command(
      'Runtime.evaluate',
      {
        expression: `new Promise(resolve => { const timer=setInterval(()=>{if(window.testResult){clearInterval(timer);resolve(window.testResult)}},50) })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    const result = value.result.value;
    assert.equal(result.reason, 'complete');
    assert.equal(result.results.length, 2);
    assert.ok(
      result.results.every(row => row.reason === 'complete' && row.cleanClose),
      JSON.stringify(result),
    );
    assert.ok(result.results[0].clientBytes > 0);
    assert.ok(result.results[1].serverBytes > 0);
    console.log(
      'Offline Chromium worker smoke passed: download and upload completed with real bundled NDT7 workers.',
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();

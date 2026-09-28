import assets from './ndt7Assets.json';
// Escape '<' in embedded data so no source text can terminate the script tag.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
export const NDT7_VERSION = assets.version;
export const REFERENCE_BYTE_THRESHOLD = 50 * 1024 * 1024;
export function referenceHtml(runId: string): string {
  const config = {
    runId,
    accepted: true,
    byteThreshold: REFERENCE_BYTE_THRESHOLD,
    workers: { download: assets.download, upload: assets.upload },
  };
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src https://locate.measurementlab.net wss://*.measurement-lab.org; style-src 'unsafe-inline'">
    </head><body><p>NDT7 reference test running. Keep this screen open.</p>
    <script>window.capstoneReference=${json(config)};
    (0,eval)(${json(assets.client)});
    (0,eval)(${json(assets.runner)});</script></body></html>`;
}

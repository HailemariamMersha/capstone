# Pinned Android NDT7 fork

Upstream: https://github.com/m-lab/ndt7-client-android
Commit: `3e831b785bf4086fddb8e700458588e39b493cf0`
Upstream library version: 0.2.1. SkyMeasure provenance: **0.2.2-skymeasure.2**.
License: Apache-2.0, reproduced in LICENSE. This is a source fork maintained by
SkyMeasure, not an unmodified upstream SDK or an M-Lab-certified client.

The upstream models, WebSocket factory, payload growth and timing utilities are
retained. Downloader, Uploader and the NDTTest coordinator have substantial
lifecycle/budget modifications. The app module exposes this library to React
Native and binds its OkHttp socket factory **and DNS** to the selected Wi-Fi.
There is no application-owned raw TCP/ICMP measurement implementation here.

Changes relative to the pinned source:

- Byte limits are nullable. A private pilot may request normal-duration testing without a byte cutoff; bounded builds still retain explicit cap outcomes. Duration, watchdog, memory and control-message guards remain. This change does not imply unlimited test duration.

- Modern Android library Gradle configuration; no deprecated Kotlin extensions
  or publishing plugin. OkHttp 4.12.0 and Gson 2.10.1 pinned.
- Added missing receiver `AppInfo` to the server model. Upload Mbps is derived
  from server-received bytes/time, never merely enqueued client bytes. Public
  device validation found a server emitting TCPInfo without AppInfo: use its
  BytesReceived/ElapsedTime fallback with explicit `tcp_info` provenance,
  distinguishing TLS/WebSocket-inclusive throughput from application payload.
- Replaced semaphore/executor lifecycle with sequential, bounded directions.
  Both sockets and Locate discovery can be cancelled. Completion is delivered
  once. The caller waits for worker cleanup before releasing the activity gate.
- Upload starts after the handshake, counts only successful sends, yields under
  backpressure and stops enqueuing on cancellation/close. The 10-second sender
  window closes normally; remote early clean termination is also supported.
- Download counts binary payload bytes only. Text telemetry is bounded to
  64 KiB per direction. Budget termination is explicitly incomplete. Clean
  completion requires the closing handshake, not just an initial close frame.
- Locate v2 response bounded to 256 KiB, no redirects, WSS host/path allowlist,
  no signed URLs in result records. Discovery failure is retained; no fallback
  retry burst. Maximum pair watchdog 60 seconds; each direction wait 25 seconds
  including handshake and shutdown grace.
- The bridge applies one 90 MiB payload threshold per direction and a durable
  four-attempt rolling-24-hour ceiling. Reserve 200 MiB before initialization:
  two thresholds, up to one 16 MiB protocol-compliant download message past the
  threshold, and 4 MiB control margin. Wire overhead remains unobservable.
- At most 100 callback records per direction, plus final counters. Dropped
  callback counts are preserved. Server TCP/BBR telemetry is server evidence,
  not handset kernel telemetry. Parsed upstream models can omit future fields.

Maintenance: changes must preserve license and this upstream pin, update this
patch list/version, run `:ndt7:testReleaseUnitTest`, the TypeScript tests and an
Android build. Compare any upstream update explicitly; do not replace sources
without reviewing cancellation, receiver accounting and routing. Mock tests
are not proof of public-service or real-flight measurement accuracy.

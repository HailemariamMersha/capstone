# One Start: automatic M-Lab speed tests

Policy `flight-mlab-2026-11-02`, consent `skymeasure-flight-mlab-2026-11-02`.
Participants review research participation and M-Lab public-data disclosure in
one onboarding step. Existing installations must review this new version.
Location and notification remain Android permission prompts; M-Lab needs
informed publication consent, not another Android permission.

**Start trip** arms detection and schedules one NDT7 download/upload pair
1–3 minutes after collection first qualifies (random delay, saved with the trip).
It waits for validated, selected Wi-Fi. Watching at home does not trigger it.
Explicitly labelled researcher shadow trips can exercise it on ground Wi-Fi.
A transfer reservation, attempt records and disclosure event are saved before
traffic. Segment rotation does not schedule another pair. No automatic retry
occurs after cancellation, discovery failure or an incomplete benchmark.

The participant no longer has a separate speed-test button. Stop trip cancels
the test. The Android library runs with the trip's foreground service and does
not depend on a visible WebView. It uses the selected Wi-Fi socket factory and
DNS; Wi-Fi loss cancels it. Android force-stop still stops execution. Existing
researcher manual WebView tests remain a separate legacy diagnostic tool.

## Data allowance

| Activity | Application reservation per trip |
| --- | ---: |
| One M-Lab pair | 200 MiB |
| Controlled HTTP pairs | 60 MiB |
| Packet probes and detection | 20 MiB |
| Live record uploads | 20 MiB |
| Total | 300 MiB |

The shared transfer pool is 260 MiB. M-Lab's reservation is charged in full even
when it fails; it is not a measured carrier-usage counter. Controlled transfers
retain 5,000,000-byte downloads / 1,000,000-byte uploads and their existing
adaptive schedule. Historical 100 MiB trips retain their policy and counters.

M-Lab stops at a 90 MiB payload threshold per direction. A received download
message can pass the threshold by up to the protocol's 16 MiB message maximum;
200 MiB reserves both thresholds, this possible message and control margin.
Transport overhead, retransmissions and post-trip uploads are additional.
A fast connection can hit the threshold before the usual approximately
10-second test completes; such a result is **incomplete, with speed unavailable**.
This cap intentionally trades benchmark completion for bounded planned usage.
The Android integration reserves at most four attempts per installation in a
rolling 24 hours, persisted before traffic, including failed/cancelled attempts.
Reinstallation can remove that local history; server platform limits still apply.

## Evidence and formulas

Two records are saved in the existing segment: `ndt7_download` and `ndt7_upload`.
They upload with other segment records and appear in session detail/exports.
No measurement record is duplicated as another standalone session.

- `method = ndt7_android_library`, `reference.library = ndt7-client-android`,
  version `0.2.1-skymeasure.1` identifies the pinned patched Android client.
- Completed download Mbps = client binary bytes × 8 / client seconds / 1,000,000.
- Completed upload Mbps = server `AppInfo.NumBytes` × 8 /
  (`AppInfo.ElapsedTime` / 1,000,000) / 1,000,000. If AppInfo is absent, use
  server `TCPInfo.BytesReceived` and `TCPInfo.ElapsedTime` with the same units.
  This fallback includes TLS/WebSocket overhead. It is explicitly identified
  by `reference.serverCounterSource = tcp_info` and
  `method = ndt7_android_library_server_tcp`; AppInfo uses `app_info`.
  Never substitute the client's queued upload bytes.
- `durationMs` is the last client measurement interval, server interval fallback,
  not Locate discovery or the entire operation's wall-clock duration.
- Missing receiver telemetry, malformed responses, timeout, cancellation,
  abnormal close and caps yield null speed with an explicit stop reason.
  Raw bounded callbacks and available counters remain available.
- `requestedBytes` is 90 MiB per direction. The trip additionally reserves a
  margin; summing measurement requests is therefore not the trip budget total.
- `transferredBytes` is client-received download payload, or upload bytes
  enqueued minus the remaining WebSocket queue. The latter is not proof of
  receipt. Only server observations determine upload Mbps.
- Server TCPInfo/BBRInfo, if returned, describes M-Lab's server socket. It is not
  handset kernel data, a full packet capture or an Ookla-equivalent result.

M-Lab publishes public IP and test evidence. SkyMeasure does not send the flight
form, identity token, trip ID or GPS observations to M-Lab. Deleting a SkyMeasure
account cannot retract data already published by M-Lab. Raw results contain only
the selected hostname, not discovery access tokens or signed URLs.

Implementation and maintenance: [pinned Android fork](../../android/ndt7/PATCHES.md).
Primary references: [M-Lab integration/consent guidance](https://www.measurementlab.net/develop/),
[platform policy](https://www.measurementlab.net/privacy/),
[NDT7 protocol](https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md).

## Validation

Automated tests exercise one pair across segment rotation, no traffic while
Watching, updated consent, receiver-side accounting, missing/capped values,
cancellation, quota rejection and versioned backend budgets. Android local
mock-WebSocket tests cover binary-only counting, abnormal close, byte caps and
single completion. These tests do not publish measurements to M-Lab.

Physical public-service and screen-locked trip validation requires acceptance
of the new disclosure on the phone. Ground shadow tests must stay labelled as
researcher tests; they do not validate flight detection. Do not enable fake
flight evidence in participant builds to make a ground test qualify.

## Physical ground check — 2 November 2026

After the participant accepted the new disclosure, one explicitly opted-in
instrumentation test connected through the Samsung Galaxy A34's selected Wi-Fi.
It was not a flight trip and did not inject synthetic detector evidence.

| Direction | Observation | Interpretation |
| --- | --- | --- |
| Download | 94,371,840 binary bytes in 7.282126 s | Reached the 90 MiB threshold; incomplete, no completed speed reported |
| Upload | Clean close; server TCP received 76,788,246 bytes at 10.000853 s | 61.425357 Mbps server TCP throughput; includes TLS/WebSocket overhead |

The initial bridge expected AppInfo, which this server did not send. Inspection
of already captured callbacks revealed TCPInfo receiver counters. The corrected
fallback is tested against a sanitized fixture from that same run; no second
public test was needed or performed. The original private result is retained on
the phone; it was not rewritten or uploaded as flight data.

One-Start scheduling across segment boundaries is covered by integration tests.
A real qualified flight, full automatic phone-to-dashboard M-Lab delivery, and
locked-screen M-Lab execution remain physical validation tasks. A successful
native instrumented connection alone does not establish those behaviors.

# Custom payload experiment — 28 September 2026

The Samsung Galaxy A34 (SM-A346E, Android 13) ran the updated bundled release with user-selected **5 MiB download and 2 MiB upload**. Existing phone and backend records were preserved.

## Configuration and method

- Session: `7bb32213481ba949a6c487568d91d98e`.
- Start/end: `2026-09-28T13:15:57.261Z` to `2026-09-28T13:16:57.421Z`.
- Duration limit: 60 seconds; RTT/download/upload intervals: 20 seconds each, with an immediate initial batch.
- Download: 5,242,880 bytes per probe. Upload: 2,097,152 bytes per probe.
- Timeout: 30 seconds per probe. Planned payload budget: 100 MiB. Optional diagnostics off.
- Path: phone → USB `adb reverse` → Mac FastAPI. The updated backend ran on port 8001; `adb reverse tcp:8000 tcp:8001` retained the app URL `http://127.0.0.1:8000` without interrupting the older server on port 8000.

The app times complete HTTP transactions, including response consumption and upload acknowledgement. Upload payload preparation occurs before its timer. Download responses stream a repeated 1 MiB random binary block with explicit Content-Length and no HTTP compression. This is a functional test over USB, not a satellite/internet capacity measurement.

## Results

| Measurement | Sample 1 | Sample 2 | Sample 3 | Arithmetic mean |
| --- | ---: | ---: | ---: | ---: |
| HTTP RTT (ms) | 59.708 | 14.611 | 20.736 | 31.685 |
| Download (Mbps) | 40.547 | 41.864 | 42.247 | 41.553 |
| Upload (Mbps) | 65.842 | 82.334 | 67.529 | 71.902 |

All nine measurements succeeded. Each download and upload retained matching `requestedBytes` and `transferredBytes`, with the upload count confirmed by the server. Confirmed application payload was 22,020,108 bytes: **21 MiB** of throughput payload plus 12 bytes for the three RTT replies. This excludes headers, retransmissions, context and sync traffic.

The session ended automatically at the duration limit. Its 18 records (one session, nine measurements, six events and two snapshots) were verified in the durable backend database. The sync batch acknowledged 38 records including older pending records; the phone then displayed zero awaiting acknowledgement.

## Using custom sizes

In **Session settings**, enter **Download size (MiB)** and **Upload size (MiB)** before starting. Decimal values are supported and rounded to whole bytes; the fields show the actual byte counts. The supported range is 1 byte through 100 MiB per probe, subject to the session budget. Stop a running session before changing sizes; the saved session configuration preserves the original values. Resuming a saved session reuses them.

These settings also control loaded-latency transfers. SpeedChecker and NDT7 manage their own transfer sizes. Restart the updated backend before testing custom sizes against it; the previous backend capped uploads at 1 MiB and allowed only preset downloads.

To repeat this experiment, use a one-minute duration with all three intervals set to 20 seconds, enter 5 and 2 in the size fields, start the session, wait for automatic completion, and tap **Sync now**. Inspect the saved session's payload counts. Repeated throughput values will vary.

## Checks and limits

TypeScript, lint, 131 app tests and 23 backend tests passed. After the final upload-buffer change, the affected 16 probe tests, TypeScript and lint passed again. The SDK-enabled Android release built and installed successfully. Tests cover decimal conversion, arbitrary byte sizes, exact acknowledgements, invalid inputs, inclusive bounds and streamed-upload size enforcement.

This physical experiment validates 5 MiB downloads and 2 MiB uploads. It does not establish memory/performance behavior at the 100 MiB maximum, physical-network throughput, long background endurance or iOS behavior. Larger transfers consume more memory and may require a longer timeout.

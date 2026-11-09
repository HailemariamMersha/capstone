# SkyMeasure supervisor pilot — 1 November 2026

> Historical build/install record. For the current APK build procedure use [CONTRIBUTING](../../CONTRIBUTING.md#4-build-or-debug-the-participant-app); current behavior and validation are in [the ASN policy](../measurements/flight-collection.md) and [validation history](validation.md). Do not use the dated APK/version below as the latest release.

**Superseded for new builds:** the [automatic M-Lab update](automatic-mlab.md) combines publication consent with onboarding, adds one speed-test pair to Start trip, and raises the trip allowance to 300 MiB. Deploy its new consent version before distributing the new APK. The dated artifacts and validation below describe the earlier build only.


This is an Android evaluation build. It contains the current library-based
packet collector and an optional M-Lab NDT7 speed test on Home. It uses the lab
API at `https://api.hailemariam.com`, UDP at `23.235.205.53:9876`, Supabase
accounts/storage, and the existing Vercel researcher dashboard. The lab's
location remains `lab-location-unconfirmed`.

## APK and installation

The shareable artifact is:
`build/pilot/2026-11-01/SkyMeasure-pilot-2026-11-01-arm64.apk`.
The adjacent `manifest.json` records its source commit, configuration and SHA-256.
These generated artifacts are ignored by Git. Share the APK and these instructions
directly with the supervisor; no app-store release or public download is required.

1. Use a compatible **64-bit ARM Android phone running Android 7.0 or newer**. This APK cannot run on iPhone
   or an x86 Android emulator.
2. Download the APK to the phone and open it. Android may ask you to allow
   installation from the browser or file manager used to open it.
3. Open **SkyMeasure**, choose **Continue with Google**, and review the research
   participation information. First sign-in needs internet access. If the
   Google OAuth project is still in Testing, add the supervisor's Google account
   to that project's test-user list before sign-in.
4. On Home, start a normal ten-minute collection session, stop it when desired,
   and open Sessions. Uploads happen after collection; Wi-Fi is the default
   upload preference. Wait for **Uploaded** to confirm delivery.
5. Separately, scroll to **Internet speed test**, review the M-Lab disclosure,
   enable its consent switch, and tap **Start speed test**. Keep Home visible
   until it finishes. Download/upload results are shown in Mbps and saved as a
   separate account-owned session. Leaving Home or backgrounding the app cancels
   the test and preserves available partial evidence.

The APK is bundled and does **not** need Metro, USB, or the developer's Mac to
run. It uses the existing development signing key for pilot distribution. It is
not a production-signed Play Store release. For a phone that already has this
project installed, stop collection and update in place; do not uninstall or
clear app data to work around an installation error.

## What the speed test means

- Library: official `@m-lab/ndt7` 0.1.5, with its bundled Web Workers running in
  `react-native-webview` 14.0.1. No new custom socket measurement code was added.
- Destination: an M-Lab-selected server, independent of the lab's controlled
  HTTP/UDP probe server. NDT7 results must not be treated as measurements to the
  same server, or as interchangeable with Ookla results.
- Download speed: client-received bytes × 8 / elapsed seconds / 1,000,000.
  Upload speed uses server-received bytes and server elapsed time. A completed,
  cleanly closed test is required to report a speed.
- Each direction normally runs about ten seconds. The existing reported
  **50 MiB per-direction threshold** stops the entire test; buffered traffic
  can exceed it. It is separate from the normal collection allowance and is
  not a hard carrier-data cap. Faster connections may hit the threshold before
  completion; these results are marked unavailable/incomplete, not zero.
- Consent is required for every run because M-Lab collects and publishes the
  public IP address and test results. SkyMeasure also saves the bounded raw
  library callback evidence locally and uploads its owned records afterward.
  See [M-Lab's data policy](https://www.measurementlab.net/privacy/) and
  [official client library](https://github.com/m-lab/ndt7-js).

SpeedChecker is still excluded from this default APK: its optional Android
integration requires vendor repository credentials and separate data-sharing
consent. Ookla is not integrated. This pilot does not imply either provider is
available in the participant screen.

## Researcher access and validation

Google signup creates a participant, not a researcher. To give the supervisor
dashboard access, an administrator must separately grant researcher access after
signup. The dashboard remains at `https://capstone-backend-henna.vercel.app`.
Do not share another user's login or grant administrator access merely to test
the participant app.

Automated tests cover consent before traffic, account ownership, cross-account
upload exclusion, cancellation during startup, leaving Home, backgrounding,
watchdog timeout, persistence, and upload handoff after the activity gate opens.
The Chromium smoke test runs the real bundled library workers against fake
sockets; it does not run a public M-Lab test or establish measurement accuracy.

Validation on 1 November: **202 tests across 31 suites passed**, TypeScript
passed, and the edited-file lint check had no errors (two existing UI callback
warnings remain). The offline Chromium worker test and ARM64 release build
passed. Android's `apksigner` verified the APK's v2 signature. Inspection of the
packaged JavaScript confirmed the new speed-test screen, lab IP and region,
unchanged HTTPS domain, and absence of the old DigitalOcean UDP address.
Normal DNS-based API health checks also reached the lab server.

The APK is 32,167,766 bytes, package `com.labpracticeapp`, version name `1.0`,
version code `1`, built from commit `648b3ad0c10abb9fdea2d07b571e47ddfa5f44bc`.
SHA-256: `b82e49758ba2894463009d6b89448be1323fbc212b9c75f6482b02727964c601`.

The configured APK must still be installed and exercised on a physical phone
with a real Google login, a normal collection/upload, and an explicitly consented
M-Lab test. Those checks remain pending until a phone is connected. The retained
DigitalOcean server is not yet retired.

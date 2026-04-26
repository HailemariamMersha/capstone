# LabPracticeApp

LabPracticeApp is a bare React Native mobile app for simple network measurement. It lets a user enter a target URL, send one HTTP request every 10 seconds, measure latency with `Date.now()`, and save each result as a CSV row on the device.

The app is written in plain JavaScript at the app/source level. It uses one shared JS codebase for the main UI and measurement logic, with Android-specific native setup only where required for background execution and battery optimization handling.

## Quick Start

Install dependencies from the project root:

```bash
npm install
```

Start Metro:

```bash
npm start
```

In a second terminal, run the Android app:

```bash
npm run android
```

For a real Android phone over USB, confirm the device is connected and forward Metro first:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
npm run android
```

## Current Features

- Enter a target website URL
- Normalize input such as `example.com` to `https://example.com`
- Start and stop a measurement loop
- Run one request immediately, then every 10 seconds
- Measure latency using `Date.now()` before and after `fetch`
- Save each result to `network_log.csv`
- Show the 30 most recent logs in the UI
- Show current app state, status, last latency, and request count
- Show the CSV path in the app
- Continue measuring on Android in the background through a foreground service and persistent notification

## Current Measurement Data

Each CSV row contains:

- `timestamp`
- `target_url`
- `success`
- `latency_ms`
- `http_status`
- `app_state`
- `error`

The CSV header is:

```csv
timestamp,target_url,success,latency_ms,http_status,app_state,error
```

## Tech Stack

Main tools and libraries currently used:

- `react-native` `0.84.1`
- `react` `19.2.3`
- `react-native-fs`
- `react-native-background-actions`
- `react-native-safe-area-context`
- React Native built-in UI components for the current interface

## Background Service

Android background measurement currently uses `react-native-background-actions`.

How it works now:

- When the app is active, measurement runs in the normal JS app context
- When the app goes to the background on Android, the app starts a foreground service
- The foreground service shows a persistent notification
- The notification text updates with the latest request result and request count

Current limitation:

- Android background mode is supported
- iOS should still be treated as foreground-only for this project stage

## Project Structure

```text
LabPracticeApp/
  App.js
  src/
    components/
      ControlPanel.js
      LogList.js
    services/
      backgroundService.js
      csvService.js
      deviceSettingsService.js
      measurementService.js
      pingService.js
      preferencesService.js
    utils/
      url.js
```

## Important Files

- `App.js`: top-level app state, UI composition, start/stop behavior, AppState handling
- `src/components/ControlPanel.js`: input and buttons
- `src/components/LogList.js`: recent measurement cards
- `src/services/pingService.js`: simple `fetch` request and latency measurement
- `src/services/measurementService.js`: orchestration of request + CSV append
- `src/services/csvService.js`: CSV creation, append, recent row parsing, request counting
- `src/services/backgroundService.js`: Android background loop and notification updates
- `src/services/deviceSettingsService.js`: Android battery optimization helpers
- `src/services/preferencesService.js`: small persisted flags for startup prompts
- `src/utils/url.js`: URL normalization

## How Requests Work

The app currently uses a simple `fetch` request:

- method: `GET`
- one request immediately on start
- then one request every 10 seconds
- `success` is based on `response.ok`
- `http_status` is recorded when a response is received
- failures are stored in the `error` field

## CSV Storage

The file name is:

```text
network_log.csv
```

It is stored in the app documents directory through `react-native-fs`.

The app shows the exact path when the user presses `Show CSV Path`.

On Android, the file is typically under the app sandbox, for example:

```text
/data/user/0/com.labpracticeapp/files/network_log.csv
```

Useful `adb` commands:

```bash
adb shell run-as com.labpracticeapp ls files
adb shell run-as com.labpracticeapp cat files/network_log.csv
adb exec-out run-as com.labpracticeapp cat files/network_log.csv > network_log.csv
```

## Running the App

From the project root:

```bash
npm install
```

### Android Emulator

```bash
npm start
```

In another terminal:

```bash
npm run android
```

### Real Android Phone Over USB

Check device connection:

```bash
adb devices
```

Forward Metro over USB:

```bash
adb reverse tcp:8081 tcp:8081
```

Start Metro:

```bash
npm start
```

In another terminal:

```bash
npm run android
```

### iOS Simulator

Install pods first:

```bash
cd ios && pod install && cd ..
```

Start Metro:

```bash
npm start
```

In another terminal:

```bash
npm run ios
```

## Android Notes

Current Android-specific behavior:

- requests notification permission on Android 13+
- prompts for battery optimization exemption on first open
- uses a foreground service notification while background measurement runs
- uses `WAKE_LOCK`

If background behavior seems inconsistent on a physical Android phone, check:

- notifications are allowed
- battery optimization is disabled or unrestricted for the app
- the phone has working internet access

## Development Notes

- Source app code is plain JavaScript
- The project still contains some template TypeScript-related dev dependencies from the React Native scaffold, but the app logic is implemented in JS
- Logging is intentionally verbose with `console.log` for debugging

## Known Caveats

- Android background support depends on a persistent notification
- iOS background measurement is not implemented
- Airplane Wi-Fi, captive portals, and unstable mobile networks can cause `Network request failed`
- `success` is only `true` for HTTP 2xx responses

## Validation Commands

Useful local checks:

```bash
npx eslint App.js src __tests__/App.test.js
npm test -- --runInBand --watchman=false
```

## Pending Cleanup

There is currently a local patch inside `node_modules/react-native-background-actions` to keep the Android foreground-service notification startup stable on newer Android versions. That patch is not yet persisted with a patching tool, so a future `npm install` can overwrite it.

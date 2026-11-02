# Android Google sign-in recovery — 2 November 2026

The pilot had three separate issues:

- Try again on the missing-profile screen only fetched the profile. It did not
  open Google sign-in. Recovery now separates Sign in with Google and Retry
  connection, with explicit messages for deletion, consent and researcher access.
- Original SkyMeasure and Flight Pilot both claimed `com.labpracticeapp://auth/callback`.
  The pilot now uses `com.labpracticeapp.flightpilot://auth/callback`; the original
  app retains its existing callback. The operator registered the new URI in
  Supabase Authentication URL Configuration without removing existing entries.
- A release reused JavaScript compiled with placeholder settings. React Native's
  default Gradle bundle inputs include JS/TS but omit JSON. The public config file
  is now an explicit input, and unconfigured/callback-mismatched builds fail before
  bundling. The new builder also checks service strings in the actual APK.

One phone diagnosis found valid Google credentials (Supabase HTTP 200) rejected
by the study API (HTTP 403) because that research account was marked deleted.
Reauthentication cannot undo a study-account deletion. The participant chose a
separate Google account; the deletion block and original record ownership remain
intact. Account switching never reassigns old recordings.

Google OAuth requests `prompt=select_account` and retains S256 PKCE and strict
callback matching. This is browser-based Google sign-in; the browser may offer a
Google login form rather than every account registered with Android.

Authenticated bodyless reads retry once after a server 401 by refreshing tokens
for the same initiating owner. Uploads stay in the durable retry mechanism so
replayed requests are charged to the existing upload allowance. A 403 does not
start a refresh loop. Explicit deletion overrides cached Home; offline cached
profiles remain available for recoverable connectivity failures.

## Building the pilot

Keep public deployment inputs in ignored `.env.skymeasure.local`, or supply the
SKYMEASURE_* environment variables described in the setup guide. Run:

```sh
npm run android:pilot -- --out build/pilot/current
# Add --with-tests to also build the instrumentation companion.
```

The builder sets the pilot callback, serializes its own invocations, configures
public JSON, builds ARM64, verifies the packaged values, copies the APK and writes
its source/config hashes. It restores the original public JSON in a finally
block. Config files and generated artifacts stay outside Git. Use the verified
output rather than an APK left by a manual diagnostic Gradle invocation.

## Validation and artifact

248 app tests, TypeScript, edited-file lint (two existing UI warnings), release
and test-companion builds pass. A negative Gradle check confirms placeholder
configuration is rejected. APK inspection confirms expected service settings
and pilot callback. Android resolves that URI only to Flight Pilot. The configured
v1.1.3 build was installed without clearing participant records, and its Google
sign-in action opened the phone's browser. Full account selection and callback
completion must be confirmed by the participant; browser launch alone is not
end-to-end login validation.

Artifact: `build/pilot/2026-11-02-signin-fixed/SkyMeasure-pilot-arm64.apk`.
Source: `f55b5352612b5efe19d872893f0185fb7720dd44`.
Package: `com.labpracticeapp.flightpilot`, version 1.1.3 (code 5), 32,770,450 bytes.
SHA-256: `d494537da9541904e3cc7a8c176b76501c11bed5771084d096937f2a8a46c18f`.
The APK's Android v2 signature is verified; it remains a private development-key pilot.
The earlier v1.1.2 artifact with placeholder configuration must not be shared.

`AuthConnectivityTest` is an opt-in, read-only phone diagnostic. It reuses the
app's existing Keychain module and reports only storage/account-type flags and
HTTP status codes. Tokens, account IDs and emails are not logged or written to
exports. Network destinations are limited to the existing project and API.

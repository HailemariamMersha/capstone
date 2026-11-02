# Participant interface — 2 November 2026

For the latest configured APK and Google recovery fixes, see [sign-in recovery](sign-in-recovery.md). The dated UI artifact below records its original build.

Participants see optional flight number, departure and arrival, followed by
**Start trip** and **Skip and start**. Skip starts with no flight metadata,
including when fields were already entered. Both paths use the same permission
checks and collector. Expected flight duration is no longer an ordinary form
field; the existing unknown-duration sampling default applies.

During an armed trip, Home shows the flight, a plain-language status, elapsed
minutes and Stop. Budgets, confidence tiers, protocol results, M-Lab internals
and segment/upload scheduling remain research data rather than Home copy.
Researcher collection controls remain restricted to researcher accounts.

Welcome and consent use the shared light/teal styling, larger controls and short
summaries. M-Lab public-IP/result publication and substantial data use remain
visible before acceptance. The original complete disclosure is accessible under
**Read full study details**, including data accounting and periodic uploads.
Consent terms and their recorded version are unchanged by this presentation
update. Existing participants therefore do not need to accept them again.

The Trips tab emphasizes whole journeys. Individual recordings, their status,
results and exports remain accessible through **View saved recordings**.

Validation: all 238 app tests pass; TypeScript and the ARM64 release build pass.
Edited-file lint has no errors and retains the two existing nested-component
warnings. Tests exercise entered details, Skip ignoring partially entered fields,
permission denial and access to the full disclosure. The Galaxy A34 preview
confirms the three fields and both actions are visible at the current text size,
with no technical budget/scheduling copy. The page remains scrollable for larger
text and the keyboard.

Private pilot artifact:
`build/pilot/2026-11-02-ui/SkyMeasure-simple-ui-arm64.apk`.
Source `0dd4a9e`, package `com.labpracticeapp.flightpilot`, version 1.1.1 (code 3),
32,766,314 bytes. SHA-256:
`b99eb11cc3a7da2f58434c6efb3d8dd672e2b745c93769515d31488bef2218aa`.
The adjacent manifest and Home screenshot are local artifacts, excluded from Git.
The pilot was updated in place without clearing the participant identity or data.

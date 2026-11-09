# Repository sharing review — 9 November 2026

The repository is public. Current participant/dashboard work is on `feature/skymeasure-participant-dashboard`; `main` is an earlier collector. This review does not change visibility, default branch, deployment credentials or shared history.

## Scope and findings

Reviewed tracked file names/content and blob history reachable from refreshed `origin` branches and local tags. The scan covered 801 published-reference blobs before these cleanup commits. Local Codex checkpoint references were distinguished from published branches; local generated presentations remain private, ignored artifacts. Original experiment datasets and deployment environment files remain local.

Pattern checks covered private-key PEM headers, GitHub/Google/DO/cloud token formats, Supabase secret/JWT formats, credentialed PostgreSQL URLs, personal email patterns, local home paths, device serial patterns and MAC addresses. No matching private credentials, personal email/home/device patterns or raw participant exports were found in the reviewed published history. Address matches were the synthetic `02:00:00:00:00:01` dictionary example; the current Android source additionally filters Android's placeholder Wi-Fi address. This scoped review is not a guarantee that every possible secret format or indirect identifier can be detected.

Kept intentionally: package locks and Gradle wrapper, required generated runtime/documentation assets, upstream library source/licenses, the public Supabase CA certificate, standard React Native development keystore, and sanitized historical experiment summaries. The development keystore is public and must not serve as a production signing secret. No credential rotation or shared-history rewrite was warranted by these findings.

## Cleanup

- Replaced the contradictory root README with current setup, architecture, measurement scope, limitations and the correct review-branch link.
- Added a documentation reading map and security/data-handling guide; marked original hosting instructions as historical.
- Added a public-only mobile environment template without copying local deployment values.
- Ignored generated presentations, export/dataset directories, databases, packet captures, APKs, logs and private signing/key material. No original local evidence was deleted.
- Corrected the generated dictionary's source-guide link to the current review branch.

## ASN-only change validation

The separately versioned `asn-only-v1` detector removes GPS/SSID qualification and automatic GPS sampling. Historical confidence labels, ownership and upload retries remain compatible. Automated results: 275 mobile tests passed, 45 backend tests passed with one optional PostgreSQL integration test skipped, 17 dashboard browser tests passed; mobile/dashboard TypeScript and the dashboard production build passed. Focused ESLint had zero errors and two pre-existing navigation component warnings. These checks do not validate a real flight, optional SSID availability, denied-location behavior on every Android build, or long unplugged endurance.

Configured Android packaging and isolated API deployment are verified separately before APK distribution. Public recruitment remains subject to the documented study-text, enrollment-protection and lifecycle validation gates.

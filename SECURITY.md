# Repository security and research-data handling

This public repository contains source, configuration templates, sanitized fixtures and dated validation summaries. The live researcher workspace is separately authenticated and role restricted. Repository visibility does not grant access to participant records.

## Configuration boundaries

Only public endpoint URLs, Supabase publishable keys, OAuth callback schemes and public CAPTCHA site keys belong in a mobile/browser bundle. A publishable key is not a server credential. Keep deployment-specific mobile configuration in the ignored `.env.skymeasure.local`; the pilot builder restores the sanitized tracked `src/config/public.json` after packaging.

Database passwords/URLs with credentials, Supabase service-role keys, OAuth client secrets, Turnstile secrets, MaxMind licenses, SSH private keys, signing credentials, bearer tokens and TLS private keys belong in protected local/server configuration. Do not paste them into issues, logs, screenshots or commits. Template values must remain placeholders.

`android/app/debug.keystore` is the standard public development signing key, retained for local/pilot builds and update continuity. It provides no production signing secrecy. Use a separately protected production key before any public distribution. `deploy/certs/supabase-prod-ca-2021.crt` is a public CA certificate used to verify database TLS, not a private TLS key. Vendored libraries, their licenses, lockfiles and required generated runtime assets remain committed for reproducible builds.

## Participant evidence

Raw exports, databases, packet captures, APKs, local presentations and research logs stay in ignored local directories such as `build/`, `output/`, `exports/` or `datasets/`. Ignore rules prevent accidental additions; they do not remove files already committed or protect against `git add -f`. Sanitize an example before placing it in a documented fixture directory. Never commit coordinates or raw location objects. Public IPs, Wi-Fi identifiers, exact times and reported flight details can identify people or journeys; removing an email alone is insufficient anonymization.

Preserve original private evidence locally. Historical ownerless records are not assigned to a new identity, and identity reset must not reassign pending data. Researcher access and deletion follow the application authorization policy, independent of GitHub access.

## Reviewing before a push

Inspect `git status --short`, the staged diff and newly tracked file names. Check both the current tree and published branch history for secrets and private artifacts when preparing a review. Pattern scans have limits: no matches do not establish that arbitrary research data is anonymous or that every possible credential format was checked.

If an actual credential is exposed, revoke/rotate it promptly and assess access before deciding whether coordinated history removal is necessary. Deleting a current file does not remove history. Do not rewrite shared history merely to remove harmless placeholders or the standard development key. Report suspected vulnerabilities privately to the project maintainer through an existing trusted channel; do not publish exploit credentials or participant exports in an issue.

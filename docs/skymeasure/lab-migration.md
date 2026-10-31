# Lab-server migration

## Deployment status — 31 October 2026

SkyMeasure is staged on the lab's InMotion server, `23.235.205.53`. DNS cutover
and physical-phone validation are pending. The original DigitalOcean server,
`142.93.34.57`, remains running for rollback; it continues to incur charges.
No existing lab application, database, file, or service was deleted. No system
packages were upgraded and the machine was not rebooted.

The server's physical location is **unconfirmed**. Both API responses and the
new Android build use `lab-location-unconfirmed`, not `lon1`. Changing a label
cannot move a server to London. Confirm the hosting location with the lab before
using geographic interpretations of RTT or comparing with the London pilot.

The dashboard stays on Vercel and the research database and Google login stay
on Supabase. There is no database copy, schema migration, role change, or new
participant account. The HTTPS hostname remains `api.hailemariam.com`.

## Isolation on the shared host

The host has Ubuntu 20.04, OpenVZ virtualization, 6 visible CPUs, 16 GiB RAM,
and approximately 123 GiB free disk at inspection. Apache already owns ports
80/443. Docker was absent; installing it or replacing Apache was unnecessary.

| Component | Configuration |
| --- | --- |
| API | `skymeasure-api.service`, user/group `skymeasure`, `127.0.0.1:18000` |
| UDP | `skymeasure-udp.service`, same non-login account, public UDP 9876 |
| HTTPS | Separate `/etc/apache2/sites-available/skymeasure.conf` virtual host |
| Source | `/opt/skymeasure/releases/36e7c27-lab1`, linked as `/opt/skymeasure/current` |
| Python | Isolated CPython 3.14.9 under `/opt/skymeasure/python` |
| Dependencies | `/opt/skymeasure/venv`, pinned `backend/requirements.txt` |
| Runtime secrets | Root-only `/etc/skymeasure/api.env`, mode 0600 |
| TLS files | Root-only directory `/etc/skymeasure/tls` |
| Certificate state | `/etc/skymeasure/acme`, separate from the lab's Certbot state |
| ACME HTTP challenge | `/var/lib/skymeasure/acme-webroot` |
| Renewal | `skymeasure-cert-renew.timer`, twice daily with randomized delay |

The system Python, global packages, existing Apache virtual hosts, existing
Certbot timer, and lab MySQL/PostgreSQL instances are retained. Apache was
configuration-tested and gracefully reloaded. Its pre-existing overlapping
phpPgAdmin Alias warning was present before deployment and was not modified.

The runtime was installed using the checksum-verified official uv 0.13.6
release and its managed Python distribution. No global PATH or Python symlink
was changed. See [uv's Python installation documentation](https://docs.astral.sh/uv/guides/install-python/).

The API retains one worker and a concurrency limit of 16. UDP retains exact
128-byte packet validation and its 100-replies/second bound. Probe bodies are
not compressed by Apache; research JSON compression remains in FastAPI.
API access logs are disabled. Apache error logs use its existing log rotation;
service output goes to the existing journal with per-service rate limits.
The host's memory cgroups report limits of 512 MiB for the API and 64 MiB for
UDP. Systemd memory accounting is disabled, so `MemoryCurrent` is unavailable;
the API process used approximately 79 MiB RSS at inspection. No deliberate
out-of-memory or load test was run on the shared machine.

## Credentials and authentication

The user explicitly authorized moving the runtime database credential and the
`api.hailemariam.com` TLS certificate/private key to this shared server. Other
root administrators can access them. Database-administrator and Supabase
service-role credentials were excluded. Public Supabase configuration and the
existing dashboard origin allowlist were retained.

The database URL uses `sslmode=verify-full` and the public CA at
`/opt/skymeasure/current/deploy/certs/supabase-prod-ca-2021.crt`. Change this
query parameter with a URL parser: its original path is percent-encoded.
Do not print or shell-source the environment file; it uses systemd-compatible
quoted values. CLI checks should run via `runuser -u skymeasure` with the
protected environment loaded by a root launcher, rather than inheriting root's
PostgreSQL client-certificate defaults.

Legacy ingestion remains disabled. Identity deletion remains unconfigured,
as on DigitalOcean; this move does not enable the service-role-dependent worker.

## DNS and certificate cutover

1. Verify the replacement before changing DNS:

   ```sh
   backend/.venv/bin/python scripts/verify-deployment.py \
     --ip 23.235.205.53 --region lab-location-unconfirmed
   ```

   This keeps HTTPS hostname/certificate verification enabled while connecting
   directly to the proposed IP. It downloads 1 MiB, uploads 256 KiB, sends 20
   valid UDP probes, checks invalid UDP rejection, checks dashboard CORS, and
   checks unauthenticated/invalid-token rejection. It does not authenticate a
   real participant or write research records.

2. In GoDaddy, change only the `api` A record from `142.93.34.57` to
   `23.235.205.53`. Do not change the apex domain, mail records, or unrelated
   subdomains. There was no API AAAA record at inspection. A future AAAA record
   must point to a verified IPv6 service or it can bypass the intended endpoint.

3. Verify public DNS and `https://api.hailemariam.com/health`. Its region should
   become `lab-location-unconfirmed`. Cached answers may still reach London.

4. On the lab server, start `skymeasure-cert-renew.service`. The isolated
   renewal script obtains a new domain certificate only once DNS resolves
   exclusively to this host. Before that it retains the transferred certificate,
   valid through 21 January 2027. Certificate issuance and renewal use the
   existing `/opt/certbot-venv/bin/certbot`, without touching other domains.
   The deploy hook checks the key pair, retains the previous pair, tests Apache,
   and gracefully reloads it. Run a renewal dry run after initial issuance:

   ```sh
   /opt/certbot-venv/bin/certbot renew --dry-run \
     --config-dir /etc/skymeasure/acme \
     --work-dir /var/lib/skymeasure/acme-work \
     --logs-dir /var/log/skymeasure-acme
   ```

5. Open the dashboard with real Google sign-in and verify existing sessions.
   No Vercel environment or Google OAuth change is needed for the same API URL.

## Android update is required for UDP

The current app bundles a literal UDP IPv4 address. DNS changes migrate HTTP
and account synchronization, but **do not migrate UDP on existing builds**.
Rebuild with these public settings in the ignored `.env.skymeasure.local`:

```dotenv
SKYMEASURE_API_URL=https://api.hailemariam.com
SKYMEASURE_PROBE_URL=https://api.hailemariam.com
SKYMEASURE_UDP_IPV4=23.235.205.53
SKYMEASURE_PROBE_REGION=lab-location-unconfirmed
```

Keep the existing Supabase settings. Generate configuration with
`npm run skymeasure:configure`, build the ARM64 release APK for the test phone,
and restore the checked-in configuration placeholders afterward. The existing
development signing key must match the installed build. Stop collection before
updating; use `adb install -r`, never uninstall or clear app data.

The current configured artifact is `android/app/build/outputs/apk/release/app-release.apk`.
It is a pilot build with development signing, not a Play Store release.
The ARM64 build passed on 31 October; inspection of the packaged JavaScript
confirmed the lab IP and region, and absence of the old UDP IP. Its SHA-256 is
`c5f64d1b29e53d2b11624c8c230fec106e96969ed71103d5bb28cf84098997dc`.
No phone was attached during this deployment, so the APK has not yet been
installed or exercised on the physical phone.

Run a short session with HTTP and UDP enabled, verify the new IP/region in the
session configuration, and confirm it uploads and appears on the dashboard.
Check pending uploads before retiring the old server. Google ICMP/TCP/traceroute
targets and the underlying measurement libraries are unchanged.

## Validation and recovery

Pre-switch checks passed:

- Mac backend tests: 35 passed, 1 PostgreSQL-only test skipped.
- Isolated lab backend tests: 33 passed, 3 skipped (two private dataset fixtures
  remain on the Mac; one test requires a dedicated PostgreSQL test database).
- External HTTPS certificate validation, exact download/upload sizes,
  uncompressed probes, CORS, 401 authentication rejection, and disabled legacy
  ingestion.
- UDP: 20/20 exact replies; invalid payload received no reply. This is a smoke
  test, not a long-run reliability claim.
- Read-only Supabase connection as the service user: 3 sessions, 3,383 records,
  and 15,063 samples at inspection. No original records were copied locally.
- Existing Apache, MySQL, PostgreSQL, transcription, dashboard, and PM2 services
  stayed active. Existing website HTTP status codes matched their baseline.
- HTTP redirects to HTTPS with status 308. The ACME challenge path bypasses the
  redirect. Renewal timer setup passed; actual issuance and renewal dry run
  await DNS cutover.

The server's SFTP subsystem closed the file-transfer connection. Deployment
used SSH streams instead; no SFTP or SSH configuration was changed.

Inspect only SkyMeasure services with:

```sh
systemctl status skymeasure-api skymeasure-udp skymeasure-cert-renew.timer
journalctl -u skymeasure-api -u skymeasure-udp --since '10 minutes ago'
curl --fail http://127.0.0.1:18000/health
```

For rollback, restore the `api` A record to `142.93.34.57`; keep DigitalOcean
running until phone and dashboard validation is complete. Restoring an old
phone build/configuration is also necessary to return UDP to DigitalOcean.
Both APIs use the same Supabase tables, so there is no divergent database to
merge. Do not delete the lab deployment or change unrelated services as part
of rollback. Do not destroy the Droplet until explicitly authorized after
validation; powering it off alone does not end compute billing.

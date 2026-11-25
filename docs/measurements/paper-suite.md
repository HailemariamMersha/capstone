# Paper-inspired suite — pilot 1.3.0

New trips record `measurementSuiteVersion=paper-core-v1`, policy `flight-paper-core-2026-11-25` and consent `skymeasure-paper-core-2026-11-25`. This is a private, unrooted Android implementation inspired by *From GEO to LEO: First Look Into Starlink In-Flight Connectivity*. Ground tests do not establish flight accuracy. Existing trips keep their original policies and raw records.

## What changes

Minute-level ICMP, UDP echo and TCP connection tests remain. One normal-duration M-Lab NDT7 pair remains automatic after the combined disclosure, with the existing four-attempt rolling 24-hour quota. New trips do **not** schedule controlled fixed-size download/upload pairs, loaded latency or HTTP RTT. Their historical implementations and exports remain for reproducibility.

There are five independent traceroute targets: literal `142.250.190.238`, `google.com`, `facebook.com`, literal `1.1.1.1` and literal `8.8.8.8`. A literal address avoids DNS changes but does not freeze routing or Google's service ownership indefinitely. A domain resolves once through the selected Wi-Fi and pins that IPv4 for the attempt. Requested target, target ID, resolved address and resolution duration are separate fields. Twenty hops, three UDP probes per hop, sequential library probing and the existing 45-second trace deadline remain. Library terminal labels are qualified evidence, not independently decoded proof of a route.

Two methods are added:

| Method | Library and request | Result |
| --- | --- | --- |
| Resolver discovery | Android LinkProperties plus OkHttp 4.12.0; HTTPS GET `https://<random32hex>.test.nextdns.io/` | Configured DNS server IPs separately from NextDNS's reported recursive resolver, status and private DNS state. `value=null`: HTTP duration is not DNS RTT. |
| CDN comparison | OkHttp 4.12.0 EventListener on the selected Wi-Fi | Identical public object fetched from five providers; DNS/TCP/TLS/header/body/total observations, body bytes, digest and cache/edge headers. Primary value is successful total duration in ms, not Mbps. |

The shared registry is [`src/measurements/paperSuite.ts`](../../src/measurements/paperSuite.ts). Android's JSON asset is generated from it during the build; the pilot builder checks that the packaged asset matches the source and that the policy is in the Hermes bundle. The baseline imports the same registry. Update it with a new suite version when changing object, target or method semantics.

## Identical CDN object

All URLs select jQuery 3.6.0 minified, 89,501 bytes. Successful comparison requires HTTP 200, complete body and SHA-256 `ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e`.

| Provider ID | URL |
| --- | --- |
| google | `https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js` |
| cloudflare | `https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js` |
| microsoft | `https://ajax.aspnetcdn.com/ajax/jQuery/jquery-3.6.0.min.js` |
| jsdelivr | `https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js` |
| jquery | `https://code.jquery.com/jquery-3.6.0.min.js` |

Each request uses a fresh HTTP/1.1 connection, an IPv4 from the selected Wi-Fi resolver and `Accept-Encoding: identity`. The adapter disables connection reuse, cookies, application cache, proxies, redirects and retries. It does **not** flush Android DNS or TLS caches, send `Cache-Control: no-cache`, or add CDN cache-busting parameters. CDN edge caching is part of the observation. A captive page, redirect or changed object is an explicit failure; partial bytes remain evidence. Downloaded content is hashed/streamed and discarded, not saved in research records.

The HTTP adapter is custom glue around OkHttp's DNS/socket/EventListener APIs. It is not an application-owned raw-packet engine and adds no kernel collection. This choice gives separate HTTP phases unavailable from React Native fetch; the existing ICMP/UDP/TCP/traceroute libraries remain.

## Timing and blanks

Trip start/end/qualification times are Unix epoch milliseconds; session/measurement wall times are ISO-8601 UTC strings. Native timestamps use Android's monotonic elapsed-realtime nanoseconds. Event offsets remain decimal strings in raw callbacks, avoiding JavaScript integer rounding. Callback wall times are UTC placement evidence and must not be subtracted from monotonic offsets. No values are hardware transmission or kernel packet timestamps.

| Field | Definition |
| --- | --- |
| `dnsLookupMs` | `dnsEnd − dnsStart`; may include an OS cache lookup, not authoritative DNS RTT. |
| `tcpConnectMs` | `secureConnectStart − connectStart` for HTTPS, excluding TLS. Absent if that interval did not complete. |
| `tlsHandshakeMs` | `secureConnectEnd − secureConnectStart`; no guarantee of a cold TLS session. |
| `responseHeadersAfterMs` | `responseHeadersEnd − attemptStart`; cumulative. Do not add it to DNS/TCP/TLS. |
| `bodyReadMs` | `responseBodyEnd − responseBodyStart`; library read interval, including partial close where supplied. |
| `totalMs` | Native snapshot time minus attempt start; includes adapter processing. Failed attempts can retain it but have no successful primary result. |

Blank/null means unavailable or not applicable; zero remains a valid observation. Cache headers and parsed edge codes do not establish a city. Unknown recursive resolver IP stays null, even when the discovery request succeeds. NextDNS `status=unconfigured` is a normal response, not an app failure. Configured DNS may be a router forwarding to a different recursive service. Resolver coordinates are neither collected nor inferred.

## Schedule and allowances

Rounds start at the first qualification, persist across fifteen-minute upload segments, and rotate the five-target/provider order each round:

| Offset in each round | Job |
| --- | --- |
| +30 s | Resolver discovery |
| +1, +3, +5, +7, +9 min | Five traceroutes |
| +4, +6, +8, +10, +12 min | Five CDN fetches |

The measurement worker is serialized; identity/control continue in their existing asynchronous lane. The earliest eligible scheduled job runs first. CDN/M-Lab retain sixty-second spacing after a heavy job. A job must fit its timeout plus a two-second cleanup margin before a segment boundary. Jobs more than ninety seconds late expire with an event instead of catching up. Upload pauses do not reset rounds, qualification, budgets or M-Lab quota. HTTP jobs wait for validated selected Wi-Fi; no cellular fallback is allowed. DNS worker stragglers retain native ownership until cleanup; no new paper request overlaps them.

The existing 60 MiB transfer allocation now accounts for CDN content on paper-policy trips. The wire field `used.transfers` is retained to preserve protocol compatibility; consult policy before interpreting it. Native observed body bytes are charged when known; a dispatched result with uncertain progress or an orphaned reservation charges the 512 KiB ceiling. Proven-unsent attempts cost zero. Durable local reservations prevent oversubscription without decreasing monotonic server counters. The 20 MiB diagnostics/context and 20 MiB live-upload allocations remain separate. These are application payload allowances, excluding unobservable overhead/retransmissions and post-trip sync. M-Lab remains separate and uncapped in the private pilot. No new paid service or Ookla dependency is added.

CDN deadline/body ceiling: 90 seconds / 512 KiB. NextDNS: 20 seconds / 16 KiB. Only allowlisted URLs can be dispatched by the native adapter. Headers are bounded/allowlisted; cookies, authorization, redirect query strings, NextDNS profile/client names and response bodies are excluded. A fresh random DNS label contains no participant ID. Third parties see public IP and request time, disclosed in the new consent. No GPS coordinates, kernel TCP state, raw socket engine or unrelated traffic capture is introduced.

## Researcher views and validation

The dashboard groups trips and segments as before. Evidence filters include target ID and CDN provider. Target comparisons show successful timing-valid phase medians per provider, resolver history distinguishes configured from observed DNS, and CDN completion charts keep targets separate. Totals count parent attempts once. Combined CSV retains prefixed `measurement.paper.*` fields and suite metadata; raw JSON preserves callback detail. `cdn.csv` and `dns.csv` provide small parent-attempt views in phone bundles and offline analysis; traceroute views include target/resolution/round identifiers. The [dictionary](columns.md) defines every field and missing-value meaning.

For an independent Linux reference, use the [validation harness](validation.md) on the **same Wi-Fi**, without VPN, with synchronized clocks. `npm run baseline:run -- --duration 35m` now defaults to the paper suite, with no M-Lab unless explicitly authorized. It sends real traffic and stores results locally. Historical schedule fixtures specify their original policy. Compare with `npm run baseline:compare` and inspect the target-separated phase medians. curl's cumulative first-byte timing is a different callback scope from OkHttp headers-end; neither is a packet timestamp. Different IPs, shared-link contention, OS DNS/TLS cache, clock drift and loss limit direct comparisons. Mac checks and isolated TLS fixtures are useful but are not a paired Linux/phone accuracy experiment.

No additional regional probe locations, DNS latency benchmark, IRTT, TCP congestion experiments, satellite handover inference or full browser performance is claimed. The original paper's rooted tools and controlled experiment conditions remain distinct.

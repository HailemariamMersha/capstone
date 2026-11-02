# Automatic trip measurements — pilot policy flight-2026-11-01

Start arms one trip; it does not assert that an aircraft is airborne. Optional flight number, departure, arrival and expected length are participant-reported. Expected length changes transfer spacing, never the ending time. The first enrollment needs internet; subsequent collection can start offline.

## Evidence and timing

The detector evaluates ASN, airline SSID and derived location approximately every 30 seconds. Serial probes can delay evaluations; timestamps are actual observations, not guaranteed sampling times. Two positive signals on evaluations at least 30 seconds apart qualify collection. ASN + SSID is **network-only**. GPS plus either network signal is **GPS-supported**. Neither verifies a commercial flight. GPS alone never qualifies.

ASN observations expire after 120 seconds; location fixes expire after 60 seconds. Missing, stale, denied, mocked or invalid fixes are unknown, never zero. A positive GPS signal requires valid altitude >3048 metres, speed >128.611 metres/second, horizontal accuracy <=200 metres, and a fresh non-mocked fix. Android altitude is WGS84 ellipsoid altitude, not mean sea level. A cabin barometer is not used. Only derived altitude, speed, accuracy, fix age and decision evidence leave the location boundary. Latitude, longitude and native extras are discarded.

SSID rules: QatarWiFi, EmiratesWiFi, FlyFi, EtihadWi-Fi, AirFranceWi-Fi and KLMWiFi, anchored and case-insensitive. Provider seeds: Starlink AS14593, Inmarsat AS31515, Intelsat AS22351, Panasonic AS64294, SITA AS206433, ViaSat AS40306. Registries are incomplete and can change; these names do not establish flight status. VPN attribution is unsupported; the app pauses rather than bypassing an active VPN.

After qualification, internet/GPS failure on the same Wi-Fi retains packet attempts. Wi-Fi loss/change pauses collection. The ten-minute grace applies only after first qualification. Five minutes of valid low speed (<=30m/s) after airborne GPS evidence is an ending inference. Watching at home does not expire at ten minutes. Stop, 15% battery when not charging, and a 24-hour ceiling are additional safeguards. Reopening after process interruption closes/reconciles partial evidence; force-stop or reboot never promises automatic rearming.

## Schedule and accounting

Ten ICMP probes, twenty 128-byte UDP probes and one TCP attempt run approximately each minute. A traceroute, capped at twenty hops with three probes/hop, is scheduled each fifteen minutes. Tests are serial. All existing library limitations and ambiguous icmpenguin traceroute labels remain applicable.

Transfer pairs use decimal 5,000,000-byte download and 1,000,000-byte upload payloads. First pair: five minutes after qualification. Subsequent interval: max(5 minutes, expected flight length/10); default expected length: 24 hours. At most ten pair reservations. Missed opportunities are skipped, not replayed. Failed/cancelled reservations are not refunded. An underestimated flight can exhaust throughput sampling early. These short controlled transfers are not Ookla or a comprehensive link-capacity estimate.

Per-trip allocations: 60 MiB transfers, 20 MiB probes/context, 20 MiB live uploads. No segment restart resets these counters. Exhaustion affects that activity only. Context lookups reserve 2048 bytes; live requests reserve serialized UTF-8 request bytes plus a conservative 64 KiB response allowance. These deliberately overestimate normal response payloads and include retries. They do not measure carrier-billed traffic, TCP/TLS/IP overhead, retransmissions, authentication traffic or all in-flight bytes. Initial enrollment and post-trip uploads are additional traffic. Unsent raw evidence remains in SQLite; it is never discarded to fit an upload allowance.

Fourteen-hour probe estimate, assuming all requested replies: 840 * (10*64*2 + 20*128*2) + 56*(20*3*32*2) = 5,591,040 bytes = 5.33 MiB, excluding context, headers and retransmissions. This is a planned payload calculation, not a measured cellular/Wi-Fi byte counter.

## Trips, segments and joins

One trip contains ordered segments, implemented as existing immutable closed sessions. Every fifteen minutes the app closes the current segment, attempts uploads for at most 25 seconds, then opens the next segment. Detection, transfer deadlines and cumulative budgets remain trip-owned. `upload_pause` events describe deliberate observation gaps. Offline/failed uploads remain queued; there is no collection/upload overlap.

Trip revisions are monotonic. A closed trip states its expected segment count; only reconciled segments satisfy completeness. Collection completion, upload completion and successful probes are independent facts. Interrupted observations are valid partial evidence, not automatically failed measurements. A received trip reports only its last transmitted state; it does not prove a phone is currently active. Segments with no measurements can still contain useful detector evidence.

Combined CSV repeats session/trip context on each sample. Sum measurement values by unique measurement ID, and trip budgets by trip ID, never by sample rows. Historical sessions have no trip fields. Raw session JSON retains complete configuration, detector events, snapshots and original library responses. Missing new columns mean unavailable or historical, never zero. The shared column dictionary includes these additions.

## What these measurements do not establish

- Ellipsoid altitude is not sea-level altitude, cabin pressure altitude or a verified flight level.
- ASN/SSID matching is not proof of aircraft motion or provider exclusivity.
- A Starlink PTR/PoP code change is an observed egress-name change, not proof of satellite or physical gateway handover. Unknown codes/formats remain unknown; no city is guessed.
- GPS loss is not landing. A termination rule is an inference, not a verified arrival event.
- App/bridge callbacks and library RTTs are not kernel timestamps or complete packet capture.
- Ground simulations and shadow tests are not real-flight validation. No comparative reliability or detection accuracy is claimed by unit tests.

The geolocation patch is owned in `patches/@react-native-community+geolocation+3.4.0.patch`. It exposes validity/accuracy/monotonic fix age and uses the host's Android Gradle plugin. `patch-package --error-on-fail` must pass on every clean install; upgrades require reviewing and rerunning native and privacy tests.

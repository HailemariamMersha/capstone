# Automatic trip collection: ASN-only qualification

Current detector: `asn-only-v1` (pilot 1.1.5). Budget policy remains `flight-mlab-2026-11-02`; consent remains `skymeasure-flight-mlab-2026-11-02`. The detector version is separate from the allowance and consent versions. Historical records keep their original meaning.

## What starts collection

Start trip arms monitoring on the selected, process-bound Android Wi-Fi network. Flight number, departure, arrival and expected length are optional participant reports, not verified flight information. Expected length changes transfer spacing, never the stop time.

Only a fresh provider ASN match can qualify a connection. The configured registry is Starlink AS14593, Inmarsat AS31515, Intelsat AS22351, Panasonic AS64294, SITA AS206433 and ViaSat AS40306. This is an incomplete provider allowlist, not an authoritative list of aircraft networks. A positive match means **provider-matched connectivity**, including possible ground use; it does not establish that a phone is airborne.

The server observes the request's public address through its trusted proxy and looks up GeoLite2-ASN. The phone refreshes identity approximately every minute, expires observations after two minutes, and invalidates them when the selected Wi-Fi handle changes. Lookup timeout is ten seconds, with a fifteen-second failure retry. Lookup failure is unknown, not a nonmatching ASN. ASN must be a positive 32-bit integer; invalid values are unknown. VPN attribution is unsupported; the app pauses rather than bypassing an active VPN.

The control lane evaluates every thirty seconds and on network changes. Two positive evaluations at least thirty seconds apart admit collection on that same Wi-Fi handle. Each observation records ASN state, reason, observation time, `confidence=asn_matched` and `detectorPolicyVersion=asn-only-v1`. Confidence describes the current evidence, not whether the trip ever qualified. A newly enrolled installation needs connectivity; an existing identity can arm monitoring offline, but cannot initially qualify without ASN evidence.

SSID is optional context and cannot qualify a connection. Automatic trips no longer request GPS fixes or require location permission. Android location permission and enabled system Location can still be needed for optional Wi-Fi identifiers; missing identifiers remain null and do not prevent binding. The geolocation library/patch remains for legacy diagnostic code and historical interpretation, not automatic trip qualification.

## Pausing and ending

After qualification, an unknown/stale ASN on the **same** selected Wi-Fi retains packet attempts so outages remain observable. These periods are explicitly unconfirmed. A fresh nonmatching ASN clears qualification and pauses collection. A different Wi-Fi handle, even with the same SSID, requires qualification again. Captive portals remain connectivity limitations. Wi-Fi binding must be validated separately per protocol; simulation/unit tests alone cannot establish physical routing.

The ten-minute disconnection grace starts only after first qualification and covers loss of qualifying connectivity. Watching at home does not end after ten minutes. Stop, battery at or below 15% while not charging, or the 24-hour safety ceiling also end collection. GPS speed no longer ends an ASN-only trip. No ending claims a verified landing. Reopening after process loss preserves interrupted evidence and requires Start for new collection; force-stop/reboot does not promise automatic rearming.

Researcher shadow mode bypasses qualification for explicitly labelled ground tests, while recording the detector's actual decisions. It must not relabel a home connection as an in-flight connection.

## Schedule and allowance

Measurements remain serial: ten ICMP probes, twenty 128-byte UDP probes and one TCP connection approximately every minute; a twenty-hop, three-probe-per-hop traceroute first after one minute and then every fifteen minutes. The independent control lane continues detection and snapshots during long measurements. Actual execution and callback times, planned deadlines, gaps, cancellations and segment health remain observable; this is not a guaranteed wall-clock cadence. See [collector reliability](../skymeasure/collector-reliability.md).

Controlled HTTP pairs use decimal 5,000,000-byte download and 1,000,000-byte upload. First pair: five minutes after qualification; later spacing: max(five minutes, expected length / ten), default expected length twenty-four hours. At most ten pair reservations. Late opportunities are skipped, with no catch-up burst. Failed/cancelled reservations are not refunded; two consecutive failures disable that controlled direction. An underestimated flight can exhaust throughput sampling early. These short transfers are not Ookla or a comprehensive link-capacity test.

One automatic M-Lab NDT7 pair is scheduled with a saved one-to-three-minute delay after qualification, waiting for validated selected Wi-Fi. It has a 200 MiB reservation within the trip allocation and a 90 MiB cap per direction; capped/partial tests do not receive a valid completed speed. Its publication disclosure is part of onboarding. See [automatic M-Lab](../skymeasure/automatic-mlab.md). Controlled transfers are spaced away from its actual finish.

The per-trip 300 MiB application-accounted allowance comprises 260 MiB transfers (200 MiB M-Lab + 60 MiB controlled), 20 MiB probes/context and 20 MiB live uploads. Segment boundaries never reset these counters. Exhausting an allocation disables only that activity. Identity requests reserve 2048 bytes; live uploads reserve serialized UTF-8 request bytes plus a conservative 64 KiB response allowance, including retries. This is not carrier-billed traffic: transport headers, retransmissions, authentication and post-trip uploads are additional/unobserved traffic.

The fourteen-hour probe payload estimate is 840 × (10×64×2 + 20×128×2) + 56×(20×3×32×2) = 5,591,040 bytes = 5.33 MiB. It excludes detection, context, headers, retransmissions and uploads; it is a model, not a measured interface counter. Loaded-latency tests are off for automatic trips.

## Trips, segments and exports

One trip contains ordered closed measurement sessions. Every fifteen minutes, the current implementation stops scheduling, cancels outstanding probe work if needed, closes the segment and attempts uploads for up to twenty-five seconds before opening the next segment. The foreground service and detector remain active. Qualification, budgets and transfer deadlines belong to the trip. `upload_pause` and scheduling events expose intentional gaps. A proposed scheduler using dedicated measurement blocks is not implemented here.

Trip revisions are monotonic; a closed trip declares its expected segment count. Upload completeness requires reconciliation of all those segments. Collection completion, upload completeness and successful measurements are independent. Received state is only the phone's last report, not a live presence indicator. Interrupted records remain valid partial evidence. Segments with no measurements may still contain detector evidence.

Raw JSON preserves configuration, original library responses, snapshots and events. New manifests carry `detectorPolicyVersion`; combined CSV carries `session.detectorPolicyVersion` and the observation's `measurement.networkSnapshot.flightEvidence.detectorPolicyVersion`. Historical records are not relabelled. Their `network_only` and `gps_supported` tiers refer to the former two-of-three detector. Historical derived altitude is WGS84 ellipsoid altitude, not sea-level altitude. Repeated context is not a fresh per-packet reading. Sum parents by unique measurement ID and allowances by trip ID, never by repeated sample rows. Missing values are unavailable, not zero. See the [dictionary](columns.md).

## Limits of the evidence

ASN matching cannot establish a flight, airline, exclusive provider or aircraft movement. Provider registry coverage needs real-flight validation. A Starlink reverse-DNS/PoP change is an observed egress-name change, not a proven satellite or gateway handover. No coordinates or raw location objects may enter persisted/exported records. App/library callbacks are not kernel timestamps or complete packet capture. Ground shadow tests and synthetic signals test software behavior, not detection accuracy or comparative reliability.

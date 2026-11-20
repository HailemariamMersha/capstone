# Physical-phone ground validation — 21 November 2026

## Conditions and scope

SkyMeasure private pilot 1.2.3/code 11 ran on one Samsung Galaxy A34 (SM-A346E). The selected Wi-Fi reported AS5384 / Etisalat. Both trips used the ordinary ASN detector and retained ground-test labels; neither is evidence of an airborne flight. Required flight details and a separate administrator-only NetID mapping were present. New-trip configuration omitted expected duration and recorded `hourly-v1`. This is a functional collection/upload check, not an independent accuracy benchmark.

The overnight trip was already recording when the phone was connected for inspection. It was stopped at the participant's request, preserved, and analyzed before a fresh synthetic ground trip was started. Existing measurements were not deleted or edited. The collector is stopped and Wi-Fi was restored at the end of this check.

## Measurement results

| Measurement | Overnight ground trip | Fresh ground trip |
| --- | --- | --- |
| Duration | 11 h 17 min 56 s | 9 min 58 s |
| Locally saved segments | 46/46, no missing index | 1/1 |
| Parent measurements | 2,078; five unsuccessful | 32; all successful |
| ICMP echo | 6,650/6,750 replies; median 34.269 ms | 90/90 replies; median 20.032 ms |
| UDP echo | 13,053/13,500 replies; median 286.576 ms | 180/180 replies; median 208.844 ms |
| TCP connections | 675/675 succeeded; median duration 43.132 ms | 9/9 succeeded; median duration 26.024 ms |
| Traceroute | 46/46 library-reported destinations reached | 1/1 library-reported destination reached |
| Controlled download | 0/2; both timed out | 5,000,000 bytes completed; 3.328 Mbps, 12.018 s |
| Controlled upload | 1/3; two timed out | 1,000,000 bytes completed; 3.557 Mbps, 2.249 s |
| M-Lab download | Completed: 79.037 Mbps | Completed: 130.851 Mbps |
| M-Lab upload | Network error; no valid speed | Completed: 103.195 Mbps |

Echo denominators count recorded individual probes, not successful parent bursts. An ICMP/UDP burst can succeed while containing lost probes. The TCP duration includes the library connection/callback path and is not a kernel-only SYN RTT. Traceroute reachability and intermediate error labels are library classifications, not verified raw ICMP type/code observations.

The fresh M-Lab pair recorded 171,966,464 download client bytes and 136,028,160 upload client bytes: approximately 293.73 MiB total client payload. These counters exclude transport overhead and are not carrier-billed traffic. Upload headline Mbps uses receiver-side server counters, not the generic client-byte/duration ratio. The controlled HTTP rates describe fixed-size completion through the lab endpoint; they are not interchangeable with M-Lab capacity results.

The overnight controlled directions were disabled after two consecutive failures, as the recorded policy specifies. There were three pair reservations; retained download byte observations on timeout were 904,960 and 388,800 bytes. Later absence of these transfers is therefore not evidence of missing exported records or a failure of hourly deadline persistence. First and second download attempts were one hour apart.

## Offline stop, retry and reconciliation

The fresh trip ran long enough to include its first controlled pair. Wi-Fi was disabled for 28.457 seconds. The app displayed its paused Wi-Fi state; Stop closed the trip while offline. Wi-Fi was restored and no Retry uploads button was pressed. Upload preference remained Wi-Fi-first.

All 225 expected records reached the server with matching IDs and versions: 32 measurements, 123 events, 69 contexts and one session. There were no missing expected versions. The server marked the segment complete, and the final phone check showed upload status **Uploaded**, all 225 queue entries acknowledged, and trip revision 77 acknowledged as revision 77. The separate NetID payment mapping was also acknowledged; no NetID values were put in the exports or this report.

Completion took approximately 855.1 seconds (14.25 minutes) after Wi-Fi restoration. The owner also had large older backlogs. Intermediate snapshots showed 200/225 received records and, later, 225 acknowledged records awaiting completion. The apparent stall did not require deleting records, resetting identity, pressing Retry or manually changing the server's completion flag. Its latency warrants a separate performance investigation; the precise contribution of backlog scheduling, preflight requests and request deadlines has not been isolated.

Read-only instrumentation restarted the stopped app during diagnosis, and the app was manually reopened. It restarted it again for the final durable-acknowledgement check. This demonstrates network-restoration and app-open/foreground retry paths; it does not establish uninterrupted closed-app finalization or Android force-stop/reboot behavior.

The overnight trip's complete local archive was preserved. Its server copy was still partial when first inspected; the fresh trip's complete reconciliation must not be generalized to every older pending trip.

## Background and power evidence

The overnight run recorded 1,952 heartbeats. Of these, 1,933 reported the screen non-interactive, 1,946 reported the app backgrounded, and 1,281 reported device idle. Battery optimization exemption was enabled throughout the recorded heartbeats. Maximum heartbeat spacing was 54.122 seconds and no `collector_gap` event was recorded. This supports continuity on this phone with its exemption enabled, not a multi-device endurance claim.

Snapshots recorded 3,997 `isCharging=false` and 27 `isCharging=true` readings, with observed battery percentages from 93 to 100. **False does not establish unplugged operation:** the installed device-info library tests `BATTERY_STATUS_CHARGING` only; a full plugged-in phone can return false. Future power validation should record the existing library's power-state distinction (`unplugged`, `charging`, `full`) and maintain a controlled unplugged reference condition. The initial live commentary's unplugged interpretation was corrected after inspecting that implementation.

## Sanity checks and limitations

The offline analyzer audited all 46 overnight segments: 2,078 parent measurements, 22,458 observations/callback samples, 7,070 events and 4,024 contexts. It reported zero errors, 1,301 qualified traceroute-label warnings and two unavailable focused views. These samples are not 22,458 captured IP packets. The fresh-session analyzer reported zero errors, 26 equivalent traceroute-label warnings and two unavailable views. Coordinate/NetID keys were absent from the fresh measurement export.

The two runs differ in duration, timing, screen/power conditions and network conditions. Their HTTP and M-Lab differences do not establish comparative reliability or identify a single cause for the overnight failures. No Linux reference, gateway capture, controlled netem scenario or real-flight trial was performed here. Captive-portal/cellular coexistence, other manufacturers, default battery settings and closed-app background delivery remain separate acceptance checks.

Original datasets, detailed queue receipts and generated per-protocol CSVs remain private under `build/phone-validation-2026-11-21/`. The public repository report contains aggregate results only. Read-only Android test helpers were extended to export every segment of a selected stopped trip and sanitized queue state; collection algorithms and recorded evidence were unchanged.

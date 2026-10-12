# Library-only phone test with working UDP — 12 October 2026

The existing library comparison APK completed a two-minute experiment on the Samsung Galaxy A34 (Android 13). **All 12 measurement attempts succeeded, including 20/20 matching UDP echoes.** No application code or native socket implementation was added to make UDP work.

## UDP setup and preflight

At the start of this task, no Mac process was listening on UDP port 9876. The Mac application firewall was already disabled and the VPN already disconnected; neither setting was changed. The UDP service is separate from Uvicorn and must be started explicitly.

The bounded echo service was started on port 9876 with the phone's current Wi-Fi IPv4 address allowed as a `/32` source. The phone and Mac were on different campus subnets but could communicate through the gateway. The Mac's return route used `en0`, unlike the VPN route observed during earlier investigation.

Before starting the app experiment:

- The service returned exact 128-byte echoes through both Mac loopback and the Mac Wi-Fi address.
- Android shell ping received 2/2 replies from the Mac.
- Android's Toybox UDP client sent one protocol-valid 128-byte payload and received the identical payload from port 9876. This preflight is separate from the app's recorded twenty-probe burst.

These checks establish a working path today. They do not isolate the cause of every timeout in the older experiments, when routing conditions differed. No firewall opening was required on this Mac.

For another run, obtain current addresses with `adb shell ip -4 addr show wlan0` and `ipconfig getifaddr en0`. From the repository root, start the service in its own terminal, substituting the phone address:

```sh
backend/.venv/bin/python -m backend.udp_echo \
  --host 0.0.0.0 --port 9876 --allow PHONE_IPV4/32
```

Set the app's UDP host to the **Mac Wi-Fi IPv4 address**, port **9876**. `adb reverse tcp:8000 tcp:8000` is for HTTP/sync only; it does not forward UDP. A changed phone address requires updating the service allowlist. `lsof -nP -iUDP:9876` verifies the listener, but only an actual echo verifies end-to-end reachability.

## Configuration and identity

- Stored UTC interval: **2026-10-12T07:30:16.934Z–07:32:17.228Z**, or **11:30:16–11:32:17 Asia/Dubai**; duration **120.294 seconds**.
- Automatic stop reason: `duration`. All 12 scheduled attempts completed; the service was stopped after completion.
- HTTP enabled; ICMP bursts, TCP, UDP echo, traceroute and loaded download/upload latency enabled.
- Google targets for ICMP/TCP/traceroute; Mac Wi-Fi UDP echo; HTTP and sync through USB forwarding to the local Mac server.
- **50 MiB upload and download**, with standalone and loaded transfers: **four transfers, 200 MiB total application transfer payload**. Session allowance: 512 MiB; actual reserved allowance including probes: 209,726,912 bytes. These exclude protocol overhead.
- After startup the app was moved to the home screen. The foreground service remained active while the screen showed the launcher. This tests short background operation, not locked-screen/Doze or long-run endurance.
- Installed APK SHA-256 matched the local release: `8f770f0edfc3637f66cd41e75c980fb66135e182e13c0f16ad41753c302d7227`.
- The APK contains `libicmpenguin.so` and **no `libcapstonepacket.so`**. Kotlin adapters expose library results; the application-owned C++ engine is not installed.

## Results

| Measurement / library | Observed result |
| --- | --- |
| ICMP — `icmpenguin` 1.0.0-rc.3 | **20/20 replies**, pooled median **17.570 ms**. All replies retained a 72-byte ICMP message with decoded echo header and 64-byte payload. |
| TCP — `react-native-tcp-socket` 6.4.3 | **2/2 successful connections**, **36.846 ms** and **27.089 ms**; library callback timing, not kernel RTT. |
| Traceroute — `icmpenguin` 1.0.0-rc.3 | Destination reached at **hop 11**. 33 samples: 27 library `host_unreachable`, four timeouts, two destination `port_unreachable` classifications. |
| UDP echo — `react-native-udp` 4.1.7 | **20 sends, 20 matched replies; 0% non-response, zero duplicates and reordered replies**. Median **18.103 ms**, p95 **178.300 ms**, mean absolute successive difference **50.182 ms**. |
| HTTP RTT — React Native fetch | Two successful transactions, **65.916 ms** and **19.539 ms**. |
| Standalone download — RNFS 2.40.3 | Exactly **50 MiB**, **263.578 Mbit/s**. |
| Standalone upload — fetch + TypeScript | Exactly **50 MiB**, **92.009 Mbit/s**. |
| Loaded download | Successful transfer; **five** overlapping HTTP latency samples, median **56.946 ms**. |
| Loaded upload | Successful transfer; **15** overlapping HTTP latency samples, median **17.312 ms**. |
| Background actions 4.1.0 | Experiment progressed while backgrounded and stopped automatically. Seven schedule-gap events, zero skipped intervals; maximum recorded lateness **45.170 seconds**. |
| NetInfo 12.0.1 / device-info 15.0.2 | Three Wi-Fi context snapshots; battery 100%, charging reported false. |
| OP-SQLite 18.2.3 / sync | Saved 12 measurements, 12 events and three snapshots plus the session. **28 records acknowledged, zero pending** on the phone. |

UDP callback retention includes **20 send requests, 20 send confirmations and 20 matched replies**, with zero dropped callbacks. Every decoded received payload is exactly 128 bytes and equals the recorded request for its sequence. All twenty replies were retained, including the higher-latency observations; the maximum was 237.268 ms. These application callback timings include scheduling/bridge overhead, so their variation is not isolated Wi-Fi propagation jitter.

## Exports and interpretation

The saved dataset has **101 sample rows**, 20 packet JSONL records and 107 library request/callback JSONL rows. ICMP source addresses remain correctly unavailable rather than being mislabeled target aliases. Traceroute's original ICMP error type/code and handset TCP_INFO remain unavailable through these library paths.

The offline analyzer found **zero consistency errors**, 29 warnings for ambiguous traceroute labels, and 22 unavailable checks (20 missing monotonic ICMP timestamp pairs and two missing TCP_INFO records). These limitations are expected and are retained in the report, not converted to zero measurements.

Raw/private artifacts are under ignored local storage:

```text
backend/data/experiments/2026-10-12-library-udp/
  observer-metadata.json
  ingested-records.json
  source-session.json
  export/
  analysis/
```

The source session is reconstructed from acknowledged backend records using the existing sync contract. Exact ingested payloads are retained separately; measurement `state=complete` is added to the analysis envelope for the closed session. Existing phone data was preserved. The original eight-file export and six focused CSVs were generated locally from that saved evidence.

This run validates **library UDP integration over the current controlled Wi-Fi path**. The former absence of replies did not establish a missing UDP-library capability. It does not establish satellite-path reliability or equal performance to the custom engine. HTTP speeds are local USB/server results. ICMP/traceroute still have their documented library limitations, and congestion-window evolution during a transfer remains unimplemented. Public NDT7 and SpeedChecker tests were not run.

/** Source-linked explanations of the current Android collector, not executable examples. */
export interface MeasurementMethod {
  name: string;
  library: string;
  schedule: string;
  how: string;
  request: string;
  appCall: string;
  timing: string;
  calculation: string;
  evidence: string;
  limits: string;
  sources: string[];
  terminal?: string;
}
export const measurementMethods: MeasurementMethod[] = [
  {
    name: 'ICMP echo',
    library: 'icmpenguin 1.0.0-rc.3 through the Android adapter',
    schedule:
      'Ten probes per burst, scheduled every minute after qualification.',
    how: 'TypeScript calls the Android library adapter once per probe. The library sends ICMP echo; this is not an HTTP request. The app verifies the returned echo type/code, sequence and the 64-byte payload before accepting RTT.',
    request:
      'Current target: google.com. Outgoing TTL 64; library probe size 72 bytes = 8-byte ICMP header + 64-byte application pattern. The burst waits for each result, then pauses 250 ms before the next probe; it is not ten probes sent at once. Each burst probe uses at most a 2,000 ms timeout.',
    appCall: `// TypeScript, one probe in the ten-probe burst:
adapter.ping(attempt.id, host, Math.min(timeoutMs, 10000), payload);
// The burst supplies timeoutMs <= 2000 and a 64-character CPSPKT1 pattern.

// Kotlin adapter: the library performs the probing.
Pinger(host = host, ttl = 64, timeout = timeoutMs,
    maxPingCount = 1, interval = 0, probeSize = 72,
    pattern = payload.toByteArray(Charsets.US_ASCII))
    .ping { run.result = encodeLibraryProbe(64, it) }`,
    timing:
      'Individual RTT comes from the library elapsedUsec counter. The enclosing durationMs is the JavaScript burst duration, including adapter work, timeouts and pauses; it is not the individual RTT.',
    calculation:
      'sample.rttMs = result.elapsedUsec / 1000. A successful, complete burst reports the median of valid reply RTTs. Non-response % = 100 × (10 − replies) / 10 only when all ten attempts completed with valid reply/timeout outcomes. Incomplete or other-error bursts leave that percentage unavailable.',
    evidence:
      'details.samples, details.summary, details.nonResponsePercent, sample.packet.response, and raw library callbacks. The returned ICMP message contains type, code, checksum, identifier, sequence and payload bytes; reply TTL is retained only if the library exposes it.',
    limits:
      'Library probe timing is not a hardware/kernel timestamp. Captured bytes are the ICMP message, not a complete outer IP packet. Do not use total burst duration as RTT or substitute the target for an unobserved reply-source address.',
    terminal:
      'for i in $(seq 1 10); do ping -4 -n -c 1 -s 64 -t 64 -W 2 google.com; [ "$i" -eq 10 ] || sleep 0.25; done',
    sources: [
      'src/measurements/icmp.ts',
      'src/measurements/libraryIcmp.ts',
      'src/measurements/icmpBurst.ts',
      'android/app/src/main/java/com/labpracticeapp/diagnostics/LibraryIcmpModule.kt',
      'android/app/src/main/java/com/labpracticeapp/diagnostics/LibraryProbeResult.kt',
    ],
  },
  {
    name: 'TCP connection',
    library: 'react-native-tcp-socket 6.4.3',
    schedule: 'One connection attempt every minute.',
    how: 'Open a TCP socket and stop timing when its connected callback runs. Close the socket immediately afterward. No HTTP request or TLS handshake is performed by this measurement, even when the destination port is 443.',
    request:
      'Current target configuration: https://google.com, interpreted as host google.com and TCP port 443. The scheme supplies the default port; it does not make this a TLS test.',
    appCall: `const url = new URL(serverUrl);
const host = url.hostname;
const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
const started = performance.now();
const socket = new TcpSocket.Socket();
socket.connect({ host, port, connectTimeout: timeoutMs }, () => {
  // finish(null, null) captures this value and destroys the socket:
  const durationMs = performance.now() - started;
});`,
    timing:
      'The clock starts before socket construction/connect dispatch and ends in the successful callback. DNS resolution, native dispatch and callback scheduling can contribute.',
    calculation:
      'connect duration in ms = callback performance.now() − starting performance.now(). The parent value and its single sample use that duration when successful; failed attempts have a null value and a recorded failure duration.',
    evidence:
      'value, durationMs, details.targetPort, details.samples[0].rttMs and raw connection callbacks, including available local/remote addresses and ports.',
    limits:
      'This is connection duration, not isolated SYN RTT, TLS latency, congestion window or kernel RTT. The field named sample.rttMs is a shared schema field; for this test it holds connection duration.',
    sources: ['src/measurements/tcp.ts', 'src/measurements/diagnostics.ts'],
  },
  {
    name: 'UDP echo',
    library: 'react-native-udp 4.1.7',
    schedule: 'Twenty 128-byte datagrams per burst, scheduled every minute.',
    how: 'Bind an IPv4 UDP socket to an ephemeral local port. Send a correlated payload to the controlled echo server, which echoes accepted payloads. Validate sender address/port, length, run nonce, sequence and exact bytes; only the first matching reply contributes RTT.',
    request:
      'Current lab target: 23.235.205.53:9876, supplied through application configuration. Payload format: CPSUDP1:<32-hex run nonce>:<4-digit sequence>: padded with dots to exactly 128 bytes. The next send is scheduled 250 ms after the send callback, independently of waiting for the echo. The final reply grace is min(timeoutMs, 3000 ms).',
    appCall: `const socket = UdpSocket.createSocket({ type: 'udp4' });
socket.bind(0, '0.0.0.0', send);
// packet = udpPacket(nonce, sequence), exactly 128 bytes
sent.set(sequence, { at: performance.now(), timestamp, confirmed: false });
socket.send(packet, 0, packet.length, port, host, sendCallback);
// In the message callback, after endpoint and payload validation:
replies.set(sequence, performance.now() - info.at);`,
    timing:
      'Start each probe timestamp immediately before socket.send. End when the validated message callback is processed. This is application-observed datagram RTT, including dispatch/callback delay.',
    calculation:
      'RTT ms = reply callback time − that sequence’s send-request time. Parent value = median valid RTT for a complete burst with at least one reply. Loss % = 100 × (confirmed sends − unique matching replies) / confirmed sends only for a complete burst; otherwise null. Duplicates and reordering are counted separately.',
    evidence:
      'details.samples, details.sentCount, details.lossPercent, details.duplicateCount, details.reorderedCount, details.summary and bounded raw send/message callbacks with payload base64.',
    limits:
      'This requires the configured echo service, open UDP port and correct routing. Arbitrary UDP to google.com is not an echo test. A timeout cannot distinguish filtering, loss or an unavailable echo server. No outer IP/UDP header or kernel timestamps are captured.',
    sources: [
      'src/measurements/udp.ts',
      'src/measurements/diagnosticConfig.ts',
      'backend/udp_echo.py',
    ],
  },
  {
    name: 'Traceroute',
    library: 'icmpenguin 1.0.0-rc.3 through the Android adapter',
    schedule: 'Every fifteen minutes; current automatic-trip hop limit is 20.',
    how: 'The library sends UDP probes with increasing TTL/hop limits, starting at destination port 33434 and increasing ports. The adapter returns each library result. TypeScript determines the reached hop from its qualified terminal-result rules.',
    request:
      'Current target: google.com. Up to three probes per hop, sequential concurrency 1, 32-byte library probe size, 1,000 ms per-probe timeout and a 45-second adapter deadline. Partial hops remain saved.',
    appCall: `// TypeScript:
adapter.trace(attempt.id, host, maxHops, TRACE_PROBES_PER_HOP);
// Kotlin, inside withTimeout(45_000L):
Tracer(host = host, probeType = ProbeType.UDP,
    traceStrategy = TraceStrategy.Stepped(
        maxHops = maxHops, probesPerHop = probesPerHop, concurrency = 1),
    portStrategy = PortStrategy.Sequential(start = 33434),
    probeSize = ProbeSize.Static(32), timeout = 1000
).trace { hop, probe -> encodeLibraryProbe(hop, probe) }`,
    timing:
      'Per-hop RTT is the library elapsedUsec / 1000 where supplied. Parent durationMs covers the entire adapter call, including DNS/probing/callback work. The parent result is a hop number, not a latency.',
    calculation:
      'hop RTT ms = elapsedUsec / 1000. Terminal samples are kind == reply, or kind == port_unreachable with address == resolved remote. reachedHop is the smallest terminal hop; the parent value is reachedHop only on successful completion. A missing terminal result produces an unavailable parent value while preserving intermediate samples.',
    evidence:
      'route.samples: hop, sequence, address, rttMs, kind, rawResult and available probe-size/error fields. route.reached, reachedHop, complete and stopReason describe the whole trace.',
    limits:
      'Hop RTT is a round trip to a responding hop, not delay of one link. host_unreachable/port_unreachable are library classifications, not independently decoded ICMP type/code. The app’s reached flag follows the saved library interpretation and is not independent route validation.',
    terminal: 'traceroute -4 -N 1 -n -m 20 -q 3 -w 1 -p 33434 google.com 60',
    sources: [
      'src/measurements/traceroute.ts',
      'android/app/src/main/java/com/labpracticeapp/diagnostics/TracerouteModule.kt',
      'android/app/src/main/java/com/labpracticeapp/diagnostics/LibraryProbeResult.kt',
    ],
  },
  {
    name: 'HTTP latency',
    library: 'React Native fetch and TypeScript timing',
    schedule:
      'Available in collector tooling; not a standalone scheduled measurement in current automatic trips.',
    how: 'Send a GET to the controlled ping endpoint, consume the response and verify that its body is exactly pong. Validate the probe header and reject unexpected content encoding before reporting latency.',
    request:
      'GET https://api.hailemariam.com/api/v1/probe/ping?request=<measurement-id>\nHeaders: Connection: close; Cache-Control: no-cache\nExpected response: X-Capstone-Probe: 1 and four-byte body pong.',
    appCall: `// Abridged from runProbe('http_rtt', ...):
const started = dependencies.now(); // performance.now()
const response = await dependencies.fetch(
  \`\${config.serverUrl}/api/v1/probe/ping?request=\${base.id}\`,
  { method: 'GET', signal: controller.signal,
    headers: { Connection: 'close', 'Cache-Control': 'no-cache' } }
);
const body = await response.text(); // must be exactly "pong"
const durationMs = dependencies.now() - started;
// value = durationMs only after status/header/body validation`,
    timing:
      'Start before request dispatch; stop after the complete body has been read and validated. DNS, connection/TLS setup when applicable, server work, body delivery and callback processing can contribute.',
    calculation:
      'HTTP transaction latency ms = monotonic finish time − monotonic start time. The payload is four bytes; it is not a four-byte ICMP ping and does not isolate packet RTT.',
    evidence:
      'value, durationMs, httpStatus, requestedBytes, transferredBytes, probeRegion and transfer-stage/header timing where available.',
    limits:
      'Connection reuse and platform handling of Connection: close affect timing scope. A captive portal or wrong body/header is invalid, not a valid latency result.',
    terminal:
      "curl --http1.1 -H 'Connection: close' -H 'Cache-Control: no-cache' -o /dev/null -w 'HTTP total seconds=%{time_total}\\n' 'https://api.hailemariam.com/api/v1/probe/ping?request=terminal-check'",
    sources: [
      'src/measurements/runProbe.ts',
      'src/api/probeProtocol.ts',
      'backend/app.py',
    ],
  },
  {
    name: 'Controlled download',
    library:
      '@dr.pogodin/react-native-fs 2.40.3 in automatic trips; fetch remains a smaller-payload tooling path',
    schedule:
      'First transfer pair five minutes after qualification, then hourly; at most ten pairs under the current saved policy.',
    how: 'Request an exact byte count from the controlled lab endpoint and stream the body into the app cache. Check HTTP status, X-Capstone-Probe, identity encoding, content length and bytes written. Remove the temporary file after the native worker settles.',
    request:
      'GET https://api.hailemariam.com/api/v1/probe/download/500000?request=<measurement-id>\nHeaders: Cache-Control: no-cache; Accept-Encoding: identity; Connection: close\nNew pilot payload: 500,000 bytes (decimal), with a 45-second total ceiling. Historical trips retain their recorded sizes.',
    appCall: `const started = clock.now(); // performance.now()
const task = fs.downloadFile({
  fromUrl: \`\${config.serverUrl}/api/v1/probe/download/\${config.downloadBytes}?request=\${attempt.id}\`,
  toFile: path, cacheable: false,
  headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity', Connection: 'close' },
  connectionTimeout: Math.min(config.timeoutMs, 10000),
  readTimeout: Math.min(config.timeoutMs, 30000), progressInterval: 250,
  begin: validateHeaders, progress: rememberBytesWritten
});
const response = await task.promise;
const durationMs = clock.now() - started;
const Mbps = response.bytesWritten * 8 / (durationMs * 1000);`,
    timing:
      'Start before downloadFile; stop when its promise settles after writing the body. Timing includes setup, transfer, native file buffering and callback completion. Partial failures retain the last observed byte count when available; the completed Mbps value remains null.',
    calculation:
      'Mbps = confirmed file bytes × 8 / durationMs / 1000. The new pilot uses a 45-second download ceiling. Historical policies retain min(90 s, max(30 s, 10 s + payload time at an assumed 0.5 Mbps)); that assumed rate is a timeout policy, not a measured speed.',
    evidence:
      'requestedBytes, transferredBytes, durationMs, value, transfer.observedBytes, transfer.stage, headersAfterMs, bytesScope and timeoutMs.',
    limits:
      'This is fixed-size application transfer performance to the lab, including overhead. It does not establish full link capacity and is not equivalent to Ookla or M-Lab. The fetch tooling path is used when streaming is off and the payload is at most 8 MiB.',
    terminal:
      "curl --http1.1 -H 'Accept-Encoding: identity' -H 'Connection: close' -H 'Cache-Control: no-cache' -o /dev/null -w 'bytes=%{size_download} total_seconds=%{time_total}\\n' 'https://api.hailemariam.com/api/v1/probe/download/500000?request=terminal-check'",
    sources: [
      'src/measurements/fileDownload.ts',
      'src/measurements/runProbe.ts',
      'src/trips/runtime.ts',
      'src/trips/scheduler.ts',
      'backend/app.py',
    ],
  },
  {
    name: 'Controlled upload',
    library: 'React Native fetch and TypeScript timing',
    schedule:
      'Paired with controlled download under the same trip transfer schedule.',
    how: 'Prepare a random ASCII body of the exact configured size before starting the timer. POST it to the lab and consume the JSON acknowledgement. Only an exact receivedBytes match establishes successful completion.',
    request:
      'POST https://api.hailemariam.com/api/v1/probe/upload?request=<measurement-id>\nHeaders: Content-Type: application/octet-stream; Connection: close; Cache-Control: no-cache\nCurrent body: 1,000,000 ASCII bytes. Expected JSON: {"receivedBytes":1000000}.',
    appCall: `const body = uploadPayload(config.uploadBytes); // before the clock starts
const started = dependencies.now(); // performance.now()
const response = await dependencies.fetch(
  \`\${config.serverUrl}/api/v1/probe/upload?request=\${base.id}\`,
  { method: 'POST', signal: controller.signal, body,
    headers: { Connection: 'close', 'Cache-Control': 'no-cache',
      'Content-Type': 'application/octet-stream' } }
);
const ack = await response.json();
// Validate ack.receivedBytes === config.uploadBytes.
const durationMs = dependencies.now() - started;
const Mbps = config.uploadBytes * 8 / (durationMs * 1000);`,
    timing:
      'Start after payload generation and before fetch; end after the full JSON acknowledgement has been consumed and validated. Includes connection/TLS setup when applicable, request delivery, server reading, acknowledgement return and callbacks.',
    calculation:
      'Mbps = server-acknowledged application payload bytes × 8 / durationMs / 1000. Unlike streamed download, a failed fetch upload cannot reliably expose partial server-received bytes; those remain unknown without a valid acknowledgement.',
    evidence:
      'requestedBytes, transferredBytes, durationMs, value, httpStatus and transfer stage. Successful transferredBytes is the acknowledged payload count, not TCP/TLS/header bytes.',
    limits:
      'This is a fixed-size application transaction, not isolated upload capacity. The transfer endpoint receives bytes; the separate authenticated record-ingestion API stores research results and is not this throughput test.',
    sources: ['src/measurements/runProbe.ts', 'backend/app.py'],
  },
  {
    name: 'M-Lab NDT7 speed test',
    library:
      'ndt7-client-android 0.2.2-skymeasure.3 through the Android adapter',
    schedule:
      'One automatic pair per qualified trip, subject to the saved policy and four-attempts-per-24-hour native frequency guard.',
    how: 'Discover an M-Lab server, then run the library download and upload tests over secure WebSockets. These are time-based bulk transfers, normally about ten seconds per direction, rather than requests for a fixed five-megabyte file.',
    request:
      'GET https://locate.measurementlab.net/v2/nearest/ndt/ndt7?client_name=skymeasure-android&client_version=0.2.2-skymeasure.3\nThen use the returned signed WSS URLs for /ndt/v7/download and /ndt/v7/upload on the selected M-Lab host. Signed URL credentials are not shown here.',
    appCall: `// TypeScript:
await NativeModules.CapstoneNdt7.run(id, consentVersion, wifiHandle, uncapped);
// Android adapter, using a client bound to the selected Wi-Fi:
val test = object : NDTTest(client, if (uncapped) null else 90L * 1024 * 1024) {
    // Retain client progress, server measurements and completion callbacks.
}
test.startTest(NDTTest.TestType.DOWNLOAD_AND_UPLOAD);`,
    timing:
      'Use the library byte counters and corresponding elapsed seconds. Completed download uses client-received bytes/time. Completed upload uses server-received counters/time, including the documented server TCPInfo counter fallback when necessary. durationMs can use client elapsed time, so do not reconstruct upload speed from that field alone.',
    calculation:
      'download Mbps = clientBytes × 8 / clientSeconds / 1,000,000; upload Mbps = serverBytes × 8 / serverSeconds / 1,000,000. The saved reference.elapsedSeconds is the selected denominator, and reference.source identifies client/server. Report value only for a complete, opened, cleanly closed test with valid counters.',
    evidence:
      'reference.clientBytes, reference.serverBytes, reference.elapsedSeconds, reference.source, reference.serverCounterSource, stopReason, value and bounded raw client/server callbacks. transferredBytes is the last client counter and can differ from the upload speed numerator.',
    limits:
      'Uses a different destination from controlled lab tests. Public IP and results are published under the M-Lab consent disclosure. Incomplete/cancelled/capped runs have null completed speed. Historical builds had byte thresholds; the current private pilot has no M-Lab byte cutoff, while watchdog and frequency controls remain.',
    sources: [
      'src/reference/tripMlab.ts',
      'src/reference/session.ts',
      'android/app/src/main/java/com/labpracticeapp/diagnostics/Ndt7Module.kt',
      'android/ndt7/src/main/java/net/measurementlab/ndt7/android/NDTTest.kt',
      'android/ndt7/src/main/java/net/measurementlab/ndt7/android/models/ReceiverCounters.kt',
    ],
  },
  {
    name: 'Latency under load',
    library: 'The HTTP libraries and TypeScript coordinator',
    schedule:
      'Implemented in collector tooling; disabled in current automatic trips.',
    how: 'Take three baseline HTTP transactions. Start a controlled transfer, then run up to twenty HTTP latency probes during it. Only probes whose full measured interval fits inside the load interval enter the loaded sample set.',
    request:
      'Baseline/during-load: GET /api/v1/probe/ping. Concurrent load: GET /api/v1/probe/download/<bytes> or POST /api/v1/probe/upload on the same configured lab base URL.',
    appCall: `// Abridged from runLoadedLatency; these calls deliberately overlap:
await probe('http_rtt', config, attempt.sessionId, signal); // three baselines
const transfer = probe(loadType, config, attempt.sessionId, signal);
const result = await probe('http_rtt', config, attempt.sessionId, loadAbort.signal);
// Keep the sample only when its entire interval is inside the transfer.
await transfer;`,
    timing:
      'Each latency sample uses the complete HTTP transaction interval. The coordinator separately records the transfer interval and includes only fully overlapping probes.',
    calculation:
      'Parent value = median of valid overlapping HTTP latency samples, in ms. Baseline median is stored separately. The embedded load has its own value in Mbps; parent latency and load throughput are different values. A very short load may yield no usable samples.',
    evidence:
      'details.samples, baselineSamples, summary, baselineSummary, loadedOverlapCount and details.load.',
    limits:
      'A failed transfer, cancellation or no overlapping replies leaves the parent result unavailable. These HTTP samples are transactions, not individual IP packets.',
    sources: [
      'src/measurements/loadedLatency.ts',
      'src/measurements/runProbe.ts',
    ],
  },
  {
    name: 'ASN, network, battery and schedule context',
    library:
      'NetInfo, react-native-device-info, Android Wi-Fi adapter, server GeoLite2-ASN and the application scheduler',
    schedule:
      'Automatic detector evaluations every 30 seconds; network identity normally refreshes every minute and is invalidated on a selected-network change.',
    how: 'Bind the selected Wi-Fi, request server-observed network identity, and read local network/power context. The backend maps the observed public IP through a local GeoLite ASN database. For Starlink it can perform a bounded cached PTR lookup to extract an observed egress PoP code.',
    request:
      'GET https://api.hailemariam.com/api/v1/context\nHeaders: Cache-Control: no-cache; Connection: close. This is an identity/context lookup, not an RTT or throughput sample. Automatic trips do not obtain GPS coordinates.',
    appCall: `await NativeModules.FlightNetwork.bindWifi();
await fetch(
  \`\${participantDefaults.serverUrl}/api/v1/context\`,
  { signal: identityAbort.signal,
    headers: { 'Cache-Control': 'no-cache', Connection: 'close' } }
);
await NetInfo.fetch();
await DeviceInfo.getBatteryLevel();
await DeviceInfo.isBatteryCharging();
// Backend ASN mapping:
reader.asn(observedPublicIp);`,
    timing:
      'Detector/context observations have their own observation times and freshness. They are not measured anew for every packet. The scheduler separately saves scheduledAt and startedAt to expose execution lateness.',
    calculation:
      'Battery % = round(DeviceInfo level × 100) for levels in [0,1], otherwise null. Lateness ms = Date.parse(startedAt) − Date.parse(scheduledAt). ASN is a database lookup, not an RTT calculation. Signal strength is the available 0–100 Wi-Fi score, not dBm.',
    evidence:
      'Network snapshots, flight_detection events, ASN organization/source/build timestamp, available PoP, batteryPercent/isCharging and measurement scheduling fields.',
    limits:
      'ASN matching does not prove the phone is airborne. Missing/stale ASN stays unknown; a PTR PoP change is an observed egress change, not proof of a satellite handover. Wi-Fi and battery context are distinct from satellite link signal measurements.',
    sources: [
      'src/trips/runtime.ts',
      'src/network/context.ts',
      'src/trips/scheduler.ts',
      'backend/network_context.py',
    ],
  },
];

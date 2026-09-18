# Controlled probe server (M2)

Run from the repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Set `PROBE_REGION` before startup to label a server; the default is `local`. The requirements file pins the tested development environment, including pytest and HTTPX. Python 3.14 was used for validation.

Connect an Android emulator or USB-debugging phone using `adb reverse tcp:8000 tcp:8000`. In the app use `http://127.0.0.1:8000`. An emulator can alternatively use `http://10.0.2.2:8000`. The app's release build allows local HTTP endpoints; use HTTPS for other release servers. Interactive endpoint documentation is at `http://127.0.0.1:8000/docs`.

## Protocol

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `GET /api/v1/probe/ping` | No body | Four ASCII bytes: `pong` |
| `GET /api/v1/probe/download/{size}` | Size in bytes: 1048576, 5242880 or 10485760 | Exactly that many binary bytes |
| `POST /api/v1/probe/upload` | `application/octet-stream`, nonempty uncompressed body, at most 1048576 bytes | JSON: `{"receivedBytes": <actual byte count>}` |

Successful replies include `X-Capstone-Probe: 1`, `X-Probe-Region` and `Cache-Control: no-store, no-transform`. The download payload is random binary data generated once at server startup. No gzip middleware is enabled. The client adds a unique query parameter to each request to avoid cache reuse.

The upload handler counts streamed bytes and enforces the size limit even without Content-Length. Unsupported download sizes return 400; oversized uploads return 413; unsupported media types or compressed uploads return 415. Empty uploads and mismatched declared lengths return 400. No measurements are ingested or stored here yet.

## Measurement interpretation

The TypeScript client prepares upload data before starting a monotonic timer, then times the complete request through response-body consumption. RTT covers a full small HTTP exchange, not ICMP ping. A cold request may include DNS/TCP/TLS setup; connection reuse can change later timings. Fetch does not provide isolated DNS timing.

Download bytes come from the complete binary response. Upload bytes are counted only after an acknowledgement confirms the expected amount. Throughput is `bytes × 8 / (duration_ms × 1000)` Mbps. It includes connection/server/acknowledgement and JavaScript processing overhead, so it is end-to-end application throughput, not raw link capacity. Loopback/emulator values are functionality checks and should not be used as satellite performance evidence.

The client checks the protocol header and payload lengths to detect unexpected responses (including common captive-portal pages). A timeout covers both fetching and body consumption. Cancellation aborts the request and prevents later probes in the batch. Failed transfers have no throughput value or confirmed transferred-byte count. A failure may still have used network data.

M2 keeps results in memory. Session/result IDs are temporary process-local identifiers. SQLite and durable IDs are M4 work; batch ingestion, deduplication and deferred synchronization are M6 work.

## Tests

```bash
backend/.venv/bin/python -m pytest backend/tests -q
```

Tests cover exact payload sizes, protocol headers, upload acknowledgement, invalid requests and streamed-body size enforcement. Mobile probe tests live in `__tests__/runProbe.test.ts` and use fake transports/clocks for timing, cancellation and error cases. A real Android-to-server test is also required to verify the React Native transport.

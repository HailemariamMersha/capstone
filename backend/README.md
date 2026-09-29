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
| `GET /api/v1/probe/download/{size}` | Any integer size from 1 to 104857600 bytes (100 MiB) | Exactly that many binary bytes |
| `POST /api/v1/probe/upload` | `application/octet-stream`, nonempty uncompressed body, at most 104857600 bytes (100 MiB) | JSON: `{"receivedBytes": <actual byte count>}` |

Successful replies include `X-Capstone-Probe: 1`, `X-Probe-Region` and `Cache-Control: no-store, no-transform`. The download response streams slices of a reusable 1 MiB random binary block generated at startup, repeating the block for larger requests. Content-Length is the exact requested size; the backend does not allocate the entire requested response. No gzip middleware is enabled. The client adds a unique query parameter to each request to avoid cache reuse.

The upload handler counts streamed bytes and enforces the size limit even without Content-Length. Out-of-range download sizes return 400; oversized uploads return 413; unsupported media types or compressed uploads return 415. Empty uploads and mismatched declared lengths return 400.

Restart the backend after upgrading from the preset-size implementation. Older servers reject custom downloads and uploads larger than 1 MiB. The app still verifies exact byte counts and records those rejections as failures.

## Measurement interpretation

The TypeScript client prepares upload data before starting a monotonic timer, then times the complete request through response-body consumption. RTT covers a full small HTTP exchange, not ICMP ping. A cold request may include DNS/TCP/TLS setup; connection reuse can change later timings. Fetch does not provide isolated DNS timing.

Download bytes come from the complete binary response. Above 8 MiB, the app streams downloads into a temporary file through `@dr.pogodin/react-native-fs` and records `http_download_to_file`; file-write time is included. Smaller downloads retain the fetch-based `http_full_transaction` method. Do not pool these methods without accounting for that difference. Upload bytes are counted only after an acknowledgement confirms the expected amount. Throughput is `bytes × 8 / (duration_ms × 1000)` Mbps. It includes connection/server/acknowledgement and JavaScript processing overhead, so it is end-to-end application throughput, not raw link capacity. Loopback/emulator values are functionality checks and should not be used as satellite performance evidence.

The client checks the protocol header and payload lengths to detect unexpected responses (including common captive-portal pages). A timeout covers both fetching and body consumption. Cancellation aborts the request and prevents later probes in the batch. Failed transfers have no throughput value or confirmed transferred-byte count. A failure may still have used network data.

The current mobile app saves measurements with durable IDs in SQLite and can export or synchronize closed sessions.

## Tests

```bash
backend/.venv/bin/python -m pytest backend/tests -q
```

Tests cover exact payload sizes, protocol headers, upload acknowledgement, invalid requests and streamed-body size enforcement. Mobile probe tests live in `__tests__/runProbe.test.ts` and use fake transports/clocks for timing, cancellation and error cases. A real Android-to-server test is also required to verify the React Native transport.


## Ingestion and network identity

`POST /api/v1/ingest` accepts at most 50 versioned records / 8 MiB per batch. Records are keyed by installation ID, type and record ID. A transaction commits before acknowledgements are returned; retrying an identical batch is idempotent. Same-version conflicting payloads return 409. Newer versions replace older ones without creating duplicates.

Storage defaults to `backend/data/ingestion.sqlite`; override with `CAPSTONE_INGEST_DB`. This local single-server store is a prototype adapter, not the planned PostgreSQL/TimescaleDB deployment. Inspect it with a SQLite browser or Python's sqlite3 module; data is in the `records` table, with JSON in `payload_json`.

Set `CAPSTONE_SYNC_TOKEN` for remote deployments; clients send it as a bearer token. Without a token the endpoint accepts loopback connections only. Serve remote deployments over HTTPS and configure reverse-proxy trust correctly; do not expose a tokenless backend behind a loopback proxy. The mobile app does not persist the token or log it.

`GET /api/v1/context` returns the observed public IP (null for local/private addresses) and ASN when enrichment is configured. To enable ASN, install `geoip2` in the backend environment and set `CAPSTONE_ASN_DB` to a local compatible ASN MMDB file. No external lookup is made, no MMDB is bundled, and missing enrichment returns null. Configure Uvicorn's trusted proxy settings explicitly when deployed behind a proxy; never trust arbitrary client-supplied forwarding headers.

## Optional UDP diagnostics

`backend/.venv/bin/python -m backend.udp_echo` starts a separate protocol-v1 UDP service on loopback port 9876. HTTP/Uvicorn does not start this service automatically. For a physical phone, configure a LAN binding and allowed source address as shown in [diagnostic testing](../docs/diagnostics.md#physical-android-testing). UDP cannot use `adb reverse`.

The app targets 512 KiB sync batches, sending a larger individual raw measurement alone. The server accepts up to 8 MiB per batch; oversize records are retained locally and rejected explicitly, never trimmed to fit.

# Capstone Semester Plan

## Crowdsourced Satellite Network Measurements on Moving Platforms

## 1. Project Goal

The goal of this capstone is to build a mobile application for collecting real-world satellite internet measurements on moving platforms, particularly aircraft.

The application will allow users to start a measurement session while connected to in-flight or satellite-based internet. It will collect network-performance metrics, save all measurements locally during unstable connectivity, and synchronize them with a backend when connectivity is available.

The project will focus on four main contributions:

* A mobile measurement application
* An offline-first measurement and synchronization pipeline
* Controlled network probe infrastructure
* A dataset and analysis pipeline for studying satellite connectivity under mobility

The first implementation will target Android, while the application architecture and measurement logic will remain cross-platform so that the system can later be extended to iOS.

---

# 2. System Architecture

The application will be built primarily using **React Native and TypeScript**.

```text
React Native / TypeScript
│
├── User interface
├── Session management
├── Measurement scheduler
├── HTTP RTT measurement
├── Download throughput measurement
├── Upload throughput measurement
├── Connectivity monitoring
├── Network metadata
├── Local database access
├── Sync orchestration
├── Backend API client
└── Shared data models
        │
        ▼
Local SQLite Database
        │
        ▼
Deferred Synchronization
        │
        ▼
FastAPI Backend
        │
        ▼
PostgreSQL + TimescaleDB
        │
        ▼
Python Analysis
```

Platform capabilities such as long-running background execution, network-state monitoring, location, and scheduled background work will be accessed through established React Native libraries.

The main design principle is:

> Keep measurement logic, storage logic, session management, and backend communication reusable across platforms while relying on React Native libraries for operating-system integration.

---

# 3. Tool Stack

## Mobile Application

| Component                  | Tool                                       | Purpose                                                                |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Framework                  | React Native CLI + TypeScript              | Main application                                                       |
| Background measurement     | React Native background execution library  | Keep active measurement sessions running while the app is backgrounded |
| Local database             | OP-SQLite                                  | Offline-first structured data storage                                  |
| Network state              | `@react-native-community/netinfo`          | Connectivity state and network-change detection                        |
| Location                   | React Native location library              | Optional GPS altitude, speed, and position                             |
| Background synchronization | React Native background-fetch/task library | Deferred synchronization opportunities                                 |
| HTTP                       | `fetch` or lightweight HTTP client         | Controlled network probes and backend communication                    |
| App state                  | React Native `AppState`                    | Detect foreground/background transitions                               |

---

## Backend

| Component  | Tool                     | Purpose                            |
| ---------- | ------------------------ | ---------------------------------- |
| API        | FastAPI                  | Probe endpoints and data ingestion |
| Database   | PostgreSQL + TimescaleDB | Time-series measurement storage    |
| Deployment | Docker                   | Backend deployment                 |
| Hosting    | Fly.io or similar        | Probe and API servers              |

---

## Analysis

* Python
* pandas
* matplotlib
* Jupyter notebooks
* SQL

---

# 4. Measurements

The first version will focus on application-level network measurements that can be performed consistently from mobile devices.

## Core Metrics

### HTTP RTT

Send a small request to a controlled probe endpoint and measure:

```text
request start
→ connection/request
→ response received
→ elapsed time
```

Initial frequency:

**Every 60 seconds**

---

### Download Throughput

Download a controlled payload from the probe server.

Possible payloads:

```text
1 MB
5 MB
10 MB
```

Calculate:

```text
throughput =
bytes received / download duration
```

Initial frequency:

**Every 5 minutes**

---

### Upload Throughput

Upload a generated payload of known size.

Possible payloads:

```text
256 KB
1 MB
```

Calculate:

```text
throughput =
bytes uploaded / upload duration
```

Initial frequency:

**Every 5 minutes**

---

### Connectivity Stability

Record:

* failed requests
* connection loss
* reconnect events
* measurement gaps
* network changes
* probe timeouts

A failed measurement will itself be stored as a result rather than discarded.

---

### DNS / Connection Setup

The MVP will record DNS-inclusive or connection-setup timing where feasible.

Isolated raw DNS measurements can be explored later.

---

### Network Context

Measurements may include:

```text
network type
WiFi state
SSID/BSSID where available
public IP
ASN
satellite/provider information
timestamp
probe-server region
```

---

# 5. Offline-First Data Model

Every measurement will be written locally **before synchronization is attempted**.

SQLite will therefore be the source of truth.

Planned tables:

```text
sessions

measurements

connectivity_events

network_snapshots

sync_queue

device_info

debug_logs

app_settings
```

A measurement may contain:

```text
measurement_id
session_id
timestamp
measurement_type
duration_ms
value
unit
success
error_type
probe_server
network_type
public_ip
asn
sync_status
```

Each record will have a unique ID so backend synchronization can be idempotent.

---

# 6. Measurement and Synchronization Separation

Measurement collection and backend synchronization will operate independently.

## Measurement Engine

Responsible for:

```text
Running probes
Recording failures
Capturing network state
Writing measurements to SQLite
```

It does not depend on the backend being available.

---

## Synchronization Engine

Responsible for:

```text
Finding unsynced rows
Creating upload batches
Sending batches to FastAPI
Retrying failed uploads
Marking confirmed rows as synced
```

Therefore:

```text
Measurement
    ↓
SQLite
    ↓
Sync Queue
    ↓
Backend
```

If connectivity disappears:

```text
Measurements continue
        ↓
Remain locally stored
        ↓
Connectivity returns
        ↓
Synchronization resumes
```

---

# 7. Flight Context and Validation

The system will combine several signals rather than requiring one perfect indicator that the user is on a flight.

## User-provided information

The user may provide:

```text
airline
flight number
origin
destination
satellite/WiFi provider
optional notes
```

---

## Network Signals

The application may collect:

```text
WiFi SSID
BSSID
public IP
ASN
connection type
network transitions
```

---

## Optional Location Signals

Where available:

```text
altitude
speed
latitude/longitude
```

Location is a supporting signal only.

The application should continue collecting measurements even when location is unavailable.

---

# 8. Milestone Timeline

| Milestone / Timeline                                      | Goal                                                                                                 | Main Tasks                                                                                                                                                                                                           | Exit Criteria                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **M1 — App Foundation** **Week 1**                        | Establish the application architecture and shared data models.                                       | Create RN CLI + TypeScript project; organize measurement, storage, network, session, and API modules; define TypeScript interfaces; create basic UI; configure GitHub and development environment.                   | App runs reliably on a physical Android device and project structure is established.                                  |
| **M2 — Measurement Prototype** **Weeks 2–3**              | Prove that network measurements can be implemented independently of the UI.                          | Implement HTTP RTT; download measurement; upload measurement; timeout handling; probe configuration; basic result screen; create minimal FastAPI probe endpoints.                                                    | App repeatedly produces structured RTT/download/upload results without crashes.                                       |
| **M3 — Background Measurement Reliability** **Weeks 3–4** | Determine whether measurement sessions continue reliably while the phone is not actively being used. | Integrate background execution library; persistent measurement notification where required; test app backgrounding, screen lock, navigation away from app, 30-minute and multi-hour sessions; record execution gaps. | Measurement schedule remains sufficiently stable during controlled background tests and interruptions are detectable. |
| **M4 — Offline-First Storage** **Weeks 4–5**              | Guarantee measurement persistence.                                                                   | Integrate OP-SQLite; enable WAL; create schema; save measurements locally; implement session recovery; build local history/debug screen; test app kill/restart.                                                      | Measurements survive app restart, network loss, and interrupted sessions without silent loss.                         |
| **M5 — Complete Probe Engine** **Weeks 6–7**              | Build the full measurement workflow.                                                                 | Configure RTT interval; download/upload intervals; network failure recording; DNS-inclusive timing; probe metadata; error classifications; network-change detection; data/battery safeguards.                        | Multi-hour ground test produces a clean and interpretable measurement dataset.                                        |
| **M6 — Backend + Reliable Sync** **Weeks 8–9**            | Build the complete phone-to-backend pipeline.                                                        | Create FastAPI ingestion endpoints; deploy PostgreSQL + TimescaleDB; implement batch uploads; build sync queue; implement retry logic; prevent duplicate ingestion; deploy initial probe server.                     | Offline measurements synchronize completely after reconnection with no duplicate or missing records.                  |
| **M7 — Flight and Network Context** **Week 10**           | Add context needed to interpret measurements.                                                        | Add manual flight metadata; capture network type; SSID/BSSID where available; public IP; ASN; optional location/altitude/speed; associate context with measurement timestamps.                                       | Measurements are linked to meaningful session and network context.                                                    |
| **M8 — Reliability Evaluation** **Weeks 11–12**           | Stress-test the complete system before a flight.                                                     | Test phone lock; background operation; app restart; WiFi loss; airplane mode; reconnect; backend outage; slow network; high latency; bandwidth throttling; interrupted uploads; long sessions; repeated sync.        | Test scenarios do not cause unexplained data loss and all interruptions appear in logs/dataset.                       |
| **M9 — Real-World Measurement** **Weeks 12–13**           | Validate the system under actual mobility.                                                           | Conduct an in-flight satellite/WiFi measurement session if available; collect full session; synchronize after flight; inspect dataset; repeat if possible.                                                           | At least one complete real-world or equivalent mobility dataset is collected end-to-end.                              |
| **M10 — Data Analysis** **Weeks 13–14**                   | Demonstrate what can be learned from the collected data.                                             | Build Jupyter/pandas analysis pipeline; analyze RTT, throughput, connectivity gaps, failures, ASN/network changes, and measurement success rate; generate visualizations.                                            | Analysis notebook automatically produces the principal figures and statistics required for the report.                |
| **M11 — Final Report + Demo** **Weeks 14–15**             | Complete the capstone research contribution.                                                         | Finalize application; clean repository; document measurement methodology; document architecture; analyze limitations; prepare figures; write report; prepare demonstration and presentation.                         | Complete application, backend, dataset, analysis pipeline, report, and presentation.                                  |

---

# 9. Early Reliability Testing

Testing will begin before the formal reliability milestone.

### During M3

Test:

```text
screen locked
app backgrounded
30-minute session
1-hour session
2-hour session
```

### During M4

Test:

```text
app restart
measurement persistence
database recovery
```

### During M5

Test:

```text
WiFi loss
high latency
failed probes
temporary disconnection
```

### During M6

Test:

```text
backend unavailable
failed upload
repeated sync
offline → online transition
duplicate prevention
```

M8 will combine these into the full fake-flight test suite.

---

# 10. Ground-Based Fake Flight Testing

The real flight should validate the application, not serve as the first debugging session.

The ground-test harness will simulate:

```text
Normal WiFi
↓
Bandwidth restriction
↓
Increasing latency
↓
Connection loss
↓
Failed measurements
↓
Network restoration
↓
Deferred synchronization
```

Additional tests:

* phone locked for extended periods
* network changed while measuring
* backend intentionally disabled
* slow server responses
* interrupted uploads
* app closed and reopened
* long-running sessions

---

# 11. Real-World Validation

The preferred real-world experiment is:

> A measurement session conducted on an aircraft using satellite-based in-flight internet.

The session should produce:

```text
Session metadata

RTT time series

Download throughput

Upload throughput

Connectivity failures

Network changes

IP/ASN information

Optional location information

Synchronization history
```

If flight access is delayed, controlled constrained-network experiments will provide an intermediate evaluation.

---

# 12. Analysis Plan

The analysis will initially answer questions such as:

### Latency

```text
How does RTT change during the flight?

How variable is latency?

Are there periods of consistently elevated RTT?
```

### Throughput

```text
How stable are download and upload speeds?

How much variation exists within one session?
```

### Connectivity

```text
How frequently does connectivity disappear?

How long do outages last?

Does performance recover immediately after reconnection?
```

### Network Changes

```text
Does the public IP or ASN change?

Are network changes associated with RTT or throughput changes?
```

### Measurement Reliability

```text
What percentage of scheduled probes complete?

How many measurements are delayed or missed?

How well does offline storage preserve data?
```

---

# 13. Minimum Viable Capstone

The minimum successful capstone will contain:

```text
React Native Android application

HTTP RTT measurements

Download and upload measurements

Background measurement sessions

Offline-first SQLite storage

Network failure and gap logging

Reliable deferred synchronization

FastAPI backend

PostgreSQL / TimescaleDB

Controlled probe server

Network/flight context

Ground reliability evaluation

At least one real or simulated mobility dataset

Python analysis notebook

Final research report
```

This is sufficient to demonstrate the complete research system even if advanced features are not completed.

---

# 14. Stretch Goals

Only after the core pipeline is stable:

```text
Multiple geographic probe regions

Additional real flights

Multiple airlines/providers

Raw DNS measurements

Traceroute/path analysis

Advanced satellite-provider classification

Public dataset release

Web dashboard

iOS application
```

The mobile codebase, measurement definitions, database schema, backend protocol, and analysis pipeline will be structured so that they can be reused when extending the system to additional platforms.

---

# 15. Semester Strategy

### Weeks 1–5 — Prove the Mobile Architecture

Build the application, measurement functions, background execution, and offline persistence.

### Weeks 6–9 — Complete the Measurement Pipeline

Finish the probe engine, backend, database, and synchronization.

### Weeks 10–13 — Validate the System

Add contextual signals, perform aggressive ground testing, and collect real-world measurements.

### Weeks 13–15 — Produce the Research Contribution

Analyze the data, evaluate system reliability, document limitations, and prepare the final report and presentation.

The main implementation priority throughout the semester is:

> **First make measurement collection reliable, then make it scalable, and only then add additional measurement features.**

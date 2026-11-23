# Research workspace: trips before records

The researcher workspace has three destinations: **Overview**, **Trips** and
**Participants**. Researcher Google sign-in and administrator-only team/payment
access remain in place. Participant phones continue using installation identities.

## Finding and comparing trips

Overview shows received trips, study/ground classification, incomplete uploads,
recent arrivals and separately loaded provider results. It does not claim to know
which phones are currently collecting. A provider ASN is a network indicator,
not proof of an airborne aircraft or a particular satellite orbit.

Trips is a searchable, server-paginated list of twenty trips per page. Filter by
participant/flight/route, provider, study versus ground test and UTC collection
dates. Filters and pagination are reflected in the URL. Dates refer to collection;
server receipt times are separately labelled. A test-ASN or shadow trip is a
ground test. **Study** means it was not flagged as a ground test; it does not mean
its flight was independently verified. Use the study filter for flight analyses.

List queries aggregate parent records for only the requested page. They do not
load sample payloads or calculate medians for every trip. Historical session
endpoints remain compatible, but separate sessions are no longer a top-level
navigation destination.

## Reading a trip

The opening cards distinguish:

- Provider/test classification and the phone's last reported state.
- Observed collection coverage, estimated from received detector observations.
- Upload reconciliation, including declared, received and completed segments.
- Recorded collector gaps, whose causes are not assumed.
- Last server receipt time, separate from collection time.

**Network results** summarizes distinct measurement parents and individual probe
replies. Successful bursts can include lost probes. Missing values remain missing;
zero remains zero. RTT, connection duration, controlled-transfer rates and M-Lab
speeds have different meanings and are labelled separately.

The whole-trip timeline shares a UTC time axis across latency, throughput and
collection events. Toggle local display time when useful. Points are not joined
across missing observations. Dense series use at most 2,000 time bins per protocol;
a bin's value is the median of its recorded parent results, with range and failure
counts retained. This is distinct from the summary's exact pooled probe median.
Upload pauses, recorded gaps, segment boundaries and unreceived intervals are
shown separately. An unreceived interval is not evidence of a sleeping phone.

**Collector health** exposes scheduling events, pauses, retries, skips, gaps and
available power observations. Coverage is an estimate from consecutive collecting
observations no more than ninety seconds apart, with recorded gaps and upload
pauses subtracted. It does not establish continuous execution between observations.
A charging flag does not prove whether a cable was physically connected.

The collapsed route illustration uses bundled airport/city references and an
illustrative arc. It does not use phone coordinates, external geocoding or a
recorded aircraft track. Ambiguous or unmatched locations stay textual.

## Investigating and exporting

Open **Evidence** only when needed. Choose measurement rounds, individual samples
or events, then a test and outcome. Only the requested page is loaded. The initial
columns are small; test-specific defaults add relevant fields. **Customize
columns** and the column help buttons explain sources, units, calculations and
missing values. Wide tables scroll within their card and have keyboard/arrow
controls. The visible-columns CSV contains the loaded rows, not all server pages.

The trip's **Download trip** menu exports complete received JSON or a combined
measurement/sample CSV across received segments. The original raw records,
including historical fields, remain intact. The CSV repeats parent context per
sample; do not sum parent values across those repeated rows. It retains baseline
samples, failed probes and standalone measurements. Trip identifiers and receipt
completeness fields are documented in the [dictionary](../measurements/columns.md).
NetID payment mappings are excluded. Full exports may take several minutes; the
page shows preparation status and prevents duplicate downloads. Partial evidence
remains explicitly partial.

Collection segments and original session evidence are one level deeper. Their
legacy JSON/CSV links remain available. The researcher workspace omits obsolete
GPS/confidence fields from detector-event presentation; raw original exports do
not rewrite historical evidence.

## Loading and caching

Visible lists refresh every fifteen seconds. Trip summaries and timelines use
server-side revisioned caches; committed new records/manifests invalidate the
relevant views. A failed refresh retains previously loaded data. Read-only account
checks no longer acquire a write lock on the account row. Exports use a separate
consistent database snapshot and bounded CSV chunks.

The dashboard polls a history-generation marker. A completed staging history reset
clears research query caches without signing the researcher out. Old links show a
removed-history explanation. Cleanup is an explicit operator procedure, not a
participant-facing delete-all action; see [history maintenance](history-maintenance.md).

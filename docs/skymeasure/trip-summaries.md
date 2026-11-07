# Dynamic trip-card measurement summaries

Researcher **Trips** cards summarize the received segments belonging to each
trip. The API calculates the values for every request; the dashboard never
uses a saved experiment or a fixed set of totals. Existing fifteen-second
refreshes update both old and future trips as more evidence arrives. Participant
trip responses and phone collection behavior are unchanged.

`GET /api/v2/research/trips` adds a `summary` to each item. It contains received
segment count, expected/received record counts, parent measurement count,
unsuccessful parent count and protocol results. Partial segments contribute
only records actually committed; expected counts cover registered manifests.
Missing segments and completion acknowledgements remain separately visible.
Equal record counts alone do not establish reconciliation.

Each measurement is counted once from `sky_records`, rather than once per
sample or combined-CSV row. Probe counts and timings use `sky_samples` joined
to the matching session and parent measurement. Echo and TCP observations use
the `probe` phase; traceroute observations use `hop`. Baseline and M-Lab raw
callbacks do not inflate probe counts. Queries are restricted to trips on the
current page and return aggregates instead of raw packet/callback payloads.
The aggregation uses five queries per page; segment links are also fetched in
one page-wide query rather than per card.

Medians pool all non-null, nonnegative individual probe values, including zero.
For even sample counts the result averages the two middle observations; it is
not an average of burst medians. SQL window ranking computes the exact result
in PostgreSQL and SQLite. ICMP/UDP median values describe RTT; TCP median
values describe connection duration. Other measurements have no probe timing
median in this view.

Incomplete bursts display saved sample/reply counts and an explicit incomplete
count, without inventing a full-trip loss percentage. A successful burst can
include individual timeouts. Traceroute destination counts retain the library's
qualified interpretation. M-Lab byte-threshold stops appear as capped/partial,
separately from other failed outcomes. Protocol types unfamiliar to the web UI
receive a generic row rather than disappearing. A missing summary is shown as
unavailable; a protocol with no received attempts is shown as not collected.

Elapsed trip time spans the reported start/end and includes gaps/upload pauses.
It is not continuous measurement coverage. Active trips show the last reported
state without extrapolating a live phone status.

Validation covers cross-trip isolation, partial and duplicate uploads, exact
pooled medians, zero and null values, exclusion of baseline/reference callbacks,
qualified route results, timeouts, capped benchmarks, role checks, and narrow
screen scrolling. Read-only PostgreSQL validation matched the previously
audited trip's 21 segments, 135 measurements, 15 unsuccessful measurements,
390 expected/received records and 311/320 ICMP replies. These numbers occur in
test/validation evidence only, not in application calculations.

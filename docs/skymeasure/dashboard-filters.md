# Exploring a session in the dashboard

Open **Sessions**, then select a session. Under **Explore measurements**:

1. Choose a measurement type, such as ICMP echo burst, UDP echo or HTTP download.
2. Choose the whole-measurement outcome, or search by target, method or measurement ID.
3. Under **Individual probes and traceroute hops**, optionally choose a sample phase or sample outcome. Search samples by address, library label, sequence, hop or parent ID.
4. Open **Choose columns** above a table. Search for a field, read its description, and select the columns you need. Click a column heading to sort.
5. Use **Download visible columns CSV** to export all matching rows across pages, in the selected order, with only the selected columns.

**Reset filters** clears row filters. **Restore default columns** restores the columns for that table. Filters and column choices remain during the automatic refresh; they reset when you leave the session or reload the page.

## Scope and interpretation

The top filters affect the timing chart, measurements, samples and scheduling tables. Sample phase, outcome and search affect only the sample table. The visible counts show matching rows relative to the complete received session. Header totals remain complete-session totals.

A successful burst can contain timed-out probes. To investigate these, select **Successful** as the whole-measurement outcome and **Timeout** as the sample outcome. Baseline samples are HTTP transactions made before a load transfer; ordinary/during-transfer samples appear under `probe`. Traceroute samples use `traceroute` in these filtered views (the original combined export uses `hop`).

Each measurement-table row represents one parent measurement; each sample-table row represents one observation. Standalone HTTP transfers remain in the measurement table even when they have no samples. The timing chart plots parent values once, with separate series for measurement types. Sample-only filters do not alter the chart.

Units and missing-value explanations appear in column descriptions. Zero is retained; **Unavailable** becomes an empty CSV cell. ICMP/UDP RTT, TCP connection duration and HTTP transaction latency have different timing scopes. Traceroute library classifications such as `host_unreachable` remain qualified and are not treated as decoded ICMP types. Target addresses are not substituted for missing reply-source addresses.

## Downloads

Filtered CSV headers use field keys; **Choose columns** supplies readable labels, units and descriptions. The measurement and sample exports include an optional **Measurement ID** column (`id` and `parent`, respectively) for joining rows. Sample fields describe observations; measurement fields describe the parent. Spreadsheet formula prefixes in strings are escaped.

The **Original session JSON** and **Combined measurement / sample CSV** buttons still download the complete received session, irrespective of filters. Configuration, context, events and raw-evidence panels also remain complete-session views. Unknown future fields remain accessible through raw JSON and the complete export; they are not automatically added to the curated selectable columns.

See the [combined CSV guide](combined-csv.md) and [measurement dictionary](measurements/columns.md) for the complete export format. This change affects dashboard presentation and adds filtered downloads; phone collection, ingestion and existing exports are unchanged.

## Validation — 2026-10-26

Seven Playwright tests pass using sanitized fixtures. Coverage includes researcher access restrictions, missing versus zero values, sample timeouts within successful bursts, baseline samples, filtering after pagination, preserving filters during refresh, empty results, column selection, sorting, all-page CSV downloads, and a 390-pixel viewport. A 62-sample export verifies that downloads include rows beyond the first 50. These tests do not establish measurement reliability or validate the completed five-hour experiment.

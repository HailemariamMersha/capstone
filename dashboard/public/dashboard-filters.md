# Exploring measurements in the researcher workspace

The current dashboard is organized around **Trips**. Open a trip, review
**Network results** and **Collector health**, then expand **Evidence** to select
measurement rounds, individual samples or events. Each table loads one server
page, supports test/outcome filters, column selection and contextual definitions.

See the [trip workspace guide](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/trip-workspace.md) for filters, timeline
interpretation, route limitations, exports and loading behavior. See the
[measurement dictionary](/measurements/columns.md) for complete definitions and
the [combined CSV guide](/measurement-guide.md) for parent/sample row granularity.

**Download visible columns CSV** contains the loaded table rows and selected
columns. Use **Download trip** for all received segments. Raw historical session
exports remain available under collection segments. Missing values are unavailable
or inapplicable, never substituted with zero. A successful burst can contain
individual timeouts; parent outcomes and sample outcomes are different filters.

Wide tables scroll inside their cards using touch/trackpad, keyboard focus or
Left/Right buttons. “The server took too long” describes a web request timeout,
not a measurement of signal strength or proof of missing records. Failed refreshes
retain previously loaded evidence; retry or return to the compact Trips list.

The **Measurement guide** is available independently from the sidebar at `/guide`,
including method descriptions, searchable variable definitions and the full export
dictionary. The retired top-level Sessions/Downloads navigation and the all-session
client-side filter behavior described in the October implementation are historical. Phone collection methods and original raw exports remain unchanged.

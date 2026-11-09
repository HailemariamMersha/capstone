# Documentation reading map

Start with the [repository README](../README.md). Current implementation is on `feature/skymeasure-participant-dashboard`; `main` is an older collector.

| Question | Read |
| --- | --- |
| How do I join and run checks locally? | [Contributor guide](../CONTRIBUTING.md) |
| Where does each component live? | [Architecture and source map](architecture.md) |
| How does the current trip qualify and collect? | [ASN-only collection policy](measurements/flight-collection.md) |
| When do probes run, and how are gaps/failures recorded? | [Collector reliability](skymeasure/collector-reliability.md) |
| What does each column mean? | [Measurement guide](measurements/guide.md), [generated dictionary](measurements/columns.md), [combined CSV](skymeasure/combined-csv.md) |
| What do the libraries expose or omit? | [Library comparison](library-packet-comparison.md), [capability audit](measurements/comparison.md) |
| What is M-Lab and why are results capped? | [Automatic M-Lab](skymeasure/automatic-mlab.md) |
| How do the dashboard filters work? | [Dashboard filters](skymeasure/dashboard-filters.md) |
| How do we configure services and accounts? | [Staging setup](skymeasure/setup.md), [rollout and ASN setup](skymeasure/flight-rollout.md) |
| How do we build and recover researcher login? | [Sign-in and verified pilot build](skymeasure/sign-in-recovery.md) |
| What was tested? | [Validation](skymeasure/validation.md), dated [experiments](experiments/) |
| What may be shared? | [Repository security/data handling](../SECURITY.md) |

Dated experiment notes, the semester plan, packet-engine documentation and earlier architecture designs are historical evidence. They can describe previous budgets, GPS-supported detection, DigitalOcean hosting or custom packet code that current builds do not use. They are retained to make the research progression reviewable. Do not read an older success as validation of a newer detector or device configuration. Sanitized examples illustrate structures; private original exports remain local.

The shared dictionary source is `scripts/measurements/columns.json`; generate `measurements/columns.md` with `npm run measurements:docs` and refresh dashboard copies with `npm run skymeasure:docs`. Do not edit generated copies directly.

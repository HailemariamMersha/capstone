# SkyMeasure capstone paper

This is a submission-formatted **progress research report**, with a frozen evidence cutoff of **16 November 2026**. It reports ground experiments, not an airborne campaign. Hailemariam Mersha is the sole listed author; no advisor/coauthor or venue acceptance is invented.

## Open or compile

The delivered PDF is `../output/pdf/skymeasure-progress.pdf`. The ZIP delivery contains this directory and can be uploaded to Overleaf: select **main.tex** as the main document and use **pdfLaTeX** (the standard IEEEtran class is used without claiming submission to IEEE). Tectonic is an alternative local compiler:

```sh
# From the repository root, using an environment with matplotlib installed:
python3 -m pip install -r paper/requirements.txt
make -C paper
```

The figure PDFs are already included. Overleaf does not need Python, the raw datasets, cloud accounts or application credentials to compile the paper. A traditional TeX installation can run `pdflatex main; bibtex main; pdflatex main; pdflatex main` from this directory. `make` regenerates plots and writes build files under the repository's ignored `build/` directory.

## Contents and scope

- `main.tex`, `sections/body.tex`: research questions, eight academic related works, design, measurement definitions, scheduling, ownership, uploads, measured results, planned validation, ethics and limitations.
- `sections/appendices.tex`: library/version inventory, row meanings, configuration, independent validation matrix and reproducibility. Appendices intentionally use one-column tables for readability.
- `references.bib`: thirteen cited sources, including eight academic works and primary implementation documentation.
- `figures/`: five vector figures plus PNG previews. Architecture is a system diagram; the other four figures use measured data. Planned validation plots are described in a table, **not simulated as completed results**.
- `data/`: six de-identified tables and an input-provenance summary; no raw participant records, addresses, account IDs, flight text, SSIDs, BSSIDs, coordinates or tokens.
- `scripts/`: reproducible extraction, plotting, artifact checks and an independent UDP checker.

## Evidence and interpretation

1. The historical 12 October ten-minute integration result used USB-forwarded HTTP; the paper does not call its rates Internet throughput.
2. The 15 November short ground trip reconciled all 435 expected records. Collection used 1.2.1; 1.2.2 retried the saved data after Stop.
3. Three completed 15 November M-Lab pairs used 251.4, 295.8 and 305.6 MiB of recorded client payload. Payload counters differ from billed/network-interface traffic. The current pilot remains uncapped; the discussed 200 MiB-per-direction option is only a proposal.
4. The long-trip snapshot declares 58 segments but contains only nine manifests, eight complete and one partial. Its 414 received measurements cannot describe the unseen later segments. The 41 missing registered versions are additional to 49 positions with no received manifest.
5. First-manifest receipt lag mixes recorded phone and server wall clocks without independent calibration; it is not a transport-latency measurement.
6. The analyzer's nine `/trip/startedAt` flags reflect its ISO/epoch-millisecond mismatch. The paper preserves and explains that tool limitation instead of rewriting the original evidence.

## Regenerate from private inputs (authorized operators only)

```sh
python3 paper/scripts/extract_data.py \
  --trip-export /path/to/private/latest-trip.json \
  --mlab-usage /path/to/private/mlab-usage-runs.json
python3 paper/scripts/make_figures.py
```

The extraction command has frozen-cohort assertions. A later study must deliberately update these assertions, prose, plots and provenance together, rather than silently replacing the reported cohort. The original inputs stay local; hashes identify the exact frozen files. Figure regeneration alone uses only the released CSVs.

`scripts/udp_reference.py --host <controlled-echo-IP>` sends the application's twenty correlated 128-byte datagrams with 250 ms pacing and a three-second reply grace. Its loopback check passed; a live matched validation campaign remains planned. Use the same Wi-Fi and destinations for comparisons; do not shape traffic on the shared lab host.

## Word count and review

The accompanying `review.json` records the final standard TeXcount totals, data checks, PDF build and visual review. The main prose is over 3,000 words; abstract, appendices, headings and captions bring the recognized document count below 4,000, excluding bibliography and table cells. The attached course requirements specify a 3,000–4,000-word report and no named template. Figure/table labels and all thirteen bibliography entries are cross-referenced.

The document is ready to review/submit as a report of **current progress**. Its future validation section is not a completed accuracy evaluation, and the paper does not claim commercial-flight detection accuracy, complete overnight coverage, iOS validation or public-recruitment readiness.

#!/usr/bin/env python3
"""Plot a dated, aggregate-only paired validation fixture; never read raw trips."""

import argparse
import json
import math
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator, PercentFormatter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="Output filename stem")
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    cohort = data["cohorts"]["conservative"]
    pairs = cohort["matchedRounds"]
    roles = ["phone", "mac"]
    labels = ["Android app\nreact-native-udp", "Mac reference\nPython socket"]
    colors = ["#087e83", "#163047"]
    means = [cohort[role]["meanBurstMedianRttMs"] for role in roles]
    rates = []

    if not isinstance(pairs, int) or pairs <= 0:
        raise ValueError("The chart requires matched rounds, not unavailable comparisons")
    for role, mean in zip(roles, means):
        counts = cohort[role]
        probes, replies, timeouts = (counts[k] for k in ("probes", "replies", "timeouts"))
        if not all(isinstance(n, int) and n >= 0 for n in (probes, replies, timeouts)):
            raise ValueError(f"Invalid probe counts for {role}")
        if probes <= 0 or replies + timeouts != probes:
            raise ValueError(f"Unreconciled probe counts for {role}")
        if not isinstance(mean, (int, float)) or not math.isfinite(mean) or mean < 0:
            raise ValueError(f"Unavailable or invalid RTT for {role}")
        rates.append(100 * timeouts / probes)
    delta = means[0] - means[1]
    if not math.isclose(delta, cohort["meanPairedDifferenceMs"], abs_tol=1e-9):
        raise ValueError("The paired mean difference disagrees with the plotted means")
    if any(item["matchedRounds"] != 0 for item in data["unavailableComparisons"]):
        raise ValueError("Update the ICMP/TCP caption when comparable evidence is available")

    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "text.color": "#163047",
        "axes.labelcolor": "#163047",
        "xtick.color": "#163047",
        "ytick.color": "#536271",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": False,
        "axes.edgecolor": "#c9d1d8",
        "axes.axisbelow": True,
        "svg.hashsalt": "skymeasure-paired-validation",
    })
    fig = plt.figure(figsize=(11, 6.4), facecolor="white")
    axes = [fig.add_axes([0.08, 0.37, 0.38, 0.40]),
            fig.add_axes([0.60, 0.37, 0.34, 0.40])]
    day = date.fromisoformat(data["collectionDate"]).strftime("%d %B %Y")
    probes = cohort["phone"]["probes"]
    fig.text(0.055, 0.935, "UDP echo: phone versus Mac", fontsize=21, weight="bold")
    fig.text(0.055, 0.877,
             f"Ground validation · {day} · {pairs} matched rounds · {probes:,} probes per device",
             color="#536271", fontsize=11)

    for ax, values, title in zip(axes, [means, rates],
                                 ["Mean of burst median RTT", "Recorded non-response"]):
        ax.bar(range(2), values, width=0.53, color=colors, zorder=3)
        ax.set_xticks(range(2), labels)
        ax.tick_params(axis="both", length=0, pad=8)
        ax.set_title(title, loc="left", pad=15, fontsize=13, weight="bold")
        ax.grid(axis="y", color="#e1e7ec", linewidth=0.8)
        ax.set_ylim(0, max(values) * 1.38 if max(values) else 1)
        ax.yaxis.set_major_locator(MaxNLocator(nbins=5))

    axes[0].set_ylabel("Milliseconds (ms)", labelpad=10)
    axes[0].text(0.5, 0.94, f"Phone − Mac: {delta:+.1f} ms",
                 transform=axes[0].transAxes, ha="center", weight="bold", fontsize=12)
    for x, value in enumerate(means):
        axes[0].text(x, value + max(means) * 0.04, f"{value:.1f} ms",
                     ha="center", weight="bold", fontsize=12)
    axes[1].set_ylabel("Probes without a recorded reply", labelpad=10)
    axes[1].yaxis.set_major_formatter(PercentFormatter(xmax=100, decimals=0))
    for x, (role, value) in enumerate(zip(roles, rates)):
        counts = cohort[role]
        axes[1].text(x, value + max(rates) * 0.04,
                     f"{value:.2f}%\n{counts['timeouts']}/{counts['probes']} probes",
                     ha="center", fontsize=11, linespacing=1.5)

    fig.text(0.055, 0.20,
             "ICMP / TCP: no comparable pairs — the devices reached different Google IPs.",
             fontsize=11, weight="bold",
             bbox={"facecolor": "#f0f4f7", "edgecolor": "none", "pad": 9})
    fig.text(0.055, 0.115,
             "Same UDP destination/port and matching recorded egress context; known overlapping tests,\n"
             "upload pauses and recorded gaps excluded. Bars describe the conservative matched subset.",
             fontsize=10, color="#536271", linespacing=1.5)
    fig.text(0.055, 0.045,
             "Observed device/method difference, not proof of a library error. No independent packet capture.",
             fontsize=10, color="#536271")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    for extension in ("png", "svg"):
        output = args.out.with_suffix(f".{extension}")
        metadata = {"Date": None} if extension == "svg" else {"Software": "SkyMeasure / Matplotlib"}
        fig.savefig(output, dpi=180, metadata=metadata)
        if extension == "svg":
            output.write_text("\n".join(
                line.rstrip() for line in output.read_text().splitlines()
            ) + "\n")
        print(output)
    plt.close(fig)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Regenerate vector research figures from the committed de-identified tables."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Patch
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'figures'
OUT.mkdir(exist_ok=True)
NAVY, TEAL, ORANGE, GREY = '#163047', '#087e83', '#b35c20', '#c9d1d8'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 8, 'axes.titlesize': 9,
                     'axes.labelsize': 8, 'legend.fontsize': 7, 'xtick.labelsize': 7,
                     'ytick.labelsize': 7, 'pdf.fonttype': 42, 'ps.fonttype': 42,
                     'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.grid': True, 'grid.alpha': .18, 'axes.axisbelow': True})


def read(name):
    with (ROOT / 'data' / name).open() as f:
        return list(csv.DictReader(f))


def save(fig, name):
    fig.savefig(OUT / (name + '.pdf'), bbox_inches='tight', pad_inches=.035)
    fig.savefig(OUT / (name + '.png'), dpi=220, bbox_inches='tight', pad_inches=.035)
    plt.close(fig)


def architecture():
    fig, ax = plt.subplots(figsize=(7.05, 2.65))
    ax.set(xlim=(0, 10), ylim=(-.12, 4.2)); ax.axis('off')
    fig.subplots_adjust(left=.02, right=.98, bottom=.02, top=.98)
    def box(x, y, w, h, title, body, color=TEAL):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=.07', facecolor='white', edgecolor=color, linewidth=1.15))
        ax.text(x + w/2, y + h*.72, title, ha='center', va='center', weight='bold', fontsize=8, color=NAVY)
        ax.text(x + w/2, y + h*.31, body, ha='center', va='center', fontsize=6.7, color=NAVY)
    def arrow(a, b, label=None, dy=.1, color=NAVY):
        ax.add_patch(FancyArrowPatch(a, b, arrowstyle='-|>', mutation_scale=9, color=color, linewidth=.9))
        if label: ax.text((a[0]+b[0])/2, (a[1]+b[1])/2+dy, label, fontsize=6.5, ha='center', color=NAVY, bbox=dict(facecolor='white', edgecolor='none', pad=.6))
    box(.2, 1.65, 2.5, 1.2, 'Android phone', 'React Native + libraries\nLocal SQLite / trip runtime')
    box(3.55, 1.65, 2.5, 1.2, 'Lab service', 'FastAPI / context / ingestion\nControlled HTTP + UDP')
    box(7.0, 1.65, 2.5, 1.2, 'Supabase', 'PostgreSQL + raw JSONB\nSeparate Auth service')
    box(7.0, 3.2, 2.5, .8, 'Researcher UI', 'Next.js on Vercel')
    box(.2, .05, 2.5, .8, 'Probe targets', 'Google / public M-Lab')
    arrow((2.77, 2.18), (3.48, 2.18))
    arrow((6.12, 2.18), (6.93, 2.18))
    arrow((7.15, 3.13), (5.55, 2.94), 'Authorized queries', .2)
    arrow((1.45, 1.58), (1.45, .92))
    ax.text(3.13, 1.45, 'HTTPS', ha='center', fontsize=6.5, color=NAVY)
    ax.text(6.53, 1.45, 'Records', ha='center', fontsize=6.5, color=NAVY)
    ax.text(2.05, 1.17, 'Active probes', ha='center', fontsize=6.5, color=NAVY)
    ax.text(3.55, .42, 'Reconciliation checks expected record versions.\nReceived state is not live phone presence.', ha='left', fontsize=7, color=NAVY)
    save(fig, 'architecture')


def latency():
    rows = read('latency.csv')
    fig, axes = plt.subplots(1, 2, figsize=(7.05, 2.4))
    for ax, kinds in zip(axes, [[('icmp_burst', 'ICMP reply RTT', TEAL), ('tcp_connect', 'TCP connect duration', NAVY)], [('udp_echo', 'UDP echo callback RTT', ORANGE)]]):
        for kind, label, color in kinds:
            group = [r for r in rows if r['protocol'] == kind]
            values = np.sort([float(r['rttMs']) for r in group if r['rttMs'] != ''])
            ax.step(values, np.arange(1, len(values)+1)/len(values), where='post', color=color, linewidth=1.35, label=f'{label} (n={len(values):,})')
        ax.set_xscale('log'); ax.set_ylim(0, 1.02); ax.set_xlabel('Observed duration (ms; logarithmic scale)'); ax.legend(loc='lower right')
    axes[0].set_ylabel('Empirical fraction of received observations')
    axes[0].set_title('(a) Google target: different timing scopes')
    axes[1].set_title('(b) Controlled lab UDP target')
    fig.tight_layout(w_pad=1.5); save(fig, 'latency-cdf')


def delivery():
    rows = read('delivery.csv')
    fig, axes = plt.subplots(2, 1, figsize=(7.05, 2.45), gridspec_kw={'height_ratios': [1, 1.8]})
    colors = {'complete': TEAL, 'partial': ORANGE, 'no_manifest': GREY}
    for r in rows:
        axes[0].bar(int(r['segment']), 1, color=colors[r['state']], width=.88)
    axes[0].set(xlim=(.3, 58.7), ylim=(0, 1.12)); axes[0].set_yticks([])
    axes[0].legend(handles=[Patch(color=TEAL, label='8 reconciled'), Patch(color=ORANGE, label='1 partial'), Patch(color=GREY, label='49 without manifests')], loc='upper right', ncol=3, frameon=False, bbox_to_anchor=(1, 1.64))
    axes[0].set_xlabel('Declared segment position (one-based)')
    received = [r for r in rows if r['firstReceiptLagHours'] != '']
    axes[1].plot([int(r['segment']) for r in received], [float(r['firstReceiptLagHours']) for r in received], 'o-', color=NAVY, linewidth=1.1, markersize=3.5)
    axes[1].set(xlim=(.7, 9.3), xlabel='Received segment position', ylabel='First-manifest lag\nafter closure (h)')
    axes[1].set_xticks(range(1,10)); fig.tight_layout(h_pad=.7); save(fig, 'delivery')


def benchmarks():
    rows = read('mlab.csv'); x = np.arange(len(rows)); down = np.array([float(r['downloadMiB']) for r in rows]); up = np.array([float(r['uploadMiB']) for r in rows])
    fig, ax = plt.subplots(figsize=(3.4, 2.45))
    ax.bar(x, down, color=TEAL, width=.52, label='Download client payload')
    ax.bar(x, up, bottom=down, color=NAVY, width=.52, label='Upload client payload')
    for i, total in enumerate(down + up): ax.text(i, total+6, f'{total:.1f}', ha='center', fontsize=8)
    ax.set(xticks=x, xticklabels=[r['run'] for r in rows], ylabel='Recorded payload (MiB)', xlabel='Completed ground benchmark pair', ylim=(0, 335))
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.01), fontsize=6.5, frameon=False); fig.tight_layout(); save(fig, 'mlab-payload')


def schedule():
    rows = read('jobs.csv'); fig, ax = plt.subplots(figsize=(3.4, 2.45))
    colors = {'icmp_burst': TEAL, 'udp_echo': ORANGE, 'tcp_connect': NAVY}
    for kind, color in colors.items():
        r = [v for v in rows if v['protocol'] == kind and v['latenessMs']]
        ax.scatter([float(v['startMin']) for v in r], [float(v['latenessMs'])/1000 for v in r], s=7, alpha=.65, color=color, label=kind.replace('_', ' '), rasterized=False)
    transfers = [v for v in rows if v['protocol'] in ('download', 'upload') and v['latenessMs']]
    ax.scatter([float(v['startMin']) for v in transfers], [float(v['latenessMs'])/1000 for v in transfers], marker='x', s=21, color='#9a3b49', linewidth=.9, label='controlled transfer')
    for p in read('upload-pauses.csv'):
        ax.axvspan(float(p['startMin']), float(p['endMin']), color=GREY, alpha=.65, linewidth=0)
    ax.set(xlabel='Minutes since trip start', ylabel='Job invocation lateness (s)', ylim=(-2, 92))
    ax.legend(loc='upper right', fontsize=6, frameon=False); fig.tight_layout(); save(fig, 'schedule-lateness')


if __name__ == '__main__':
    architecture(); latency(); delivery(); benchmarks(); schedule()
    print('Wrote five measured/system figures in vector PDF and PNG formats.')

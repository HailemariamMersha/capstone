#!/usr/bin/env python3
"""Independent checks on the de-identified tables used by the paper."""
import csv
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    with (ROOT / 'data' / name).open() as f:
        return list(csv.DictReader(f))


def main():
    observations = read('latency.csv')
    expected = {'icmp_burst': (1320, 1305, 24.748),
                'udp_echo': (2640, 2524, 286.5137310028076),
                'tcp_connect': (132, 132, 33.79980796575546)}
    checks = {}
    for kind, (sent, replies, median) in expected.items():
        rows = [r for r in observations if r['protocol'] == kind]
        values = [float(r['rttMs']) for r in rows if r['rttMs'] != '']
        assert len(rows) == sent and len(values) == replies
        assert math.isclose(statistics.median(values), median, rel_tol=1e-10)
        checks[kind] = {'attempts': sent, 'replies': replies, 'medianMs': statistics.median(values)}
    delivery = read('delivery.csv')
    assert len(delivery) == 58
    assert sum(r['state'] == 'complete' for r in delivery) == 8
    assert sum(r['state'] == 'partial' for r in delivery) == 1
    assert sum(r['state'] == 'no_manifest' for r in delivery) == 49
    assert sum(int(r['expectedRecords']) for r in delivery if r['expectedRecords']) == 2666
    assert sum(int(r['receivedRecords']) for r in delivery if r['receivedRecords']) == 2625
    assert all(r['expectedRecords'] == r['receivedRecords'] == '' for r in delivery if r['state'] == 'no_manifest')
    jobs = read('jobs.csv')
    assert len(jobs) == 414 and sum(r['success'] == 'False' for r in jobs) == 4
    assert not any(r['timingValid'] == 'False' for r in jobs)
    benchmarks = read('mlab.csv')
    assert len(benchmarks) == 3
    for r in benchmarks:
        assert math.isclose(float(r['downloadMiB']) + float(r['uploadMiB']), float(r['totalMiB']), rel_tol=1e-12)
    assert math.isclose(max(float(r['totalMiB']) for r in benchmarks), 305.5703125)
    bib = (ROOT / 'references.bib').read_text()
    assert bib.count('@inproceedings{') + bib.count('@article{') == 8
    checks['delivery'] = {'declared': 58, 'complete': 8, 'partial': 1, 'withoutManifest': 49, 'registeredExpected': 2666, 'received': 2625}
    checks['bibliography'] = {'academicWorks': 8, 'total': 13}
    print(json.dumps(checks, indent=2))


if __name__ == '__main__':
    main()

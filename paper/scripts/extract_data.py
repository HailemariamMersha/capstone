#!/usr/bin/env python3
"""Extract de-identified plotting tables from the private, read-only audit bundle.

No addresses, account/session IDs, flight text, SSIDs, BSSIDs or absolute probe
timestamps are written. Original evidence remains outside the paper directory.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path


def write_csv(path, fields, rows):
    with path.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def epoch(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--trip-export', type=Path, required=True)
    p.add_argument('--mlab-usage', type=Path, required=True)
    p.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    trip_data = json.loads(a.trip_export.read_text())
    usage = json.loads(a.mlab_usage.read_text())
    trip = trip_data['trip']
    origin = trip['startedAt'] / 1000
    measurements = [m for segment in trip_data['segments'] for m in segment['measurements']]
    latency, jobs, transfers = [], [], []
    rounds = {}
    for m in sorted(measurements, key=lambda x: (x['timestamp'], x['id'])):
        kind = m['type']
        rounds[kind] = rounds.get(kind, 0) + 1
        scheduling = m.get('scheduling') or {}
        actual = scheduling.get('startedAt') or m['timestamp']
        jobs.append(dict(protocol=kind, startMin=(epoch(actual) - origin) / 60,
                         scheduledMin=(epoch(m['scheduledAt']) - origin) / 60 if m.get('scheduledAt') else None,
                         latenessMs=scheduling.get('latenessMs'), durationMs=m.get('durationMs'),
                         success=m.get('success'), timingValid=scheduling.get('timingValid')))
        if kind in ('icmp_burst', 'udp_echo', 'tcp_connect'):
            for sample in (m.get('details') or {}).get('samples', []):
                latency.append(dict(protocol=kind, round=rounds[kind], sequence=sample['sequence'],
                                    timeMin=(epoch(sample.get('timestamp') or m['timestamp']) - origin) / 60,
                                    rttMs=sample.get('rttMs'), errorType=sample.get('errorType')))
        if kind in ('download', 'upload'):
            progress = m.get('transfer') or {}
            transfers.append(dict(direction=kind, timeMin=(epoch(m['timestamp']) - origin) / 60,
                                  durationSeconds=m['durationMs'] / 1000,
                                  headersSeconds=progress.get('headersAfterMs', 0) / 1000 if progress.get('headersAfterMs') is not None else None,
                                  requestedBytes=m.get('requestedBytes'), observedBytes=m.get('transferredBytes'),
                                  success=m['success'], errorType=m.get('errorType')))
    write_csv(a.out / 'latency.csv', ['protocol', 'round', 'sequence', 'timeMin', 'rttMs', 'errorType'], latency)
    write_csv(a.out / 'jobs.csv', ['protocol', 'startMin', 'scheduledMin', 'latenessMs', 'durationMs', 'success', 'timingValid'], jobs)
    write_csv(a.out / 'controlled-transfers.csv', ['direction', 'timeMin', 'durationSeconds', 'headersSeconds', 'requestedBytes', 'observedBytes', 'success', 'errorType'], transfers)
    by_index = {s['receipt']['index']: s for s in trip_data['segments']}
    segments = []
    for i in range(trip['segmentCount']):
        s = by_index.get(i)
        receipt = s['receipt'] if s else {}
        segments.append(dict(segment=i + 1, state=('complete' if receipt['complete'] else 'partial') if s else 'no_manifest',
                             expectedRecords=receipt.get('expectedRecords'), receivedRecords=receipt.get('receivedRecords'),
                             startMin=(epoch(s['session']['startedAt']) - origin) / 60 if s else None,
                             firstReceiptLagHours=(epoch(receipt['receivedAt']) - epoch(s['session']['endedAt'])) / 3600 if s else None))
    write_csv(a.out / 'delivery.csv', ['segment', 'state', 'expectedRecords', 'receivedRecords', 'startMin', 'firstReceiptLagHours'], segments)
    benchmarks = []
    for i, row in enumerate(sorted(usage, key=lambda x: x['startedAt']), 1):
        directions = {v['type']: v for v in row['directions']}
        if set(directions) != {'ndt7_download', 'ndt7_upload'} or not all(v['success'] and v['stopReason'] == 'complete' for v in directions.values()):
            continue
        down, up = directions['ndt7_download'], directions['ndt7_upload']
        benchmarks.append(dict(run=f'G{i}', downloadMiB=down['clientBytes'] / 1048576,
                               uploadMiB=up['clientBytes'] / 1048576,
                               totalMiB=(down['clientBytes'] + up['clientBytes']) / 1048576,
                               downloadMbps=down['value'], uploadMbps=up['value']))
    write_csv(a.out / 'mlab.csv', ['run', 'downloadMiB', 'uploadMiB', 'totalMiB', 'downloadMbps', 'uploadMbps'], benchmarks)
    events = [e for s in trip_data['segments'] for e in s['events']]
    pauses = []
    for e in events:
        if e['kind'] == 'upload_pause':
            v = e['details']
            pauses.append(dict(startMin=(epoch(v['startedAt']) - origin) / 60, endMin=(epoch(v['endedAt']) - origin) / 60))
    write_csv(a.out / 'upload-pauses.csv', ['startMin', 'endMin'], pauses)
    checks = {
        'evidenceCutoff': '2026-11-16', 'exportedAt': trip_data['exportedAt'],
        'scope': 'Received portion of one ground trip; not the complete declared trip',
        'declaredSegments': trip['segmentCount'], 'registeredSegments': len(by_index),
        'completeSegments': sum(s['receipt']['complete'] for s in trip_data['segments']),
        'expectedRegisteredRecords': sum(s['receipt']['expectedRecords'] for s in trip_data['segments']),
        'receivedRecords': sum(s['receipt']['receivedRecords'] for s in trip_data['segments']),
        'parentMeasurements': len(measurements), 'failedParents': sum(m['success'] is False for m in measurements),
        'liveUploadReservedBytes': trip['used']['uploads'], 'liveUploadAllocationBytes': 20 * 1048576,
        'gapEvents': sum(e['kind'] == 'collector_gap' for e in events),
        'inputSha256': {
            'privateTripBundle': hashlib.sha256(a.trip_export.read_bytes()).hexdigest(),
            'privateBenchmarkSummary': hashlib.sha256(a.mlab_usage.read_bytes()).hexdigest(),
        },
        'deidentification': 'Omitted account/record IDs, addresses, flight text, identifiers and absolute probe timestamps; relative time retained.',
    }
    assert checks['parentMeasurements'] == 414 and checks['receivedRecords'] == 2625
    assert checks['expectedRegisteredRecords'] == 2666 and len(benchmarks) == 3
    assert len({m['id'] for m in measurements}) == len(measurements)
    (a.out / 'provenance.json').write_text(json.dumps(checks, indent=2) + '\n')
    print(json.dumps({'tables': 6, 'measurements': len(measurements), 'observations': len(latency), 'completedNdtPairs': len(benchmarks)}))


if __name__ == '__main__':
    main()

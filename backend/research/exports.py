"""Combined rows keep parent and sample meanings separate; raw JSON is lossless."""
import csv
import io
import json
from pathlib import Path

DICTIONARY = json.loads((Path(__file__).resolve().parents[2] / "scripts/measurements/columns.json").read_text())
PACKET_COLUMNS = DICTIONARY["combinedPacketProjection"]


def samples(measurement):
    details = measurement.get('details') if isinstance(measurement.get('details'), dict) else {}
    route = measurement.get('route') if isinstance(measurement.get('route'), dict) else {}
    for phase, values in [('probe', details.get('samples', [])),
                          ('baseline', details.get('baselineSamples', [])),
                          ('hop', route.get('samples', []))]:
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    yield phase, value
    if measurement.get('type') == 'icmp_rtt' and not details.get('samples'):
        yield 'probe', {'sequence': 0, 'timestamp': measurement.get('timestamp'), 'rttMs': measurement.get('value'), 'ttl': measurement.get('ttl'), 'errorType': measurement.get('errorType')}
    if measurement.get('reference') or measurement.get('speedchecker'):
        for value in (measurement.get('raw') or {}).get('callbacks', []):
            if isinstance(value, dict):
                yield 'reference_callback', value


def flatten(value, prefix=''):
    result = {}
    for key, item in value.items():
        name = prefix + key
        if isinstance(item, dict):
            result.update(flatten(item, name + '.'))
        elif not isinstance(item, list):
            result[name] = item
    return result


def packet_fields(packet, prefix):
    if not isinstance(packet, dict):
        return {}
    result = {}
    for column, paths in PACKET_COLUMNS.items():
        for path in paths:
            value = packet
            for key in path.split('.'):
                value = value.get(key) if isinstance(value, dict) else None
            if value is not None:
                result[prefix + column] = value
                break
    return result


def combined_rows(data):
    for measurement in data['measurements']:
        parent = flatten({k: v for k, v in measurement.items() if k not in ('raw', 'packet', 'details', 'route')}, 'measurement.')
        parent.update(packet_fields(measurement.get('packet'), 'measurement.'))
        route = measurement.get('route') or {}
        parent.update(flatten({k: v for k, v in route.items() if k != 'samples'}, 'measurement.route.'))
        provenance = measurement.get('raw') or {}
        parent.update({'measurement.library': provenance.get('library'), 'measurement.libraryVersion': provenance.get('version'), 'measurement.rawSource': provenance.get('source')})
        details = measurement.get('details') or {}
        parent.update(flatten({k: v for k, v in details.items() if k not in ('samples', 'baselineSamples', 'load')}, 'measurement.details.'))
        if isinstance(details.get('load'), dict):
            parent.update(flatten({k: v for k, v in details['load'].items() if k not in ('raw', 'packet', 'details', 'route', 'networkSnapshot')}, 'measurement.load.'))
        observations = list(samples(measurement))
        for ordinal, (phase, sample) in enumerate(observations):
            yield {**parent, 'session.id': data['session']['id'], 'row.kind': 'sample',
                   'sample.phase': phase, 'sample.ordinal': ordinal,
                   **flatten({k: v for k, v in sample.items() if k not in ('raw', 'rawResult', 'packet')}, 'sample.'),
                   **packet_fields(sample.get('packet'), 'sample.')}
        if not observations:
            yield {**parent, 'session.id': data['session']['id'], 'row.kind': 'measurement'}


def csv_text(rows):
    rows = list(rows)
    columns = list(dict.fromkeys(key for row in rows for key in row)) or ['session.id']
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: "'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else v for k, v in row.items()})
    return output.getvalue()

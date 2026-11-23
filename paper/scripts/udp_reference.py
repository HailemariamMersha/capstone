#!/usr/bin/env python3
"""Independent, pipelined reference for SkyMeasure's 20 x 128-byte UDP burst.

Run from the same Wi-Fi as the phone. No authentication or server changes.
RTTs use the local monotonic clock; UTC times are for aligning experiment logs.
"""
import argparse
import datetime
import json
import math
import secrets
import socket
import statistics
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, default=9876)
parser.add_argument('--interval', type=float, default=0.25)
parser.add_argument('--grace', type=float, default=3.0)
args = parser.parse_args()
if args.interval <= 0 or args.grace <= 0:
    parser.error('interval and grace must be positive')
target = (socket.gethostbyname(args.host), args.port)
nonce = secrets.token_hex(16)
samples = []
pending = {}
errors = []
started = time.perf_counter()
next_send = started
deadline = None
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.bind(('', 0))
    while True:
        now = time.perf_counter()
        if len(samples) < 20 and now >= next_send:
            sequence = len(samples)
            packet = f'CPSUDP1:{nonce}:{sequence:04d}:'.ljust(128, '.').encode('ascii')
            sample = {'sequence': sequence, 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'rttMs': None}
            samples.append(sample)
            pending[packet] = (sequence, now)
            try:
                sock.sendto(packet, target)
            except OSError as error:
                errors.append({'sequence': sequence, 'error': type(error).__name__})
            next_send = time.perf_counter() + args.interval
            if len(samples) == 20:
                deadline = time.perf_counter() + args.grace
        if deadline is not None and (now >= deadline or all(s['rttMs'] is not None for s in samples)):
            break
        wake = next_send if len(samples) < 20 else deadline
        sock.settimeout(max(0.001, min(0.05, wake - time.perf_counter())))
        try:
            packet, remote = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError as error:
            errors.append({'error': type(error).__name__})
            continue
        received = time.perf_counter()
        if remote == target and packet in pending:
            sequence, sent_at = pending[packet]
            if samples[sequence]['rttMs'] is None:
                samples[sequence]['rttMs'] = (received - sent_at) * 1000
values = sorted(s['rttMs'] for s in samples if s['rttMs'] is not None)
differences = [abs(b['rttMs'] - a['rttMs']) for a, b in zip(samples, samples[1:]) if a['rttMs'] is not None and b['rttMs'] is not None]
print(json.dumps({'method': 'independent_python_udp_echo', 'target': {'host': args.host, 'resolvedAddress': target[0], 'port': args.port}, 'payloadBytes': 128, 'intervalMs': args.interval * 1000, 'sent': len(samples), 'replies': len(values), 'nonResponsePercent': (len(samples) - len(values)) * 100 / len(samples), 'medianMs': statistics.median(values) if values else None, 'p95Ms': values[math.ceil(0.95 * len(values)) - 1] if values else None, 'successiveDifferenceMs': statistics.mean(differences) if differences else None, 'samples': samples, 'errors': errors}, indent=2))

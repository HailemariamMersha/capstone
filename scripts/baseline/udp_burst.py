#!/usr/bin/env python3
"""One SkyMeasure UDP echo burst with ordinary kernel sockets.

The echo server accepts only its own 128-byte correlated datagrams, so no standard
command-line tool can send them. Mirrors src/measurements/udp.ts: 20 packets, 250 ms
after each send, then up to three seconds for replies. RTTs use the monotonic clock.
SIGTERM stops early and still prints the samples collected so far.
"""
import argparse
import datetime
import json
import signal
import socket
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--nonce', required=True, help='32 lowercase hex characters')
parser.add_argument('--count', type=int, default=20)
parser.add_argument('--interval', type=float, default=0.25)
parser.add_argument('--grace', type=float, default=3.0)
args = parser.parse_args()
if len(args.nonce) != 32 or any(c not in '0123456789abcdef' for c in args.nonce):
    parser.error('nonce must be 32 lowercase hex characters')

cancelled = False


def stop(*_):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
target = (socket.gethostbyname(args.host), args.port)
samples, pending = [], {}
error = None
duplicates = reordered = 0
highest = -1
started = time.perf_counter()
next_send, deadline = started, None
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.bind(('', 0))
    while not cancelled:
        now = time.perf_counter()
        if len(samples) < args.count and now >= next_send:
            sequence = len(samples)
            packet = f'CPSUDP1:{args.nonce}:{sequence:04d}:'.ljust(128, '.').encode('ascii')
            stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
            sent_at = time.perf_counter()
            try:
                sock.sendto(packet, target)
            except OSError as failure:
                error = f'{type(failure).__name__}: {failure}'
                break
            samples.append({'sequence': sequence, 'timestamp': stamp.replace('+00:00', 'Z'), 'rttMs': None})
            pending[packet] = (sequence, sent_at)
            next_send = time.perf_counter() + args.interval
            if len(samples) == args.count:
                deadline = time.perf_counter() + args.grace
        if deadline is not None and (now >= deadline or all(s['rttMs'] is not None for s in samples)):
            break
        wake = next_send if len(samples) < args.count else deadline
        sock.settimeout(max(0.001, min(0.05, wake - time.perf_counter())))
        try:
            packet, remote = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError as failure:
            error = f'{type(failure).__name__}: {failure}'
            break
        received = time.perf_counter()
        if remote != target or packet not in pending:
            continue
        sequence, sent_at = pending[packet]
        if samples[sequence]['rttMs'] is not None:
            duplicates += 1
            continue
        if sequence < highest:
            reordered += 1
        highest = max(highest, sequence)
        samples[sequence]['rttMs'] = (received - sent_at) * 1000
print(json.dumps({
    'resolvedAddress': target[0],
    'port': args.port,
    'samples': samples,
    'sentCount': len(samples),
    'duplicateCount': duplicates,
    'reorderedCount': reordered,
    'cancelled': cancelled,
    'error': error,
    'durationMs': (time.perf_counter() - started) * 1000,
}))

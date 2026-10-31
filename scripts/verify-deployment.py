"""Bounded external smoke check, including HTTPS before a DNS cutover.

No accounts, tokens, database writes, or participant records are used.
Example: python3 scripts/verify-deployment.py --ip 23.235.205.53
    --region lab-location-unconfirmed
"""
import argparse
import http.client
import ipaddress
import json
import secrets
import socket
import ssl
import time


class TargetHTTPS(http.client.HTTPSConnection):
    def __init__(self, domain, address):
        super().__init__(domain, timeout=30, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # Route to the proposed IP while still verifying the real domain's TLS.
        transport = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self._context.wrap_socket(transport, server_hostname=self.host)


def verify(domain, address, region, origin):
    def request(method, path, body=None, headers=None):
        connection = TargetHTTPS(domain, address)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def require(condition, message):
        if not condition:
            raise RuntimeError(message)

    status, _, body = request('GET', '/health')
    require(status == 200 and json.loads(body) == {'status': 'ok', 'region': region}, 'Health/region mismatch')
    for path, size in [('/api/v1/probe/ping', 4), ('/api/v1/probe/download/1048576', 1048576)]:
        status, headers, body = request('GET', path, headers={'Accept-Encoding': 'gzip'})
        lower = {key.lower(): value for key, value in headers.items()}
        require(status == 200 and len(body) == size, 'Probe response size mismatch')
        require(int(lower['content-length']) == size, 'Content-Length mismatch')
        require('content-encoding' not in lower, 'Probe body was compressed')
        require(lower.get('x-probe-region') == region, 'Probe region mismatch')
        require('no-store' in lower.get('cache-control', ''), 'Probe caching was enabled')
        if size == 4:
            require(body == b'pong', 'Ping payload mismatch')
    status, _, body = request('POST', '/api/v1/probe/upload', b'x' * 262144,
                              {'Content-Type': 'application/octet-stream'})
    require(status == 200 and json.loads(body) == {'receivedBytes': 262144}, 'Upload acknowledgement mismatch')
    status, _, _ = request('GET', '/api/v2/research/overview')
    require(status == 401, 'Research endpoint did not require authentication')
    status, _, _ = request('GET', '/api/v2/research/overview', headers={'Authorization': 'Bearer invalid-migration-test'})
    require(status == 401, 'Invalid-token validation failed')
    status, _, _ = request('POST', '/api/v1/ingest', b'{}', {'Content-Type': 'application/json'})
    require(status == 404, 'Legacy ingestion was enabled')
    status, headers, _ = request('OPTIONS', '/api/v2/research/overview', headers={
        'Origin': origin, 'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
    })
    lower = {key.lower(): value for key, value in headers.items()}
    require(status == 200 and lower.get('access-control-allow-origin') == origin, 'Dashboard CORS preflight failed')

    replies = 0
    nonce = secrets.token_hex(16)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.connect((address, 9876))
        for sequence in range(20):
            packet = f'CPSUDP1:{nonce}:{sequence:04d}:'.encode() + b'.' * 82
            sock.send(packet)
            try:
                data = sock.recv(512)
                require(data == packet, 'UDP echo payload mismatch')
                replies += 1
            except socket.timeout:
                pass
            time.sleep(0.05)
        sock.settimeout(0.5)
        sock.send(b'invalid-migration-test')
        try:
            sock.recv(512)
            raise RuntimeError('Invalid UDP payload received a reply')
        except socket.timeout:
            pass
    require(replies == 20, f'UDP check incomplete: {replies}/20 replies')
    return {'https': 'verified', 'region': region, 'downloadBytes': 1048576,
            'uploadBytes': 262144, 'udpReplies': replies, 'udpSent': 20,
            'unauthorizedAccess': 'denied', 'legacyIngestion': 'disabled',
            'cors': 'passed', 'invalidUdp': 'ignored',
            'authenticatedPhoneUpload': 'not tested by this command'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', default='api.hailemariam.com')
    parser.add_argument('--ip', required=True, type=lambda value: str(ipaddress.IPv4Address(value)))
    parser.add_argument('--region', required=True)
    parser.add_argument('--origin', default='https://capstone-backend-henna.vercel.app')
    args = parser.parse_args()
    print(json.dumps(verify(args.domain, args.ip, args.region, args.origin), indent=2))

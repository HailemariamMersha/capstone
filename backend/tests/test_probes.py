import pytest
from fastapi.testclient import TestClient
from backend.app import app, MIB, MAX_PAYLOAD_BYTES
import importlib
probe_module = importlib.import_module("backend.app")

client = TestClient(app)


def test_ping_contract():
    response = client.get('/api/v1/probe/ping')
    assert response.status_code == 200
    assert response.content == b'pong'
    assert response.headers['x-capstone-probe'] == '1'
    assert response.headers['x-probe-region']
    assert 'no-store' in response.headers['cache-control']


@pytest.mark.parametrize('size', [1, MIB, MIB + 1, 2621440, 5 * MIB, 10 * MIB])
def test_exact_download_sizes(size):
    response = client.get(f'/api/v1/probe/download/{size}')
    assert response.status_code == 200
    assert len(response.content) == size
    assert int(response.headers['content-length']) == size
    assert 'content-encoding' not in response.headers
    assert response.headers['x-capstone-probe'] == '1'


@pytest.mark.parametrize('size', [0, -1, MAX_PAYLOAD_BYTES + 1])
def test_download_size_is_bounded(size):
    assert client.get(f'/api/v1/probe/download/{size}').status_code == 400


@pytest.mark.parametrize('size', [1, 256 * 1024, MIB, 2 * MIB])
def test_upload_acknowledges_actual_bytes(size):
    response = client.post('/api/v1/probe/upload', content=b'x' * size, headers={'content-type': 'application/octet-stream'})
    assert response.status_code == 200
    assert response.json() == {'receivedBytes': size}
    assert response.headers['x-capstone-probe'] == '1'


def test_empty_oversized_and_wrong_media_uploads():
    headers = {'content-type': 'application/octet-stream'}
    assert client.post('/api/v1/probe/upload', content=b'', headers=headers).status_code == 400
    assert client.post('/api/v1/probe/upload', content=b'x', headers={**headers, 'content-length': str(MAX_PAYLOAD_BYTES + 1)}).status_code == 413
    assert client.post('/api/v1/probe/upload', json={'data': 'x'}).status_code == 415
    assert client.post('/api/v1/probe/upload', content=b'x', headers={**headers, 'content-encoding': 'gzip'}).status_code == 415


def test_chunked_upload_cannot_bypass_limit(monkeypatch):
    monkeypatch.setattr(probe_module, "MAX_PAYLOAD_BYTES", MIB)
    chunks = (b'x' * (256 * 1024) for _ in range(5))
    response = client.post('/api/v1/probe/upload', content=chunks, headers={'content-type': 'application/octet-stream'})
    assert response.status_code == 413


def test_mismatched_content_length_is_rejected():
    response = client.post('/api/v1/probe/upload', content=b'abc', headers={'content-type': 'application/octet-stream', 'content-length': '4'})
    assert response.status_code == 400


def test_configured_boundary_is_inclusive(monkeypatch):
    # Exercise the exact limit without allocating a 100 MiB test response.
    monkeypatch.setattr(probe_module, "MAX_PAYLOAD_BYTES", 12345)
    response = client.get('/api/v1/probe/download/12345')
    assert len(response.content) == 12345
    assert response.status_code == 200
    assert client.get('/api/v1/probe/download/12346').status_code == 400
    response = client.post('/api/v1/probe/upload', content=b'x' * 12345,
                           headers={'content-type': 'application/octet-stream'})
    assert response.json() == {'receivedBytes': 12345}

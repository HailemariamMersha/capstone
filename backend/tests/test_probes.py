import pytest
from fastapi.testclient import TestClient
from backend.app import app, MIB

client = TestClient(app)


def test_ping_contract():
    response = client.get('/api/v1/probe/ping')
    assert response.status_code == 200
    assert response.content == b'pong'
    assert response.headers['x-capstone-probe'] == '1'
    assert response.headers['x-probe-region']
    assert 'no-store' in response.headers['cache-control']


@pytest.mark.parametrize('size', [MIB, 5 * MIB, 10 * MIB])
def test_exact_download_sizes(size):
    response = client.get(f'/api/v1/probe/download/{size}')
    assert response.status_code == 200
    assert len(response.content) == size
    assert int(response.headers['content-length']) == size
    assert 'content-encoding' not in response.headers
    assert response.headers['x-capstone-probe'] == '1'


@pytest.mark.parametrize('size', [0, -1, MIB + 1, 100 * MIB])
def test_download_size_is_bounded(size):
    assert client.get(f'/api/v1/probe/download/{size}').status_code == 400


@pytest.mark.parametrize('size', [256 * 1024, MIB])
def test_upload_acknowledges_actual_bytes(size):
    response = client.post('/api/v1/probe/upload', content=b'x' * size, headers={'content-type': 'application/octet-stream'})
    assert response.status_code == 200
    assert response.json() == {'receivedBytes': size}
    assert response.headers['x-capstone-probe'] == '1'


def test_empty_oversized_and_wrong_media_uploads():
    headers = {'content-type': 'application/octet-stream'}
    assert client.post('/api/v1/probe/upload', content=b'', headers=headers).status_code == 400
    assert client.post('/api/v1/probe/upload', content=b'x' * (MIB + 1), headers=headers).status_code == 413
    assert client.post('/api/v1/probe/upload', json={'data': 'x'}).status_code == 415
    assert client.post('/api/v1/probe/upload', content=b'x', headers={**headers, 'content-encoding': 'gzip'}).status_code == 415


def test_chunked_upload_cannot_bypass_limit():
    chunks = (b'x' * (256 * 1024) for _ in range(5))
    response = client.post('/api/v1/probe/upload', content=chunks, headers={'content-type': 'application/octet-stream'})
    assert response.status_code == 413


def test_mismatched_content_length_is_rejected():
    response = client.post('/api/v1/probe/upload', content=b'abc', headers={'content-type': 'application/octet-stream', 'content-length': '4'})
    assert response.status_code == 400

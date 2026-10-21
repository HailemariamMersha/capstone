import pytest

@pytest.fixture(autouse=True)
def explicit_legacy_development(monkeypatch):
    monkeypatch.setenv('CAPSTONE_LOCAL_DEV', '1')

"""Versioned pilot consent and budget semantics; historical evidence stays immutable."""
from fastapi import HTTPException
LEGACY_CONSENT = 'skymeasure-flight-mlab-2026-11-02'
CONSENT_VERSION = 'skymeasure-flight-pilot-2026-11-14'
PILOT_POLICY = 'flight-pilot-uncapped-2026-11-14'

def require_consent(account, policy=None):
    accepted = {CONSENT_VERSION} if policy == PILOT_POLICY else {LEGACY_CONSENT, CONSENT_VERSION}
    if account.consent_version not in accepted:
        raise HTTPException(403, 'Review the required research information before uploading')

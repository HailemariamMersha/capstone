"""Versioned consent; historical evidence stays uploadable without rewriting manifests."""
from fastapi import HTTPException
LEGACY_CONSENT = 'skymeasure-flight-mlab-2026-11-02'
HISTORICAL_PILOT_CONSENT = 'skymeasure-flight-pilot-2026-11-14'
CONSENT_VERSION = 'skymeasure-flight-payment-2026-11-20'
HISTORICAL_PILOT_POLICY = 'flight-pilot-uncapped-2026-11-14'
PREVIOUS_PILOT_POLICY = 'flight-pilot-hourly-2026-11-20'
PILOT_POLICY = 'flight-pilot-delivery-2026-11-23'
HOURLY_PILOT_POLICIES = {PREVIOUS_PILOT_POLICY, PILOT_POLICY}
ACCEPTED_CONSENTS = {LEGACY_CONSENT, HISTORICAL_PILOT_CONSENT, CONSENT_VERSION}

def require_consent(account, policy=None):
    accepted = {CONSENT_VERSION} if policy in HOURLY_PILOT_POLICIES else ACCEPTED_CONSENTS
    if account.consent_version not in accepted:
        raise HTTPException(403, 'Review the required research information before uploading')

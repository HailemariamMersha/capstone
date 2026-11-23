"""Controlled probe server with durable, idempotent local ingestion."""
import os
from contextlib import asynccontextmanager

from backend.ingestion import router

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

MIB = 1024 * 1024
MAX_PAYLOAD_BYTES = 100 * MIB
# Reuse an uncompressed random block rather than allocate the whole response.
PAYLOAD = os.urandom(MIB)
HEADERS = {
    "Cache-Control": "no-store, no-transform",
    "X-Capstone-Probe": "1",
    "X-Probe-Region": os.environ.get("PROBE_REGION", "local"),
}
@asynccontextmanager
async def lifespan(_app):
    from backend.research.auth import close_auth_client
    try:
        yield
    finally:
        close_auth_client()


app = FastAPI(title="Capstone Probe Server", version="0.2.0", lifespan=lifespan)
app.include_router(router)
from backend.research.api import router as research_router
from fastapi.middleware.cors import CORSMiddleware
app.include_router(research_router)



@app.get("/api/v1/probe/ping")
async def ping():
    return Response(b"pong", media_type="text/plain", headers=HEADERS)


@app.get("/api/v1/probe/download/{size}")
async def download(size: int):
    if not 1 <= size <= MAX_PAYLOAD_BYTES:
        raise HTTPException(400, "Download size must be between 1 byte and 100 MiB")

    async def chunks():
        remaining = size
        while remaining:
            count = min(remaining, len(PAYLOAD))
            yield PAYLOAD[:count]
            remaining -= count

    return StreamingResponse(chunks(), media_type="application/octet-stream",
                             headers={**HEADERS, "Content-Length": str(size)})


@app.post("/api/v1/probe/upload")
async def upload(request: Request):
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "Use application/octet-stream")
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise HTTPException(415, "Compressed uploads are unsupported")
    length = request.headers.get("content-length")
    if length is not None:
        try:
            declared = int(length)
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length")
        if declared < 0:
            raise HTTPException(400, "Invalid Content-Length")
        if declared > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, "Upload exceeds 100 MiB")
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, "Upload exceeds 100 MiB")
    if received == 0:
        raise HTTPException(400, "Upload must not be empty")
    if length is not None and received != declared:
        raise HTTPException(400, "Body length does not match Content-Length")
    return JSONResponse({"receivedBytes": received}, headers=HEADERS)

from backend.research.limits import RequestLimits
app.add_middleware(RequestLimits)
from backend.research.timing import RequestTiming
app.add_middleware(RequestTiming)
app.add_middleware(CORSMiddleware, allow_origins=[x for x in os.environ.get('DASHBOARD_ORIGINS', '').split(',') if x], allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allow_headers=['Authorization', 'Content-Type', 'Content-Encoding', 'X-SkyMeasure-Content-Encoding'], expose_headers=['X-SkyMeasure-Sync', 'X-Request-ID', 'Server-Timing', 'Retry-After'])

# Keep validation errors bounded: Pydantic's default input echo can repeat an
# entire raw batch, wasting the phone's response allocation and exposing evidence.
from fastapi.exceptions import RequestValidationError
@app.exception_handler(RequestValidationError)
async def validation_error(_request, error):
    return JSONResponse({'detail': [{'type': e['type'], 'loc': e['loc'], 'msg': e['msg']}
                                    for e in error.errors()[:20]]}, status_code=422)

@app.get('/health')
def health():
    return {'status': 'ok', 'region': HEADERS['X-Probe-Region']}

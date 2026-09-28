"""Controlled probe server with durable, idempotent local ingestion."""
import os

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
app = FastAPI(title="Capstone Probe Server", version="0.2.0")
app.include_router(router)


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

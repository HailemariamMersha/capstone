"""Controlled probe server with durable, idempotent local ingestion."""
import os

from backend.ingestion import router

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

MIB = 1024 * 1024
DOWNLOAD_SIZES = {MIB, 5 * MIB, 10 * MIB}
MAX_UPLOAD_BYTES = MIB
PAYLOAD = os.urandom(max(DOWNLOAD_SIZES))
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
    if size not in DOWNLOAD_SIZES:
        raise HTTPException(400, "Supported sizes: 1048576, 5242880, 10485760 bytes")
    return Response(PAYLOAD[:size], media_type="application/octet-stream", headers=HEADERS)


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
        if declared > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Upload exceeds 1 MiB")
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Upload exceeds 1 MiB")
    if received == 0:
        raise HTTPException(400, "Upload must not be empty")
    if length is not None and received != declared:
        raise HTTPException(400, "Body length does not match Content-Length")
    return JSONResponse({"receivedBytes": received}, headers=HEADERS)

FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && useradd --uid 10001 --create-home skymeasure
COPY backend backend
COPY scripts/measurements/columns.json scripts/measurements/columns.json
USER skymeasure
EXPOSE 8000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-access-log", "--no-proxy-headers", "--limit-concurrency", "100"]

# Thin faster-whisper serving image (M6 transcription sidecar).
# CPU int8 via CTranslate2; the model loads on first boot and can be
# pre-baked into a derived image for faster cold starts.
FROM python:3.11-slim

RUN pip install --no-cache-dir "fastapi==0.115.6" "uvicorn==0.34.0" \
    "faster-whisper==1.1.1" "python-multipart==0.0.20" "requests>=2.32"

COPY app.py /app/app.py

# small: multilingual, ~460 MB; override to trade quality for speed
# (tiny/base) or accuracy (medium/large-v3).
ENV WHISPER_MODEL=small \
    WHISPER_COMPUTE_TYPE=int8

EXPOSE 8000
WORKDIR /app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

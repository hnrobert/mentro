# Thin bge-m3 embedding serving image (M6 semantic-search sidecar).
# OpenAI-compatible /embeddings; vectors stay on the machine.
FROM python:3.11-slim

# torch>=2.6: sentence-transformers loads bge-m3 via torch.load, which
# 2.5 refuses for non-safetensors checkpoints (CVE-2025-32434).
RUN pip install --no-cache-dir "fastapi==0.115.6" "uvicorn==0.34.0" \
    "sentence-transformers==3.3.1" "torch==2.7.1" "numpy<2"

COPY app.py /app/app.py

# BAAI/bge-m3: 1024-dim, strong CJK + English, ~2.2 GB download on
# first boot (cache it in a volume).
ENV EMBED_MODEL=BAAI/bge-m3

EXPOSE 8000
WORKDIR /app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

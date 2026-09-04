"""bge-m3 embedding sidecar (OpenAI-compatible surface).

POST /embeddings {"input": [text, ...]} -> {"data": [{"index": i, "embedding": [...]}]}
GET  /health                          -> 503 until the model finished loading,
                                         {"ok": true} afterwards
"""

import os
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")

app = FastAPI()
_model: SentenceTransformer | None = None
_load_error: str | None = None
_ready = threading.Event()


def model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL, device="cpu")
    return _model


def _background_load() -> None:
    global _load_error
    try:
        model()
    except Exception as exc:  # noqa: BLE001 - surfaced via /health
        _load_error = str(exc)
    finally:
        _ready.set()


@app.on_event("startup")
def startup() -> None:
    # Load off the request path: a /health probe must never race the
    # download/load (a probe landing mid-download used to leave a
    # half-initialized model raising meta-tensor errors for the
    # container's whole lifetime).
    threading.Thread(target=_background_load, daemon=True).start()


class EmbeddingsRequest(BaseModel):
    input: list[str]


@app.get("/health")
def health():
    if not _ready.is_set():
        raise HTTPException(status_code=503, detail="model loading")
    if _model is None:
        raise HTTPException(status_code=503, detail=_load_error or "model failed")
    return {"ok": True}


@app.post("/embeddings")
def embeddings(req: EmbeddingsRequest) -> dict:
    vectors = model().encode(
        req.input,
        batch_size=16,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    return {
        "data": [
            {"index": i, "embedding": [float(x) for x in vec]}
            for i, vec in enumerate(vectors)
        ]
    }

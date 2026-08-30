"""bge-m3 embedding sidecar (OpenAI-compatible surface).

POST /embeddings {"input": [text, ...]} -> {"data": [{"index": i, "embedding": [...]}]}
GET  /health                          -> {"ok": true} once the model is loaded
"""

import os

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")

app = FastAPI()
_model: SentenceTransformer | None = None


def model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL, device="cpu")
    return _model


class EmbeddingsRequest(BaseModel):
    input: list[str]


@app.get("/health")
def health() -> dict:
    if _model is None:
        model()
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

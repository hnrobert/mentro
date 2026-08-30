"""faster-whisper transcription sidecar.

POST /transcribe  multipart "file" -> {"segments": [{start, end, text}]}
GET  /health      -> {"ok": true} once the model is loaded

The model loads lazily on first request; /health stays 503 until then,
which matches the worker's health-poll container manager.
"""

import os

from fastapi import FastAPI, File, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

app = FastAPI()
_model: WhisperModel | None = None


def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)
    return _model


@app.get("/health")
def health() -> dict:
    if _model is None:
        # Force load on the first health probe so the poll loop doubles
        # as the "download/compile the model" wait.
        model()
    return {"ok": True}


@app.post("/transcribe")
def transcribe(file: UploadFile = File(...)) -> dict:
    data = file.file.read()
    tmp = f"/tmp/{os.getpid()}-input.wav"
    with open(tmp, "wb") as fh:
        fh.write(data)
    try:
        segments, _info = model().transcribe(
            tmp,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
        )
        return {
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text.strip()}
                for s in segments
            ]
        }
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

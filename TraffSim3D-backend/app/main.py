"""TraffSim3D backend entry point."""
from fastapi import FastAPI

from app.api.v1 import api_v1

app = FastAPI(
    title="TraffSim3D Backend",
    version="0.1.0",
    description="3D traffic simulation platform — RL engine and scene services.",
)

app.include_router(api_v1, prefix="/api/v1")


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}

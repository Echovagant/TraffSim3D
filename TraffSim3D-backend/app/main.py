"""TraffSim3D backend entry point."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_v1

app = FastAPI(
    title="TraffSim3D Backend",
    version="0.1.0",
    description="3D traffic simulation platform — RL engine and scene services.",
)

# Plan 052 follow-up: CORS for dev-mode OSM uploads.
# Without this, MapImporterView's POST /api/v1/maps/parse-osm fails
# with "Failed to fetch" because the browser blocks the cross-origin
# POST when the dev server (5173) talks to the backend (8000) directly
# (i.e. when VITE_BACKEND_URL is set explicitly and bypasses the
# vite proxy).
#
# In production both frontend + backend live on the same origin so
# this middleware is a no-op; in dev we allow the localhost origins
# the project actually uses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev (default)
        "http://127.0.0.1:5173",
        "http://localhost:4173",  # Vite preview
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_v1, prefix="/api/v1")


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


if __name__ == "__main__":
    # Convenience entry point: lets you start the server by running this
    # file directly (`python -m app.main` or `python app/main.py` from
    # the backend folder, or via VS Code's "Run Python File" button).
    # For hot-reload development, prefer `uv run uvicorn app.main:app
    # --reload --port 8000` (or the "Backend: FastAPI (uvicorn)" launch
    # config in `.vscode/launch.json`).
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)

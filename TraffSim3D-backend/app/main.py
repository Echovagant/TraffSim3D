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


if __name__ == "__main__":
    # Convenience entry point: lets you start the server by running this
    # file directly (`python -m app.main` or `python app/main.py` from
    # the backend folder, or via VS Code's "Run Python File" button).
    # For hot-reload development, prefer `uv run uvicorn app.main:app
    # --reload --port 8000` (or the "Backend: FastAPI (uvicorn)" launch
    # config in `.vscode/launch.json`).
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)

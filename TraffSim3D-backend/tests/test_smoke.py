"""Smoke tests for the FastAPI app."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ping() -> None:
    r = client.get("/api/v1/ping")
    assert r.status_code == 200
    assert r.json() == {"pong": True}

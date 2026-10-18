"""Smoke tests for the FastAPI app.

Uses httpx2 + ASGITransport (starlette 1.3+ requires httpx2; the new
httpx2 ASGITransport is async-only, so we use AsyncClient).
"""

from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_ping(client: AsyncClient) -> None:
    r = await client.get("/api/v1/ping")
    assert r.status_code == 200
    assert r.json() == {"pong": True}


@pytest.mark.asyncio
async def test_cors_allows_vite_dev_origin(client: AsyncClient) -> None:
    """Plan 052: CORS middleware must permit the Vite dev origin (5173)
    so MapImporterView's POST /api/v1/maps/parse-osm doesn't get
    blocked by the browser preflight.

    Without this middleware, the dev server's /api proxy works (same
    origin) but direct fetches to a non-default backend port fail
    silently as "Failed to fetch" in the browser console.
    """
    r = await client.options(
        "/api/v1/ping",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code in (200, 204)
    assert r.headers.get("access-control-allow-origin") in (
        "http://localhost:5173",
        "*",
    )


@pytest.mark.asyncio
async def test_cors_allows_vite_preview_origin(client: AsyncClient) -> None:
    """Plan 052: same as the dev test but for the preview server (4173)."""
    r = await client.options(
        "/api/v1/ping",
        headers={
            "Origin": "http://localhost:4173",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code in (200, 204)
    assert r.headers.get("access-control-allow-origin") in (
        "http://localhost:4173",
        "*",
    )

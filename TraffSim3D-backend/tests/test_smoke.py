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
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
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

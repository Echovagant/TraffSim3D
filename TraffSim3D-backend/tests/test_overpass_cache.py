"""Plan 056: tests for the cached Overpass fetcher.

We mock the `httpx.Client.post` call to avoid hitting
overpass-api.de (and to keep the test deterministic + fast).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.apps.maps import overpass_cache
from app.apps.maps.overpass_cache import cached_overpass_fetch


@pytest.fixture
def tmp_cache_dir(tmp_path, monkeypatch):
    """Redirect the module-level CACHE_DIR to a tmp directory."""
    monkeypatch.setattr(overpass_cache, "CACHE_DIR", tmp_path / "cache")
    (tmp_path / "cache").mkdir(parents=True, exist_ok=True)
    return overpass_cache.CACHE_DIR


def test_cache_miss_then_hit(tmp_cache_dir):
    """First call hits Overpass + writes cache; second call reads disk."""
    query = "[out:json]; node(1); out body;"
    overpass_response = {
        "version": 0.6,
        "elements": [{"type": "node", "id": 1, "lat": 0, "lon": 0}],
    }

    # First call: cache miss → HTTP POST to Overpass.
    with patch("app.apps.maps.overpass_cache.httpx.Client") as client_cls:  # noqa: N806
        client_ctx = MagicMock()
        client_ctx.__enter__ = lambda self: client_ctx
        client_ctx.__exit__ = lambda self, *a: None
        client_ctx.post.return_value = MagicMock(
            status_code=200,
            raise_for_status=lambda: None,
            json=lambda: overpass_response,
        )
        client_cls.return_value = client_ctx
        first = cached_overpass_fetch(query)

    assert first == overpass_response
    # Cache file written.
    cache_files = list(tmp_cache_dir.glob("*.json"))
    assert len(cache_files) == 1, "expected exactly one cached file"
    # And the second call should NOT make an HTTP request.
    with patch("app.apps.maps.overpass_cache.httpx.Client") as client_cls:  # noqa: N806
        client_cls.return_value.post.side_effect = AssertionError(
            "HTTP should not be called on cache hit"
        )
        second = cached_overpass_fetch(query)
    assert second == overpass_response


def test_different_queries_get_different_cache_keys(tmp_cache_dir):
    """Two different queries → two different cache files (no cross-talk)."""
    q1 = "[out:json]; node(1); out body;"
    q2 = "[out:json]; node(2); out body;"
    with patch("app.apps.maps.overpass_cache.httpx.Client") as client_cls:  # noqa: N806
        client_ctx = MagicMock()
        client_ctx.__enter__ = lambda self: client_ctx
        client_ctx.__exit__ = lambda self, *a: None
        client_ctx.post.return_value = MagicMock(
            status_code=200,
            raise_for_status=lambda: None,
            json=lambda: {"elements": [{"type": "node", "id": 1}]},
        )
        client_cls.return_value = client_ctx
        cached_overpass_fetch(q1)
        cached_overpass_fetch(q2)
    assert len(list(tmp_cache_dir.glob("*.json"))) == 2


def test_atomic_write(tmp_cache_dir):
    """The .tmp file is replaced atomically — no half-written cache
    files should ever appear in the cache directory."""
    from app.apps.maps.overpass_cache import _cache_key

    key = _cache_key("atomic-test")
    tmp = tmp_cache_dir / f"{key}.json"
    assert not tmp.exists()
    with patch("app.apps.maps.overpass_cache.httpx.Client") as client_cls:  # noqa: N806
        client_ctx = MagicMock()
        client_ctx.__enter__ = lambda self: client_ctx
        client_ctx.__exit__ = lambda self, *a: None
        client_ctx.post.return_value = MagicMock(
            status_code=200,
            raise_for_status=lambda: None,
            json=lambda: {"elements": []},
        )
        client_cls.return_value = client_ctx
        cached_overpass_fetch("atomic-test")
    # After the call: the final .json exists, no leftover .tmp.
    assert (tmp_cache_dir / f"{key}.json").exists()
    assert not (tmp_cache_dir / f"{key}.tmp").exists()

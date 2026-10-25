"""The shipped grid policy: asset shape, forward-pass parity, endpoint.

Three things are pinned here:

1. **The asset's shape** — the discrete five-action / six-observation
   export the browser's `mlpForwardDiscrete` consumes, with the metadata
   and the matrices agreeing.
2. **The asset's behaviour** — the shipped weights must reproduce the
   frontend fixture's expected actions (the two files are written by one
   generator run; this is the test that keeps them pinned together).
3. **The endpoint** — `GET /api/v1/rl/signal/grid-policy` serves the same
   payload on a base-dependency backend (no SB3 / torch involved).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.apps.rl import grid_policy
from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES
from app.main import app

REPO_ROOT = Path(__file__).resolve().parents[2]
#: The frontend's forward-pass fixture — the other half of the pin.
FIXTURE_PATH = (
    REPO_ROOT
    / "TraffSim3D-frontend"
    / "src"
    / "infrastructure"
    / "rl"
    / "fixtures"
    / "network-mappo-policy-fixture.json"
)


def test_the_shipped_policy_has_the_signal_shape() -> None:
    policy = grid_policy.load_grid_policy()

    assert policy["action_space"] == "discrete"
    assert policy["obs_dim"] == 6
    assert policy["action_dim"] == 5
    assert policy["hidden_sizes"] == [64, 64]
    assert "log_std" not in policy["layers"]
    assert policy["action_names"] == list(SIGNAL_ACTION_NAMES)
    # The delivery markers the browser keys on.
    assert policy["policy_kind"] == "signal"
    assert policy["source"] == "shipped"


def test_the_shipped_weights_reproduce_the_fixtures_expected_actions() -> None:
    if not FIXTURE_PATH.exists():
        pytest.skip("the frontend tree is not checked out next to the backend")
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    policy = grid_policy.load_grid_policy()

    layers = policy["layers"]
    actions = [forward_discrete(obs, layers) for obs in fixture["observations"]]

    assert actions == fixture["expected_actions"]


def test_repeated_loads_return_equal_but_distinct_copies() -> None:
    first = grid_policy.load_grid_policy()
    second = grid_policy.load_grid_policy()

    assert first == second
    assert first is not second
    # Mutating one copy must not poison the cache.
    first["layers"]["action_net.bias"][0] = 999.0
    assert grid_policy.load_grid_policy()["layers"]["action_net.bias"][0] != 999.0


@pytest.mark.asyncio
async def test_the_endpoint_serves_the_shipped_policy() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/rl/signal/grid-policy")

    assert response.status_code == 200
    body = response.json()
    assert body == grid_policy.load_grid_policy()
    assert body["action_space"] == "discrete"
    assert body["obs_dim"] == 6
    assert body["action_dim"] == 5


# --------------------------------------------------------------------------
# The pure-Python reference forward pass — the same computation the fixture
# generator ran (float64, same operation order as the TypeScript side).
# --------------------------------------------------------------------------


def forward_discrete(obs: list[float], layers: dict[str, Any]) -> int:
    """The argmax of the action logits for one observation."""

    def linear(w: list[list[float]], b: list[float], x: list[float]) -> list[float]:
        return [
            sum(wi * xi for wi, xi in zip(row, x, strict=True)) + bi
            for row, bi in zip(w, b, strict=True)
        ]

    h = [
        math.tanh(v)
        for v in linear(layers["policy_net.0.weight"], layers["policy_net.0.bias"], obs)
    ]
    h = [
        math.tanh(v) for v in linear(layers["policy_net.2.weight"], layers["policy_net.2.bias"], h)
    ]
    logits = linear(layers["action_net.weight"], layers["action_net.bias"], h)
    best = 0
    for i in range(1, len(logits)):
        if logits[i] > logits[best]:
            best = i
    return best

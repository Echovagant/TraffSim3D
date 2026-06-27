"""Plan 044: API endpoint tests for /api/v1/rl/*.

Uses httpx2 + ASGITransport (in-process, no subprocess overhead).
`status.get_status_path()` is bound at module-import time, so we
use a shared file path and clear it per test (simpler than reloading
modules).
"""
from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.apps.rl import status as rl_status
from app.main import app

STATUS_PATH = rl_status.get_status_path()


@pytest.fixture
async def client():
    # Clean slate per test
    if STATUS_PATH.exists():
        STATUS_PATH.unlink()
    rl_status.write_status({})  # ensure fresh empty status
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c
    if STATUS_PATH.exists():
        STATUS_PATH.unlink()


@pytest.mark.asyncio
async def test_dry_run_train_writes_status(client: AsyncClient) -> None:
    r0 = await client.get("/api/v1/rl/status")
    assert r0.status_code == 200
    assert r0.json()["step"] == 0

    r1 = await client.post(
        "/api/v1/rl/train",
        json={"steps": 200, "dry_run": True},
    )
    assert r1.status_code == 200
    assert "ok" in r1.text

    r2 = await client.get("/api/v1/rl/status")
    s2 = r2.json()
    assert s2["running"] is False
    assert s2["episode_count"] == 1
    assert len(s2["reward_history"]) == 1


@pytest.mark.asyncio
async def test_status_returns_empty_when_no_training(client: AsyncClient) -> None:
    r = await client.get("/api/v1/rl/status")
    assert r.status_code == 200
    s = r.json()
    for key in ("running", "step", "episode_count", "last_reward", "reward_history"):
        assert key in s


@pytest.mark.asyncio
async def test_checkpoints_endpoint_returns_list_shape(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """GET /api/v1/rl/checkpoints returns {checkpoints: [...]}."""
    # Redirect checkpoint dir to tmp so list returns []
    from app.apps.rl import checkpoint as ckpt
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path / "nonexistent")
    r = await client.get("/api/v1/rl/checkpoints")
    assert r.status_code == 200
    body = r.json()
    assert "checkpoints" in body
    assert isinstance(body["checkpoints"], list)


@pytest.mark.asyncio
async def test_train_accepts_n_agents_and_save_every(client: AsyncClient) -> None:
    """POST /api/v1/rl/train with n_agents=3, save_every=2000 in dry-run."""
    r = await client.post(
        "/api/v1/rl/train",
        json={"steps": 600, "dry_run": True, "device": "auto",
              "n_agents": 3, "save_every": 2000},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["n_agents"] == 3
    # Status should now reflect n_agents
    r2 = await client.get("/api/v1/rl/status")
    s = r2.json()
    assert s["n_agents"] == 3
    # 600 steps / 200 per episode = 3 episodes
    assert s["episode_count"] == 3


@pytest.mark.asyncio
async def test_train_independent_writes_agent_rewards(client: AsyncClient) -> None:
    """Plan 047: independent dry-run produces per-agent reward dict."""
    r = await client.post(
        "/api/v1/rl/train",
        json={"steps": 600, "dry_run": True, "device": "auto",
              "n_agents": 2, "independent_agents": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["independent_agents"] is True
    # Status should reflect per-agent rewards
    r2 = await client.get("/api/v1/rl/status")
    s = r2.json()
    assert s["independent_agents"] is True
    assert "agent_rewards" in s
    assert set(s["agent_rewards"].keys()) == {"0", "1"}
    # Each agent has 600/200 = 3 episodes
    assert len(s["agent_rewards"]["0"]) == 3
    assert len(s["agent_rewards"]["1"]) == 3
    # Latest checkpoint string lists per-agent files
    assert "agent0" in s["latest_checkpoint"]
    assert "agent1" in s["latest_checkpoint"]


@pytest.mark.asyncio
async def test_scenes_endpoint_returns_list(client: AsyncClient) -> None:
    """Plan 048: GET /api/v1/rl/scenes returns the supported scene kinds."""
    r = await client.get("/api/v1/rl/scenes")
    assert r.status_code == 200
    assert r.json() == {"scenes": ["cross", "corridor"]}


@pytest.mark.asyncio
async def test_train_accepts_scene_kind_corridor(client: AsyncClient) -> None:
    """Plan 048: dry-run with scene_kind='corridor' persists the field."""
    r = await client.post(
        "/api/v1/rl/train",
        json={"steps": 200, "dry_run": True, "scene_kind": "corridor"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["scene_kind"] == "corridor"
    r2 = await client.get("/api/v1/rl/status")
    assert r2.json()["scene_kind"] == "corridor"


@pytest.mark.asyncio
async def test_weights_endpoint_404_for_missing_checkpoint(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    """Plan 049: GET /weights with a name not in the list returns 404."""
    from app.apps.rl import checkpoint as ckpt
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path / "nonexistent")
    r = await client.get("/api/v1/rl/checkpoints/nonexistent.zip/weights")
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_weights_endpoint_returns_json_for_existing_checkpoint(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    """Plan 049: GET /weights for a real SB3 .zip returns architecture + layers."""
    # Save a tiny PPO model directly to tmp and point the checkpoint
    # module at it. We use a fresh model (not the full train pipeline)
    # because that takes seconds; the weights layout is identical.
    from stable_baselines3 import PPO

    from app.apps.rl import checkpoint as ckpt
    from app.apps.rl.env import TrafficEnv
    env = TrafficEnv()
    model = PPO("MlpPolicy", env, verbose=0, n_steps=64)
    target = tmp_path / "pid9999" / "ppo_step_0000064.zip"
    target.parent.mkdir(parents=True)
    model.save(str(target))

    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path)
    r = await client.get(
        "/api/v1/rl/checkpoints/ppo_step_0000064.zip/weights"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "ppo_step_0000064.zip"
    assert body["obs_dim"] == 13
    assert body["action_dim"] == 2
    assert body["hidden_sizes"] == [64, 64]
    layers = body["layers"]
    # PyTorch nn.Linear stores (out, in); shapes match the verified layout.
    assert len(layers["policy_net.0.weight"]) == 64
    assert len(layers["policy_net.0.weight"][0]) == 13
    assert len(layers["policy_net.0.bias"]) == 64
    assert len(layers["policy_net.2.weight"]) == 64
    assert len(layers["policy_net.2.weight"][0]) == 64
    assert len(layers["action_net.weight"]) == 2
    assert len(layers["action_net.weight"][0]) == 64
    assert len(layers["action_net.bias"]) == 2
    assert len(layers["log_std"]) == 2


@pytest.mark.asyncio
async def test_weights_endpoint_503_when_sb3_missing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    """Plan 049: when SB3 is uninstalled, GET /weights returns 503."""
    from app.apps.rl import checkpoint as ckpt
    # Drop a stub .zip in the checkpoint dir (no SB3 needed for the list),
    # then monkeypatch export_weights to raise WeightsUnavailable.
    target = tmp_path / "pid9999" / "ppo_step_0000064.zip"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"PK\x03\x04")  # zip magic header (will never be opened)
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path)

    from app.apps.rl import weights as rl_weights
    from app.apps.rl.weights import WeightsUnavailableError

    def _raise(_p):
        raise WeightsUnavailableError("stable-baselines3 not installed")
    monkeypatch.setattr(rl_weights, "export_weights", _raise)

    r = await client.get(
        "/api/v1/rl/checkpoints/ppo_step_0000064.zip/weights"
    )
    assert r.status_code == 503
    assert "unavailable" in r.json()["detail"].lower()
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

# NOTE: there is deliberately no module-level `STATUS_PATH` any more. It was
# captured at import time and pointed at the real `<backend>/.data/` directory,
# so every test in this file mutated shared on-disk state. The `client` fixture
# now redirects `rl_status._DEFAULT_PATH` into `tmp_path` and resolves the path
# through `rl_status.get_status_path()` after that monkeypatch.


@pytest.fixture
async def client(tmp_path, monkeypatch):
    # Isolate the training-status file into tmp_path.
    #
    # `rl_status._DEFAULT_PATH` is resolved at *import* time (status.py:17), so
    # before this fix every test in this file read and wrote the REAL
    # `<backend>/.data/training_status.json`. That produced cross-test state
    # bleed and, on Windows, `PermissionError` when a previous run's handle was
    # still open — the ~1-in-6 flake two parallel agents independently hit and
    # reported. The control channel was already isolated one line below; the
    # status file was the gap.
    monkeypatch.setattr(rl_status, "_DEFAULT_PATH", tmp_path / "training_status.json")

    from app.apps.rl import control as rl_control

    monkeypatch.setattr(rl_control, "_DEFAULT_PATH", tmp_path / "control.json")

    status_path = rl_status.get_status_path()
    rl_status.write_status({})  # ensure fresh empty status
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    if status_path.exists():
        status_path.unlink()


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
        json={"steps": 600, "dry_run": True, "device": "auto", "n_agents": 3, "save_every": 2000},
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
        json={
            "steps": 600,
            "dry_run": True,
            "device": "auto",
            "n_agents": 2,
            "independent_agents": True,
        },
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
    """Plan 048/076: GET /api/v1/rl/scenes returns the supported scene kinds.

    Plan 076 T13 added `cross_signalled` — the scene whose ego axis starts
    red, i.e. the one in which a scripted baseline is provably not optimal.
    """
    r = await client.get("/api/v1/rl/scenes")
    assert r.status_code == 200
    assert r.json() == {
        "scenes": ["cross", "corridor", "t_junction", "roundabout", "cross_signalled"]
    }


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
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Plan 049: GET /weights with a name not in the list returns 404."""
    from app.apps.rl import checkpoint as ckpt

    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path / "nonexistent")
    r = await client.get("/api/v1/rl/checkpoints/nonexistent.zip/weights")
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_weights_endpoint_returns_json_for_existing_checkpoint(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Plan 049: GET /weights for a real SB3 .zip returns architecture + layers."""
    # Save a tiny PPO model directly to tmp and point the checkpoint
    # module at it. We use a fresh model (not the full train pipeline)
    # because that takes seconds; the weights layout is identical.
    # SB3 is an optional dependency (`uv sync --extra rl`); skip cleanly
    # when absent rather than erroring — the 503 path is covered by
    # test_weights_endpoint_503_when_sb3_missing.
    pytest.importorskip("stable_baselines3", reason="needs --extra rl")
    from stable_baselines3 import PPO

    from app.apps.rl import checkpoint as ckpt
    from app.apps.rl.env import TrafficEnv

    env = TrafficEnv()
    model = PPO("MlpPolicy", env, verbose=0, n_steps=64)
    target = tmp_path / "pid9999" / "ppo_step_0000064.zip"
    target.parent.mkdir(parents=True)
    model.save(str(target))

    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path)
    r = await client.get("/api/v1/rl/checkpoints/ppo_step_0000064.zip/weights")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "ppo_step_0000064.zip"
    assert body["obs_dim"] == 14
    assert body["action_dim"] == 2
    assert body["hidden_sizes"] == [64, 64]
    layers = body["layers"]
    # PyTorch nn.Linear stores (out, in); shapes match the verified layout.
    assert len(layers["policy_net.0.weight"]) == 64
    assert len(layers["policy_net.0.weight"][0]) == 14
    assert len(layers["policy_net.0.bias"]) == 64
    assert len(layers["policy_net.2.weight"]) == 64
    assert len(layers["policy_net.2.weight"][0]) == 64
    assert len(layers["action_net.weight"]) == 2
    assert len(layers["action_net.weight"][0]) == 64
    assert len(layers["action_net.bias"]) == 2
    assert len(layers["log_std"]) == 2


@pytest.mark.asyncio
async def test_weights_endpoint_503_when_sb3_missing(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
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

    r = await client.get("/api/v1/rl/checkpoints/ppo_step_0000064.zip/weights")
    assert r.status_code == 503
    assert "unavailable" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_weights_endpoint_404_when_the_file_vanishes_mid_request(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """TOCTOU: the checkpoint disappears between the exists() check and the load.

    `export_weights()` raises `FileNotFoundError` for a missing file (correct for
    a library function), which the endpoint's original `except WeightsUnavailableError`
    did not catch — so this race surfaced as a 500 instead of a 404. Fixed
    2026-10-18 by mapping `FileNotFoundError` to the same 404 the up-front
    check produces.
    """
    from app.apps.rl import checkpoint as ckpt
    from app.apps.rl import weights as rl_weights

    target = tmp_path / "pid9999" / "ppo_step_0000064.zip"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"PK\x03\x04")
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path)

    def _vanished(_p):
        raise FileNotFoundError("checkpoint not found")

    monkeypatch.setattr(rl_weights, "export_weights", _vanished)

    r = await client.get("/api/v1/rl/checkpoints/ppo_step_0000064.zip/weights")
    assert r.status_code == 404, r.text
    assert "missing" in r.json()["detail"].lower()


# --- M4 Must: training task control (pause / resume / terminate) ------------


@pytest.mark.asyncio
async def test_control_endpoints_409_when_no_run(client: AsyncClient) -> None:
    """No active run -> every control verb is a conflict, not a silent 200."""
    for path in ("pause", "resume", "terminate"):
        r = await client.post(f"/api/v1/rl/train/{path}")
        assert r.status_code == 409, f"{path} should 409 without a live run"
        assert "no active training" in r.json()["detail"]


@pytest.mark.asyncio
async def test_pause_resume_terminate_roundtrip(client: AsyncClient) -> None:
    rl_status.init_status(1000)

    r1 = await client.post("/api/v1/rl/train/pause")
    assert r1.status_code == 200
    body = r1.json()
    assert body["ok"] is True
    assert body["action"] == "pause"
    assert body["state"] == "paused"
    assert body["epoch"] == 1

    r2 = await client.post("/api/v1/rl/train/resume")
    assert r2.status_code == 200
    assert r2.json()["state"] == "running"
    assert r2.json()["epoch"] == 2

    r3 = await client.post("/api/v1/rl/train/terminate")
    assert r3.status_code == 200
    assert r3.json()["state"] == "terminated"
    assert r3.json()["epoch"] == 3


@pytest.mark.asyncio
async def test_pause_is_idempotent(client: AsyncClient) -> None:
    """Two pauses must not queue a double-pause that strands the trainer."""
    rl_status.init_status(1000)
    a = (await client.post("/api/v1/rl/train/pause")).json()
    b = (await client.post("/api/v1/rl/train/pause")).json()
    assert a["state"] == b["state"] == "paused"
    assert b["epoch"] > a["epoch"]  # request recorded, desired state unchanged


@pytest.mark.asyncio
async def test_terminate_works_while_paused(client: AsyncClient) -> None:
    """The pause loop must still observe a terminate issued during a pause."""
    rl_status.init_status(1000)
    await client.post("/api/v1/rl/train/pause")
    r = await client.post("/api/v1/rl/train/terminate")
    assert r.status_code == 200
    assert r.json()["state"] == "terminated"


@pytest.mark.asyncio
async def test_status_reports_paused_flag(client: AsyncClient) -> None:
    rl_status.init_status(1000)
    assert (await client.get("/api/v1/rl/status")).json()["paused"] is False
    rl_status.set_paused(True)
    assert (await client.get("/api/v1/rl/status")).json()["paused"] is True


@pytest.mark.asyncio
async def test_train_start_clears_stale_control(client: AsyncClient) -> None:
    """A leftover pause must not kill the next run the moment it starts."""
    from app.apps.rl import control as rl_control

    rl_status.init_status(1000)
    await client.post("/api/v1/rl/train/pause")
    assert rl_control.read_control()["state"] == "paused"

    await client.post("/api/v1/rl/train", json={"steps": 50, "dry_run": True})
    assert rl_control.read_control()["state"] == "running"


@pytest.mark.asyncio
async def test_finalize_clears_paused_flag(client: AsyncClient) -> None:
    rl_status.init_status(1000)
    rl_status.set_paused(True)
    rl_status.finalize_status("terminated_by_request")
    s = rl_status.read_status()
    assert s["running"] is False
    assert s["paused"] is False
    assert s["reason"] == "terminated_by_request"

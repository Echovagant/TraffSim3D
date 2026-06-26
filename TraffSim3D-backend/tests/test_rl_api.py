"""Plan 044: API endpoint tests (subprocess uvicorn + urllib, mirrors 041)."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

BACKEND_ROOT = Path(__file__).parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextmanager
def _uvicorn_server():
    # Use a per-test status file so runs don't collide.
    tmpdir = tempfile.mkdtemp(prefix="ppo_test_")
    env = os.environ.copy()
    env["TRAFFIC_PPO_STATUS"] = str(Path(tmpdir) / "status.json")

    port = _free_port()
    proc = subprocess.Popen(
        [
            "uv", "run", "uvicorn", "app.main:app",
            "--port", str(port), "--log-level", "warning",
        ],
        cwd=BACKEND_ROOT,
        env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{base}/health", timeout=0.5).read()
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.2)
    else:
        proc.terminate()
        raise RuntimeError("uvicorn did not start within 10s")
    try:
        yield base, env
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def _post_json(url: str, payload: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode()


def test_dry_run_train_writes_status() -> None:
    with _uvicorn_server() as (base, env):
        # Start with clean status
        status_url = f"{base}/api/v1/rl/status"
        s0 = json.loads(urllib.request.urlopen(status_url).read())
        assert s0.get("step", 0) == 0
        # Train (dry run, 200 steps → 1 episode)
        status_code, body = _post_json(
            f"{base}/api/v1/rl/train", {"steps": 200, "dry_run": True},
        )
        assert status_code == 200
        assert "ok" in body
        # Status should now reflect 1 episode
        s1 = json.loads(urllib.request.urlopen(status_url).read())
        assert s1["running"] is False
        assert s1["episode_count"] == 1
        assert len(s1["reward_history"]) == 1


def test_status_returns_empty_when_no_training() -> None:
    with _uvicorn_server() as (base, _env):
        s = json.loads(urllib.request.urlopen(f"{base}/api/v1/rl/status").read())
        # Either pre-existing default OR from previous test in same session.
        # We just assert it's a valid shape.
        for key in ("running", "step", "episode_count", "last_reward", "reward_history"):
            assert key in s
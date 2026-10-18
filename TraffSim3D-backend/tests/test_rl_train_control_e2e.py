"""End-to-end: a real training subprocess must obey pause/resume/terminate.

`test_rl_control.py` covers the control channel itself. This module covers
the half that actually matters in production — that the trainer loop *acts*
on a request written by the API process.

SB3 is not installed in the default dev environment, so a real `real_train`
run would fall back to the dry-run path. Rather than depend on a ~2 GB
torch install, this drives `_control_gate()` inside a real subprocess and
asserts the observable effects: it blocks while paused, returns on resume,
and reports terminate so the SB3 callback can halt.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _child_env(status_path: Path, control_path: Path) -> dict[str, str]:
    return {
        "TRAFFIC_PPO_STATUS": str(status_path),
        "TRAFFIC_PPO_CONTROL": str(control_path),
        "PATH": "",
        "SYSTEMROOT": "",
        "PYTHONPATH": str(BACKEND_ROOT),
    }


def test_gate_reports_terminate_so_sb3_stops(tmp_path: Path) -> None:
    """A terminate request must surface as should_stop."""
    status_path = tmp_path / "status.json"
    control_path = tmp_path / "control.json"

    script = (
        "import json\n"
        "from app.apps.rl import control as ctl\n"
        "from app.apps.rl.train import _control_gate\n"
        "ctl.request('terminate')\n"
        "stop, epoch = _control_gate()\n"
        "print(json.dumps({'stop': stop, 'epoch': epoch}))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(BACKEND_ROOT),
        env=_child_env(status_path, control_path),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, f"child failed:\n{proc.stdout}\n{proc.stderr}"
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result["stop"] is True  # -> the SB3 callback returns False


def test_gate_blocks_on_pause_then_resumes(tmp_path: Path) -> None:
    """A paused trainer must not advance; resume must unblock it."""
    from app.apps.rl import control as rl_control

    status_path = tmp_path / "status.json"
    control_path = tmp_path / "control.json"
    # Point *this* process's control module at the child's file so the test
    # can flip the request the child is waiting on.
    rl_control._DEFAULT_PATH = control_path  # noqa: SLF001
    try:
        script = (
            "import json\n"
            "from app.apps.rl import control as ctl\n"
            "from app.apps.rl.train import _control_gate\n"
            "ctl.request('pause')\n"
            "stop, epoch = _control_gate()\n"
            "print(json.dumps({'stop': stop, 'epoch': epoch}))\n"
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            cwd=str(BACKEND_ROOT),
            env=_child_env(status_path, control_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            time.sleep(1.5)
            assert proc.poll() is None, "trainer should still be blocked while paused"
            rl_control.request("resume")
            out, err = proc.communicate(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

        assert proc.returncode == 0, f"child failed:\n{out}\n{err}"
        result = json.loads(out.strip().splitlines()[-1])
        assert result["stop"] is False  # resume -> keep training
    finally:
        rl_control._DEFAULT_PATH = Path(rl_control._DEFAULT_PATH)  # type: ignore[arg-type]
        # restore the module default for the rest of the session
        import importlib

        importlib.reload(rl_control)


def test_gate_terminates_out_of_a_pause(tmp_path: Path) -> None:
    """terminate issued *while* paused must still be observed."""
    status_path = tmp_path / "status.json"
    control_path = tmp_path / "control.json"

    script = (
        "import json\n"
        "from app.apps.rl import control as ctl\n"
        "from app.apps.rl.train import _control_gate\n"
        "ctl.request('pause')\n"
        # Flip to terminate after the gate has had a chance to block.
        "import threading, time\n"
        "def flip():\n"
        "    time.sleep(0.4)\n"
        "    ctl.request('terminate')\n"
        "threading.Thread(target=flip, daemon=True).start()\n"
        "stop, epoch = _control_gate()\n"
        "print(json.dumps({'stop': stop, 'epoch': epoch}))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(BACKEND_ROOT),
        env=_child_env(status_path, control_path),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, f"child failed:\n{proc.stdout}\n{proc.stderr}"
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result["stop"] is True

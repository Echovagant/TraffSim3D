"""M4 Must: training task control — pause / resume / terminate.

Training runs as a detached subprocess (see `api/v1/rl.py` train endpoint),
so the API process cannot reach into it. Control therefore travels through a
small JSON file, mirroring the existing `status.py` pattern — deliberately
*not* POSIX signals, which do not exist on Windows.

The file holds a **desired state** rather than an event queue, so a repeated
`pause` is idempotent and a request made while paused (e.g. `terminate`) is
never lost.
"""
from __future__ import annotations

import json

import pytest

from app.apps.rl import control as rl_control


@pytest.fixture
def control_file(tmp_path, monkeypatch):
    """Point the control channel at an isolated temp file."""
    path = tmp_path / "control.json"
    monkeypatch.setattr(rl_control, "_DEFAULT_PATH", path)
    return path


# --------------------------------------------------------------------------
# request / read
# --------------------------------------------------------------------------


def test_request_pause_writes_paused_state(control_file) -> None:
    out = rl_control.request("pause")
    assert out["state"] == rl_control.STATE_PAUSED
    assert out["epoch"] == 1
    assert json.loads(control_file.read_text(encoding="utf-8"))["state"] == "paused"


def test_request_bumps_epoch(control_file) -> None:
    assert rl_control.request("pause")["epoch"] == 1
    assert rl_control.request("resume")["epoch"] == 2
    assert rl_control.request("terminate")["epoch"] == 3


def test_request_rejects_unknown_action(control_file) -> None:
    with pytest.raises(ValueError, match="unknown control action"):
        rl_control.request("nuke")


def test_read_control_missing_file_is_running(control_file) -> None:
    assert rl_control.read_control()["state"] == rl_control.STATE_RUNNING
    assert rl_control.read_control()["epoch"] == 0


def test_read_control_corrupt_file_is_running(control_file) -> None:
    """A truncated/garbage file must not wedge the trainer."""
    control_file.write_text("{not json", encoding="utf-8")
    assert rl_control.read_control()["state"] == rl_control.STATE_RUNNING


# --------------------------------------------------------------------------
# poll — non-blocking, epoch-aware
# --------------------------------------------------------------------------


def test_poll_reports_new_request(control_file) -> None:
    rl_control.request("pause")
    assert rl_control.poll(seen_epoch=0) == (rl_control.STATE_PAUSED, 1)


def test_poll_is_idempotent_for_same_epoch(control_file) -> None:
    rl_control.request("pause")
    assert rl_control.poll(seen_epoch=1) == (rl_control.STATE_PAUSED, 1)


def test_poll_sees_terminate_after_pause(control_file) -> None:
    """A terminate issued while paused must still be observable."""
    rl_control.request("pause")
    state, epoch = rl_control.poll(seen_epoch=1)
    assert state == rl_control.STATE_PAUSED
    rl_control.request("terminate")
    assert rl_control.poll(seen_epoch=epoch) == (rl_control.STATE_TERMINATED, 2)


# --------------------------------------------------------------------------
# wait_while_paused — blocking until the state changes
# --------------------------------------------------------------------------


def test_wait_returns_immediately_when_running(control_file) -> None:
    slept: list[float] = []
    state, epoch = rl_control.wait_while_paused(0, sleep=slept.append)
    assert state == rl_control.STATE_RUNNING
    assert slept == []  # never blocks when not paused


def test_wait_blocks_until_terminated(control_file) -> None:
    rl_control.request("pause")
    # A scripted "sleep" flips the request after the 3rd poll.
    pending = [3]

    def fake_sleep(_seconds: float) -> None:
        pending[0] -= 1
        if pending[0] <= 0:
            rl_control.request("terminate")

    state, epoch = rl_control.wait_while_paused(0, sleep=fake_sleep)
    assert state == rl_control.STATE_TERMINATED
    assert epoch == 2
    assert pending[0] <= 0  # actually waited


def test_wait_blocks_until_resumed(control_file) -> None:
    rl_control.request("pause")
    pending = [2]

    def fake_sleep(_seconds: float) -> None:
        pending[0] -= 1
        if pending[0] <= 0:
            rl_control.request("resume")

    state, epoch = rl_control.wait_while_paused(0, sleep=fake_sleep)
    assert state == rl_control.STATE_RUNNING
    assert epoch == 2


def test_wait_gives_up_after_timeout(control_file) -> None:
    """A pause with no resume must not hang the trainer forever."""
    rl_control.request("pause")
    calls = {"n": 0}

    def fake_sleep(_seconds: float) -> None:
        calls["n"] += 1

    state, epoch = rl_control.wait_while_paused(
        0, timeout_s=5.0, poll_interval_s=1.0, sleep=fake_sleep,
    )
    # 5.0s / 1.0s = 5 polls, then the watchdog bails out.
    assert calls["n"] == 5
    assert state == rl_control.STATE_PAUSED  # still paused, not a false resume
    assert epoch == 1


# --------------------------------------------------------------------------
# clear
# --------------------------------------------------------------------------


def test_clear_resets_to_running(control_file) -> None:
    rl_control.request("pause")
    rl_control.clear_control()
    assert rl_control.read_control()["state"] == rl_control.STATE_RUNNING

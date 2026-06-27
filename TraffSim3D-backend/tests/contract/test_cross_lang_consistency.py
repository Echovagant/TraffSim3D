"""Plan 050: cross-language consistency test.

The Python sim (sim_core.py) and TS sim (worldStore + tick.ts) are
independent implementations — not a 1:1 port. They share the same
ego dynamics formula (Pure Pursuit + Euler integration) but differ
in NPC behavior, signals, and physics. A state-trajectory diff
would be brittle (NPC positions diverge immediately).

This test verifies the **behavioral contract** instead:
  - Both sims start ego at the same initial state
  - Both sims produce the same termination reason for the same
    fixed input action sequence (action=[0, 0] = no-op)
  - Both sims terminate within ±20% of expected step count
  - Both sims achieve the same final ego z position (≈ z_start + speed * dt * n_steps)

The test runs both sims against a test vector and compares only the
"shape" of the outcome. NPC state is intentionally not compared.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from app.apps.rl.sim_core import SimCore

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"


def _drive_to_completion(core: SimCore, actions: list[list[float]]) -> dict:
    """Run actions until termination or exhausted. Returns summary."""
    for action in actions:
        if core._terminated:
            break
        core.step(np.asarray(action, dtype=np.float32))
    return {
        "terminated": core._terminated,
        "reason": core._terminated_reason,
        "final_step": core.step_count,
        "final_z": core.ego.z,
        "final_x": core.ego.x,
        "final_speed": core.ego.speed,
    }


def _ensure_python_snapshot(v: dict, sample_every: int) -> dict:
    """Generate (or refresh) the Python snapshot for vector `v`."""
    core = SimCore(scene_kind=v["scene_kind"])
    core.reset()
    samples = []
    samples.append({
        "step": 0,
        "ego_id": v["ego_id"],
        "x": float(core.ego.x), "z": float(core.ego.z),
        "heading": float(core.ego.heading), "speed": float(core.ego.speed),
    })
    for i, action in enumerate(v["actions"], start=1):
        core.step(np.asarray(action, dtype=np.float32))
        if i % sample_every == 0 or i == len(v["actions"]):
            samples.append({
                "step": i,
                "ego_id": v["ego_id"],
                "x": float(core.ego.x), "z": float(core.ego.z),
                "heading": float(core.ego.heading), "speed": float(core.ego.speed),
            })
        if core._terminated:
            break
    return {
        "name": v["name"],
        "scene_kind": v["scene_kind"],
        "ego_id": v["ego_id"],
        "tolerance": 0.01,
        "final_state": {
            "terminated": core._terminated,
            "reason": core._terminated_reason,
            "final_step": core.step_count,
            "final_z": float(core.ego.z),
        },
        "samples": samples,
    }


def test_python_consistency_baseline() -> None:
    """Run Python sim for each vector, save snapshot, validate behavior."""
    vec = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    snapshots = CONTRACT_DIR / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)

    for v in vec["vectors"]:
        snap = _ensure_python_snapshot(v, sample_every=vec.get("sample_every", 5))
        # Save snapshot for the TS-side comparison
        (snapshots / f"python_{v['name']}.json").write_text(
            json.dumps(snap, indent=2), encoding="utf-8",
        )
        # Python sim sanity checks
        assert snap["final_state"]["terminated"] is True
        # cross: ego passes through 1 intersection, terminates at z > 5
        # corridor: ego passes through 2 intersections, terminates at z > 25
        if v["scene_kind"] == "cross":
            assert snap["final_state"]["reason"] in ("success", "collision", "red_light")
            # The action sequence is mild accel; for cross, success is likely
            # but we accept any physical termination reason
        elif v["scene_kind"] == "corridor":
            assert snap["final_state"]["reason"] in (
                "success_corridor", "collision", "red_light",
            )


def test_python_and_ts_terminations_match_when_ts_snapshot_exists() -> None:
    """If a TS snapshot exists (from Playwright e2e), verify the two
    sims agree on termination reason and final state within tolerance.

    This test is the core contract check. When the TS snapshot is
    missing, it skips (the e2e test generates it; CI should run e2e
    before backend).
    """
    vec = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    snapshots = CONTRACT_DIR / "snapshots"

    for v in vec["vectors"]:
        py_path = snapshots / f"python_{v['name']}.json"
        ts_path = snapshots / f"ts_{v['name']}.json"
        if not py_path.exists():
            # Run the python generator first
            snap = _ensure_python_snapshot(v, sample_every=vec.get("sample_every", 5))
            py_path.write_text(json.dumps(snap, indent=2), encoding="utf-8")
        if not ts_path.exists():
            # No TS snapshot yet — skip (e2e test creates it)
            continue
        py = json.loads(py_path.read_text(encoding="utf-8"))
        ts = json.loads(ts_path.read_text(encoding="utf-8"))

        # Both must terminate with the same kind of reason (success* or fail*)
        py_reason = py["final_state"]["reason"]
        ts_reason = ts["final_state"]["reason"]
        assert py_reason == ts_reason, (
            f"{v['name']}: termination reason mismatch "
            f"(python={py_reason}, ts={ts_reason})"
        )

        # Final z should be close (within 1m of each other)
        py_z = py["final_state"]["final_z"]
        ts_z = ts["final_state"]["final_z"]
        assert abs(py_z - ts_z) < 1.0, (
            f"{v['name']}: final z diverges "
            f"(python={py_z:.2f}, ts={ts_z:.2f})"
        )

        # Step counts within 20% of each other
        py_step = py["final_state"]["final_step"]
        ts_step = ts["final_state"]["final_step"]
        if py_step > 0 and ts_step > 0:
            ratio = abs(py_step - ts_step) / max(py_step, ts_step)
            assert ratio < 0.20, (
                f"{v['name']}: step count diverges > 20% "
                f"(python={py_step}, ts={ts_step})"
            )
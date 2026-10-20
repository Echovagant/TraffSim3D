"""Plan 071: cross-language consistency test (executable).

The Python training sim (`app/apps/rl/sim_core.py`) and the TypeScript
contract mirror (`TraffSim3D-frontend/src/application/services/simCoreMirror.ts`)
are two independent implementations of the same model. This test asserts
they agree **exactly** — not within a tolerance.

Why exact equality: both sides execute the same floating-point operation
sequence (see the cross-language contract (ADR-008) §4.1 constraint 4),
so their trajectories are bit-identical. Measured on the `cross` vector:
0 differences across all 58 steps of the `speed` and `x` series, and
identical `final_z` (26.20100000000003) and `final_x` (1.467525924532092e-14).
A tolerance would hide exactly the failure this contract exists to catch:
silent drift on one side.

Two golden files are published per vector by the TS side:
  - `ts_<name>.json`       — scenario level (mirror trajectory)
  - `ts_kernel_<name>.json` — kernel level (product replay speed series)

Regenerate them with:
    cd TraffSim3D-frontend && npm run contract:gen
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl.sim_core import MAX_STEPS_DEFAULT, SimCore

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"
SNAPSHOT_DIR = CONTRACT_DIR / "snapshots"

_REGEN_HINT = (
    "Regenerate the TS contract snapshots with: "
    "cd ../TraffSim3D-frontend && npm run contract:gen"
)

# The reasons each scene may legitimately end with. A *truncated* episode
# has no reason at all (""), which is checked separately — see
# `test_python_consistency_baseline`.
_SCENE_REASONS = {
    "cross": ("success", "collision", "red_light"),
    "corridor": ("success_corridor", "collision", "red_light"),
    "t_junction": ("success_t_junction", "collision", "red_light"),
    "roundabout": ("success_roundabout", "collision", "red_light"),
}


def _load_vectors() -> list[dict]:
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    return data["vectors"]


def _vector(name: str) -> dict:
    for v in _load_vectors():
        if v["name"] == name:
            return v
    raise KeyError(name)


def _sample(step: int, ego_id: str, core: SimCore) -> dict:
    """One contract sample: the ego pose plus the traffic-light bits.

    The light bits are the *only* common semantic between Python's
    `ns_green` / `ew_green` pair and the frontend's 10-value phase enum:
    "which axis is green". The key names are the contract schema's, so the
    two sides compare the same fields field-by-field.
    """
    return {
        "step": step,
        "ego_id": ego_id,
        "x": float(core.ego.x),
        "z": float(core.ego.z),
        "heading": float(core.ego.heading),
        "speed": float(core.ego.speed),
        "light": {
            "nsGreen": bool(core.light.ns_green),
            "ewGreen": bool(core.light.ew_green),
        },
    }


def _ensure_python_snapshot(v: dict, sample_every: int) -> dict:
    """Generate the Python snapshot for vector `v` (live, every run)."""
    # `repeat` expands the action list: the actual sequence is `actions`
    # repeated `repeat` times; without it the sequence is `actions` itself.
    # The TS generator implements the same rule — a disagreement there means
    # a different action count, hence a different sample count, hence a
    # "sample count mismatch". The contract catches it; no extra test needed.
    actions = v["actions"] * v["repeat"] if "repeat" in v else v["actions"]
    core = SimCore(
        scene_kind=v["scene_kind"],
        max_steps=v.get("max_steps", MAX_STEPS_DEFAULT),
    )
    core.reset()
    samples = [_sample(0, v["ego_id"], core)]
    for i, action in enumerate(actions, start=1):
        core.step(np.asarray(action, dtype=np.float32))
        if i % sample_every == 0 or i == len(actions):
            samples.append(_sample(i, v["ego_id"], core))
        if core._terminated or core._truncated:
            break
    return {
        "name": v["name"],
        "scene_kind": v["scene_kind"],
        "ego_id": v["ego_id"],
        "final_state": {
            "terminated": core._terminated,
            "truncated": core._truncated,
            "reason": core._terminated_reason,
            "final_step": core.step_count,
            "final_z": float(core.ego.z),
            "final_x": float(core.ego.x),
            "final_speed": float(core.ego.speed),
        },
        "samples": samples,
    }


def _require_snapshot(path: Path) -> dict:
    """Load a TS golden, failing loudly when it is missing.

    A missing golden used to make this test *skip* — a silent pass that
    hid the fact that the contract had never run.
    """
    if not path.exists():
        pytest.fail(f"missing TS contract snapshot: {path.name}. {_REGEN_HINT}")
    return json.loads(path.read_text(encoding="utf-8"))


def test_python_consistency_baseline() -> None:
    """Run Python sim for each vector, save snapshot, validate behavior."""
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    snapshots = CONTRACT_DIR / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)

    for v in data["vectors"]:
        snap = _ensure_python_snapshot(v, sample_every=data.get("sample_every", 5))
        (snapshots / f"python_{v['name']}.json").write_text(
            json.dumps(snap, indent=2),
            encoding="utf-8",
        )
        final = snap["final_state"]
        # The episode must have ENDED for a reason: either a termination
        # (success / collision / red light) or the step limit. An episode
        # that merely ran out of actions without either is a defect, so the
        # assertion is "terminated OR truncated" — never "still running".
        assert final["terminated"] is True or final["truncated"] is True, (
            f"{v['name']}: episode ended for no reason "
            f"(terminated={final['terminated']}, truncated={final['truncated']})"
        )
        allowed = _SCENE_REASONS.get(v["scene_kind"])
        assert allowed is not None, f"no reason whitelist for scene {v['scene_kind']!r}"
        if final["terminated"]:
            assert final["reason"] in allowed, (
                f"{v['name']}: unexpected termination reason {final['reason']!r} "
                f"(allowed: {', '.join(allowed)})"
            )
        else:
            # Truncated: the world froze at the step limit, so there is no
            # termination reason at all.
            assert (
                final["reason"] == ""
            ), f"{v['name']}: truncated episode carries a reason {final['reason']!r}"


def test_contract_snapshots_are_present() -> None:
    """Guard the guard — a missing TS snapshot must FAIL, never skip."""
    missing = []
    for v in _load_vectors():
        for prefix in ("ts_", "ts_kernel_"):
            p = SNAPSHOT_DIR / f"{prefix}{v['name']}.json"
            if not p.exists():
                missing.append(p.name)
    assert not missing, "missing TS contract snapshots: " + ", ".join(missing) + ". " + _REGEN_HINT


@pytest.mark.parametrize("vector_name", [v["name"] for v in _load_vectors()])
def test_python_and_ts_agree_exactly(vector_name: str) -> None:
    """L3: the TS contract mirror reproduces the Python sim exactly."""
    v = _vector(vector_name)
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    sample_every = data.get("sample_every", 5)

    py = _ensure_python_snapshot(v, sample_every=sample_every)
    ts = _require_snapshot(SNAPSHOT_DIR / f"ts_{v['name']}.json")

    py_reason = py["final_state"]["reason"]
    ts_reason = ts["final_state"]["reason"]
    assert py_reason == ts_reason, (
        f"{v['name']}: termination reason mismatch " f"(python={py_reason}, ts={ts_reason})"
    )

    py_step = py["final_state"]["final_step"]
    ts_step = ts["final_state"]["final_step"]
    assert py_step == ts_step, f"{v['name']}: step count mismatch (python={py_step}, ts={ts_step})"

    py_trunc = py["final_state"]["truncated"]
    ts_trunc = ts["final_state"]["truncated"]
    assert (
        py_trunc == ts_trunc
    ), f"{v['name']}: truncation flag mismatch (python={py_trunc}, ts={ts_trunc})"

    for key in ("final_z", "final_x", "final_speed"):
        py_value = py["final_state"][key]
        ts_value = ts["final_state"][key]
        assert (
            py_value == ts_value
        ), f"{v['name']}: {key} mismatch (python={py_value!r}, ts={ts_value!r})"

    py_samples = py["samples"]
    ts_samples = ts["samples"]
    assert len(py_samples) == len(ts_samples), (
        f"{v['name']}: sample count mismatch " f"(python={len(py_samples)}, ts={len(ts_samples)})"
    )
    for ps, tsam in zip(py_samples, ts_samples, strict=True):
        assert ps["step"] == tsam["step"], (
            f"{v['name']}: sample step mismatch " f"(python={ps['step']}, ts={tsam['step']})"
        )
        for key in ("x", "z", "heading", "speed"):
            assert ps[key] == tsam[key], (
                f"{v['name']}: sample step={ps['step']} field={key} "
                f"(python={ps[key]!r}, ts={tsam[key]!r})"
            )
        # The traffic-light bits: the only cross-language common semantic
        # of the phase ("which axis is green"). Comparing them directly is
        # what makes the phase *duration* observable — before this, a
        # change to the cycle length was invisible to every gate.
        for key in ("nsGreen", "ewGreen"):
            assert ps["light"][key] == tsam["light"][key], (
                f"{v['name']}: sample step={ps['step']} light={key} "
                f"(python={ps['light'][key]!r}, ts={tsam['light'][key]!r})"
            )


@pytest.mark.parametrize("vector_name", [v["name"] for v in _load_vectors()])
def test_python_and_ts_kernel_speed_series_agree(vector_name: str) -> None:
    """L1: the product replay path's speed series matches Python exactly.

    Only the steps Python actually simulated are compared. Past its
    termination step, `SimCore.step()` early-returns and leaves the ego
    untouched, so Python's series freezes at the terminal speed while the TS
    side keeps integrating — the two tails agree only when the ego happened
    to saturate `SPEED_LIMIT` before terminating. That is a property of the
    current vectors, not of the contract, so relying on it would turn a
    correct TS implementation into a false drift report for any vector that
    terminates earlier (e.g. a collision at step 20 with speed 6.0).
    Comparing the prefix keeps the assertion meaningful for every vector.
    """
    v = _vector(vector_name)

    core = SimCore(scene_kind=v["scene_kind"])
    core.reset()
    py_series: list[float] = []
    for action in v["actions"]:
        core.step(np.asarray(action, dtype=np.float32))
        py_series.append(float(core.ego.speed))
        if core._terminated:
            break

    kernel = _require_snapshot(SNAPSHOT_DIR / f"ts_kernel_{v['name']}.json")
    ts_series = kernel["speed_series"]

    assert len(ts_series) >= len(py_series), (
        f"{v['name']}: kernel series too short " f"(python={len(py_series)}, ts={len(ts_series)})"
    )
    comparable = ts_series[: len(py_series)]
    for i, (a, b) in enumerate(zip(py_series, comparable, strict=True)):
        assert a == b, f"{v['name']}: kernel speed[{i}] mismatch " f"(python={a!r}, ts={b!r})"

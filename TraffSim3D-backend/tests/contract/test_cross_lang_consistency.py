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

from app.apps.rl.sim_core import (
    ALL_RED_SECS,
    MAX_GREEN_SECS,
    MAX_STEPS_DEFAULT,
    PHASE_ADJUST_SECS,
    SIGNAL_ACTION_NAMES,
    SimCore,
)

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


def _expand_actions(v: dict) -> list[list[float]]:
    """Expand a vector's action list.

    The rule — identical to the TS generator's, one line each:
      if the vector has `repeat`, the actual action sequence is `actions`
      repeated `repeat` times; otherwise it is `actions` itself.

    A malformed `repeat` must fail **loudly on both sides**. Python raises
    here, and the TS generator throws on the same malformed input instead
    of silently running an empty episode — `Array.from({length: null})`
    would otherwise yield an empty action list and a vacuous "agreement".

    What the contract guarantees is that a divergence which changes the
    **observable** episode is caught — the sample count or a sampled value.
    It does NOT follow that *every* divergence is caught: when both
    episodes terminate at the same step, a count difference *beyond* that
    step (e.g. TS `repeat: 401` vs Python `repeat: 400` on a vector that
    ends at step 257) produces byte-identical output and no red.
    """
    if "repeat" not in v:
        return list(v["actions"])
    repeat = v["repeat"]
    if isinstance(repeat, bool) or not isinstance(repeat, int) or repeat < 1:
        raise ValueError(
            f"vector {v['name']!r}: 'repeat' must be a positive integer, got {repeat!r}"
        )
    return list(v["actions"]) * repeat


def _ensure_python_snapshot(v: dict, sample_every: int) -> dict:
    """Generate the Python snapshot for vector `v` (live, every run)."""
    actions = _expand_actions(v)
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


def _write_python_snapshot(v: dict, sample_every: int) -> dict:
    """Run vector `v` and (re)write `snapshots/python_<name>.json`.

    This is the **only** writer of the Python-side snapshot files. The
    legacy sibling `tests/contract/test_python_snapshot.py` used to have its
    own writer with the Plan 050 schema (no `light`, no `final_state`, plus
    a `tolerance` key); because pytest collects `test_cross_lang_consistency.py`
    first (alphabetically), that sibling overwrote these files at the end of
    every session — so the artefact a reader is most likely to open was the
    *older*, less informative one. Both modules now call this function, so
    the two writers cannot disagree again.
    """
    snap = _ensure_python_snapshot(v, sample_every)
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    (SNAPSHOT_DIR / f"python_{v['name']}.json").write_text(
        json.dumps(snap, indent=2),
        encoding="utf-8",
    )
    return snap


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
    sample_every = data.get("sample_every", 5)

    for v in data["vectors"]:
        snap = _write_python_snapshot(v, sample_every)
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
def test_signal_action_vocabulary_matches_the_typescript_golden(vector_name: str) -> None:
    """Plan 073 Sprint 2 (D4): the two sides speak the same action language.

    The TypeScript side writes its copy of the five action names and the two
    semantics constants into every scenario golden; this test compares them
    against Python's own `sim_core` copy, **item by item** — the order is
    part of the contract, not just the membership.

    Each side owns its own copy on purpose: a file both sides read would
    make this assertion vacuous.

    What this does NOT assert: the per-action *semantics*. The browser's
    signal has a 3 s yellow phase per light and Python's has none, so the
    two phase timelines cannot be compared (see
    `docs/contracts/sim-snapshot.md`, "What the contract does NOT cover").
    The semantics are gated by each side's own unit tests.
    """
    v = _vector(vector_name)
    ts = _require_snapshot(SNAPSHOT_DIR / f"ts_{v['name']}.json")
    vocab = ts.get("signal_vocabulary")
    assert vocab is not None, (
        f"{v['name']}: the TS golden carries no 'signal_vocabulary' block. "
        f"Regenerate it with: cd ../TraffSim3D-frontend && npm run contract:gen"
    )

    ts_actions = list(vocab["actions"])
    assert ts_actions == list(SIGNAL_ACTION_NAMES), (
        f"{v['name']}: signal-action vocabulary mismatch "
        f"(typescript={ts_actions}, python={list(SIGNAL_ACTION_NAMES)})"
    )
    assert (
        len(ts_actions) == 5
    ), f"{v['name']}: expected the five signal actions, got {len(ts_actions)}"

    ts_all_red = vocab["all_red_seconds"]
    assert ts_all_red == ALL_RED_SECS, (
        f"{v['name']}: all-red clearance mismatch "
        f"(typescript={ts_all_red}, python={ALL_RED_SECS})"
    )
    ts_adjust = vocab["phase_adjust_seconds"]
    assert ts_adjust == PHASE_ADJUST_SECS, (
        f"{v['name']}: phase-adjust amount mismatch "
        f"(typescript={ts_adjust}, python={PHASE_ADJUST_SECS})"
    )

    ts_max_green = vocab["max_green_seconds"]
    assert ts_max_green == MAX_GREEN_SECS, (
        f"{v['name']}: max-green bound mismatch "
        f"(typescript={ts_max_green}, python={MAX_GREEN_SECS})"
    )


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

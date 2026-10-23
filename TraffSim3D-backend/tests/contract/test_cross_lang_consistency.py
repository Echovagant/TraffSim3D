"""Cross-language consistency test (executable).

The Python training sim (`app/apps/rl/sim_core.py`) and the TypeScript
contract mirror (`TraffSim3D-frontend/src/application/services/simCoreMirror.ts`)
are two independent implementations of the same model. This test asserts
they agree **exactly** — not within a tolerance.

Why exact equality: both sides execute the same floating-point operation
sequence, so their trajectories are bit-identical. Measured on the `cross`
vector:
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
    CLEARANCE_SECS,
    MAX_GREEN_SECS,
    MAX_STEPS_DEFAULT,
    MIN_GREEN_SECS,
    PHASE_ADJUST_SECS,
    ROAD_HALF_WIDTH,
    SCENE_GOAL_Z,
    SIGNAL_ACTION_NAMES,
    SimCore,
    TrafficLight,
    Vehicle,
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
    # The signalled scene shares the `cross` scene's success
    # reason - the difference between the two scenes is the light schedule,
    # not the route.
    "cross_signalled": ("success", "collision", "red_light"),
}


# --------------------------------------------------------------------------
# The turning vectors and the cross-runtime noise floor
# --------------------------------------------------------------------------
#
# ADR-008 D3 compares the two sides with `==`, because "both sides execute
# the same floating-point operation sequence". That premise holds for the
# straight-line vectors - their only transcendental arguments are exactly 0
# (the Pure Pursuit angle) and pi/2 (the heading), which every libm
# reproduces bit for bit - but NOT for a trajectory that turns.
#
# V8's `Math.sin` / `Math.atan2` and CPython's `math.sin` / `math.atan2`
# are different implementations (V8 ships an fdlibm-derived port, CPython
# calls the platform libm), and they disagree by 1 ULP for a few percent of
# the angles a turning trajectory visits. Measured on this machine (for the
# turning vectors): on `steer_lateral_offset` the two sides differ by 2.22e-16 rad in the
# heading - first at sample step 20 - and 3.55e-15 m in z; ADR-008's own
# randomised sweep measured up to 1.09e-13 m.
#
# The floor below is four orders of magnitude above that measurement and six
# orders below the smallest drift the contract has to catch: a mutated
# LOOKAHEAD_DISTANCE / MAX_STEER / EGO_WHEELBASE moves the trajectory by
# metres (see `tests/contract/test_steering_vectors.py`).
#
# A STRAIGHT-line trajectory keeps the exact `==` assertion - the floor is
# only used where the trajectory actually turns, and the noise floor itself
# is pinned by a test, so it cannot be widened silently.
_LIBM_NOISE_FLOOR = 1e-9


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


def _golden_path(name: str) -> Path:
    """The committed TypeScript golden for a vector."""
    return SNAPSHOT_DIR / f"ts_{name}.json"


def _turns(golden: dict) -> bool:
    """Does this golden's trajectory turn *materially*?

    A trajectory that turns has a non-zero Pure Pursuit angle, so the two
    runtimes' `sin` / `atan2` can disagree in the last bit (see
    `_LIBM_NOISE_FLOOR`).

    The threshold is the noise floor itself: a heading that moves by less
    than 1e-9 rad over the whole episode is a straight line whose last-bit
    wobble - the ego passing its target, where the Pure Pursuit angle is
    ~pi and the steer ~1e-16 - is far below anything a libm can change.
    """
    headings = [sample["heading"] for sample in golden["samples"]]
    return (max(headings) - min(headings)) > _LIBM_NOISE_FLOOR


def _vector_names(turning: bool) -> list[str]:
    """The vector names, split by whether their trajectory turns.

    The classification comes from the **committed golden** (the TypeScript
    side's own trajectory), so it is a property of the vector and not of
    whichever side happens to run the test.
    """
    names: list[str] = []
    for v in _load_vectors():
        path = _golden_path(v["name"])
        # A missing golden is reported by `test_contract_snapshots_are_present`;
        # classify it as straight so the exact assertion fails loudly there.
        is_turning = (
            _turns(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else False
        )
        if is_turning == turning:
            names.append(v["name"])
    return names


def _assert_agrees(v: dict, py: dict, ts: dict, floor: float) -> None:
    """The two sides must agree on the whole episode.

    `floor = 0.0` is ADR-008 D3's exact equality (the straight-line
    vectors). A non-zero floor is used only for the turning vectors, where
    the two runtimes' `sin` / `atan2` disagree in the last bit - see
    `_LIBM_NOISE_FLOOR`.
    """

    def same(py_value: float, ts_value: float) -> bool:
        if py_value == ts_value:
            return True
        return floor > 0.0 and abs(py_value - ts_value) <= floor

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

    for key in ("final_z", "final_x"):
        py_value = py["final_state"][key]
        ts_value = ts["final_state"][key]
        assert same(py_value, ts_value), (
            f"{v['name']}: {key} mismatch (python={py_value!r}, ts={ts_value!r}, "
            f"delta={abs(py_value - ts_value)!r}, floor={floor!r})"
        )
    # The speed integration contains no transcendental call, so it stays an
    # exact comparison - on a turning trajectory too.
    py_speed = py["final_state"]["final_speed"]
    ts_speed = ts["final_state"]["final_speed"]
    assert (
        py_speed == ts_speed
    ), f"{v['name']}: final_speed mismatch (python={py_speed!r}, ts={ts_speed!r})"

    py_samples = py["samples"]
    ts_samples = ts["samples"]
    assert len(py_samples) == len(ts_samples), (
        f"{v['name']}: sample count mismatch " f"(python={len(py_samples)}, ts={len(ts_samples)})"
    )
    for ps, tsam in zip(py_samples, ts_samples, strict=True):
        assert ps["step"] == tsam["step"], (
            f"{v['name']}: sample step mismatch " f"(python={ps['step']}, ts={tsam['step']})"
        )
        for key in ("x", "z", "heading"):
            assert same(ps[key], tsam[key]), (
                f"{v['name']}: sample step={ps['step']} field={key} "
                f"(python={ps[key]!r}, ts={tsam[key]!r}, "
                f"delta={abs(ps[key] - tsam[key])!r}, floor={floor!r})"
            )
        # The speed integration is free of transcendental calls: exact.
        assert ps["speed"] == tsam["speed"], (
            f"{v['name']}: sample step={ps['step']} field=speed "
            f"(python={ps['speed']!r}, ts={tsam['speed']!r})"
        )
        # The traffic-light bits: the only cross-language common semantic
        # of the phase ("which axis is green"). Comparing them directly is
        # what makes the phase *duration* observable - before this, a
        # change to the cycle length was invisible to every gate.
        for key in ("nsGreen", "ewGreen"):
            assert ps["light"][key] == tsam["light"][key], (
                f"{v['name']}: sample step={ps['step']} light={key} "
                f"(python={ps['light'][key]!r}, ts={tsam['light'][key]!r})"
            )


def _signal_actions_for(v: dict) -> list[dict]:
    """The external signal actions to apply, as recorded in the TS golden.

    THE GOLDEN IS THE SOURCE: the TypeScript generator writes the sequence
    it applied into every golden, and the Python side applies **that**
    sequence — the same relationship the `signal_vocabulary` block has. The
    vector file's own copy is cross-checked against it, so a golden that
    was not regenerated after a vector edit cannot hide the drift.

    THE STEP CONVENTION (identical on both sides, and load-bearing): an
    action labelled `"step": N` is applied **before** the N-th simulation
    step — it is consumed by that step. Here that means
    `light.apply_action(name)` immediately before `core.step(...)`; in the
    TypeScript mirror it means `applySignalAction(name)` immediately before
    `mirror.step(...)`. Getting this off by one silently produces
    different trajectories, which the contract would then report as a
    semantic mismatch.
    """
    from_vector = list(v.get("signal_actions", []))
    path = _golden_path(v["name"])
    if not path.exists():
        # The missing golden is reported by `test_contract_snapshots_are_present`.
        return from_vector
    golden = json.loads(path.read_text(encoding="utf-8"))
    from_golden = list(golden.get("signal_actions", []))
    assert from_golden == from_vector, (
        f"{v['name']}: the TS golden's signal actions differ from the vector's "
        f"(golden={from_golden}, vector={from_vector}). "
        f"Regenerate the goldens with: cd ../TraffSim3D-frontend && npm run contract:gen"
    )
    for entry in from_golden:
        step = entry.get("step")
        name = entry.get("action")
        assert (
            isinstance(step, int) and not isinstance(step, bool) and step >= 1
        ), f"{v['name']}: a signal action's step must be a positive integer, got {step!r}"
        assert name in SIGNAL_ACTION_NAMES, (
            f"{v['name']}: unknown signal action {name!r} "
            f"(expected one of {', '.join(SIGNAL_ACTION_NAMES)})"
        )
    return from_golden


def _light_override_for(v: dict) -> dict | None:
    """The light to install right after the scene's `reset()`.

    The roundabout's own light is both-green ("no traffic lights there"),
    so its swap is a no-op — the signalled vectors override it with a plain
    NS-green light, exactly like `tests/contract/test_signal_actions.py`
    does for the same reason (a parked ego is hit by an NPC long before the
    30 s flip in every signalled scene, so the roundabout is the only scene
    whose episode survives long enough to observe a phase).
    """
    override = v.get("light_override")
    if override is None:
        return None
    for key in ("ns_green", "ew_green"):
        if not isinstance(override.get(key), bool):
            raise ValueError(
                f"{v['name']}: light_override.{key} must be a boolean, "
                f"got {override.get(key)!r}"
            )
    path = _golden_path(v["name"])
    if path.exists():
        golden = json.loads(path.read_text(encoding="utf-8"))
        assert golden.get("light_override") == {
            "ns_green": override["ns_green"],
            "ew_green": override["ew_green"],
        }, (
            f"{v['name']}: the TS golden's light override differs from the vector's. "
            f"Regenerate the goldens with: cd ../TraffSim3D-frontend && npm run contract:gen"
        )
    return override


def _ego_start_for(v: dict) -> dict | None:
    """The ego pose to install right after the scene's `reset()`.

    Every contract vector used to be a **straight-line**
    scenario: the ego drove at its target, Pure Pursuit's angle was
    ~0, `steer` was 0, and the three turning constants
    (`LOOKAHEAD_DISTANCE`, `MAX_STEER`, `EGO_WHEELBASE`) could not change
    any trajectory - they were measured blind spots (see
    `docs/contracts/sim-snapshot.md`).

    This override starts the ego somewhere else, so the Pure Pursuit
    angle is non-zero from the very first step. It is the same
    vector-level override pattern as `light_override`: the vector
    declares it, the TS golden records it, and the Python side
    **cross-checks** the two - a golden that was not regenerated after
    a vector edit cannot hide the drift.

    The override lives in the contract harness, not in `sim_core.py`:
    the scenes and the existing goldens stay byte-identical.
    """
    override = v.get("ego_start")
    if override is None:
        return None
    for key in ("x", "z", "heading", "speed"):
        value = override.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{v['name']}: ego_start.{key} must be a number, " f"got {value!r}")
    path = _golden_path(v["name"])
    if path.exists():
        golden = json.loads(path.read_text(encoding="utf-8"))
        expected = {key: float(override[key]) for key in ("x", "z", "heading", "speed")}
        assert golden.get("ego_start") == expected, (
            f"{v['name']}: the TS golden's ego start differs from the vector's "
            f"(golden={golden.get('ego_start')}, vector={expected}). "
            f"Regenerate the goldens with: cd ../TraffSim3D-frontend && npm run contract:gen"
        )
    return override


def _ensure_python_snapshot(v: dict, sample_every: int) -> dict:
    """Generate the Python snapshot for vector `v` (live, every run)."""
    actions = _expand_actions(v)
    core = SimCore(
        scene_kind=v["scene_kind"],
        max_steps=v.get("max_steps", MAX_STEPS_DEFAULT),
    )
    core.reset()
    override = _light_override_for(v)
    if override is not None:
        core.light = TrafficLight(ns_green=override["ns_green"], ew_green=override["ew_green"])
    start = _ego_start_for(v)
    if start is not None:
        core.ego = Vehicle(
            x=float(start["x"]),
            z=float(start["z"]),
            heading=float(start["heading"]),
            speed=float(start["speed"]),
        )
    by_step: dict[int, list[str]] = {}
    for entry in _signal_actions_for(v):
        by_step.setdefault(entry["step"], []).append(entry["action"])
    samples = [_sample(0, v["ego_id"], core)]
    for i, action in enumerate(actions, start=1):
        # The action labelled `step: i` is applied BEFORE the i-th step, so
        # it is consumed by that step (see `_signal_actions_for`).
        for name in by_step.get(i, []):
            core.light.apply_action(name)
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
    own writer with the older schema (no `light`, no `final_state`, plus
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
def test_the_road_rules_constants_match_the_typescript_golden(vector_name: str) -> None:
    """The road rules are contract constants too.

    The road's half-width and each scene's goal line decide whether the
    ego may score the success. Both sides own their own copy (Python in
    `sim_core.py`, TypeScript in `@shared/constants/simulation`) — a file
    both sides read would make this comparison vacuous — and the golden
    carries the TS side's copy, which is compared here item by item.
    """
    v = _vector(vector_name)
    golden = _require_snapshot(_golden_path(v["name"]))
    rules = golden.get("road_rules")
    assert rules is not None, (
        f"{v['name']}: the TS golden carries no 'road_rules' block. "
        "Regenerate it with: cd ../TraffSim3D-frontend && npm run contract:gen"
    )

    assert rules["road_half_width"] == ROAD_HALF_WIDTH, (
        f"{v['name']}: the road half-width differs "
        f"(typescript={rules['road_half_width']}, python={ROAD_HALF_WIDTH})"
    )
    assert rules["scene_goal_z"] == SCENE_GOAL_Z, (
        f"{v['name']}: the scene goal lines differ "
        f"(typescript={rules['scene_goal_z']}, python={SCENE_GOAL_Z})"
    )


@pytest.mark.parametrize("vector_name", [v["name"] for v in _load_vectors()])
def test_the_scene_light_schedule_matches_the_typescript_golden(vector_name: str) -> None:
    """The scene's light schedule is a contract constant too.

    Four of the five scenes run the default 30 s cycle, whose first phase
    change lands on step 300 — beyond every ego episode, which is why the
    ego never faces a red light in them. The fifth (`cross_signalled`)
    starts the ego's axis **red** on a 12 s cycle, so the phase changes
    *inside* the episode.

    Both sides own their own schedule (Python in `sim_core.py`,
    TypeScript in `@shared/constants/simulation`), and the golden carries
    the TypeScript side's copy, which is compared here item by item. A
    file both sides read would make this comparison vacuous.
    """
    v = _vector(vector_name)
    golden = _require_snapshot(_golden_path(v["name"]))
    block = golden.get("scene_light")
    assert block is not None, (
        f"{v['name']}: the TS golden carries no 'scene_light' block. "
        "Regenerate it with: cd ../TraffSim3D-frontend && npm run contract:gen"
    )

    core = SimCore(scene_kind=v["scene_kind"])
    core.reset()
    assert block["cycle_seconds"] == core.light.cycle_duration, (
        f"{v['name']}: the scene's light cycle differs "
        f"(typescript={block['cycle_seconds']}, python={core.light.cycle_duration})"
    )
    assert block["ns_green_at_reset"] == core.light.ns_green, (
        f"{v['name']}: the scene's starting phase differs "
        f"(typescript={block['ns_green_at_reset']}, python={core.light.ns_green})"
    )
    assert block["ew_green_at_reset"] == core.light.ew_green, (
        f"{v['name']}: the scene's starting phase differs "
        f"(typescript={block['ew_green_at_reset']}, python={core.light.ew_green})"
    )


@pytest.mark.parametrize("vector_name", [v["name"] for v in _load_vectors()])
def test_signal_action_vocabulary_matches_the_typescript_golden(vector_name: str) -> None:
    """The two sides speak the same action language.

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

    # The minimum green time is a contract constant too —
    # it is what stops a controller from flickering the light (a phase
    # shorter than the minimum is never shorter than this).
    ts_min_green = vocab["min_green_seconds"]
    assert ts_min_green == MIN_GREEN_SECS, (
        f"{v['name']}: min-green bound mismatch "
        f"(typescript={ts_min_green}, python={MIN_GREEN_SECS})"
    )

    # The inter-green clearance - the lost time a phase
    # change costs. The browser charges a 3 s yellow plus a 3 s all-red
    # before the other axis may go; the Python training sim charges the
    # same 6 s, and the two numbers are compared here.
    ts_clearance = vocab["inter_green_seconds"]
    assert ts_clearance == CLEARANCE_SECS, (
        f"{v['name']}: inter-green clearance mismatch "
        f"(typescript={ts_clearance}, python={CLEARANCE_SECS})"
    )


@pytest.mark.parametrize("vector_name", _vector_names(turning=False))
def test_python_and_ts_agree_exactly(vector_name: str) -> None:
    """L3: the TS contract mirror reproduces the Python sim exactly.

    ADR-008 D3's exact equality. These are the **straight-line** vectors:
    their only transcendental arguments are exactly 0 (the Pure Pursuit
    angle) and pi/2 (the heading), which every libm reproduces bit for
    bit, so the two sides agree to the last bit.
    """
    v = _vector(vector_name)
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    sample_every = data.get("sample_every", 5)

    py = _ensure_python_snapshot(v, sample_every=sample_every)
    ts = _require_snapshot(SNAPSHOT_DIR / f"ts_{v['name']}.json")
    _assert_agrees(v, py, ts, 0.0)


@pytest.mark.parametrize("vector_name", _vector_names(turning=True))
def test_python_and_ts_agree_on_a_turning_trajectory(vector_name: str) -> None:
    """A turning trajectory agrees within the libm noise floor.

    The exact `==` assertion cannot hold for a trajectory that turns: V8's
    `Math.sin` / `Math.atan2` and CPython's `math.sin` / `math.atan2` are
    different implementations and disagree by 1 ULP for some angles - ADR-008
    D3's stated platform assumption, now measured (see `_LIBM_NOISE_FLOOR`).
    """
    v = _vector(vector_name)
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    sample_every = data.get("sample_every", 5)

    py = _ensure_python_snapshot(v, sample_every=sample_every)
    ts = _require_snapshot(SNAPSHOT_DIR / f"ts_{v['name']}.json")
    _assert_agrees(v, py, ts, _LIBM_NOISE_FLOOR)


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


# --------------------------------------------------------------------------
# The action-driven contract vectors
# --------------------------------------------------------------------------
#
# The five vectors above run the **default** cycle, so they cannot tell
# whether the two sides interpret the five signal actions the same way.
# These five do: the same action is applied at the same step on both sides,
# and the trajectories must still be bit-identical.

# The sample steps at which the light bits change, per vector. The sample
# stride is 10, so a phase change is observed at the first sample after it.
_SIGNAL_VECTOR_CHANGES: dict[str, list[int]] = {
    # The default cycle: the swap lands on step 300.
    "signalled_light_baseline": [300],
    # `extend_green` delays the swap by 5 s (50 steps).
    "signalled_light_extend_green": [350],
    # `shorten_red` advances the swap by 5 s (50 steps).
    "signalled_light_shorten_red": [250],
    # `preempt` on step 10: all-red from step 10, the phase resumes inside
    # step 40, and the swap lands 30 steps later than the default (the clock
    # was frozen during the clearance).
    "signalled_light_preempt": [10, 40, 330],
    # The clearance-boundary case: a second `preempt` on step 40 — the very
    # step the phase resumed — must not wedge the light. The phase comes
    # back inside step 70 and the swap lands on step 360.
    "signalled_light_preempt_boundary": [10, 70, 360],
}


def _light_changes(golden: dict) -> list[int]:
    """The sample steps at which the golden's light bits change."""
    changes: list[int] = []
    previous: tuple[bool, bool] | None = None
    for sample in golden["samples"]:
        bits = (sample["light"]["nsGreen"], sample["light"]["ewGreen"])
        if previous is not None and bits != previous:
            changes.append(sample["step"])
        previous = bits
    return changes


@pytest.mark.parametrize("vector_name", sorted(_SIGNAL_VECTOR_CHANGES))
def test_the_signal_actions_move_the_phase_as_expected(vector_name: str) -> None:
    """The action semantics are visible in the golden — and agree.

    This is the trajectory-level counterpart of the vocabulary assertion
    (L4): the *same* action applied at the *same* step must move the phase
    the same way on both sides. The expected timelines are the ones the
    Python light produces (see `tests/contract/test_signal_actions.py`).
    """
    golden = _require_snapshot(_golden_path(vector_name))
    changes = _light_changes(golden)
    assert changes == _SIGNAL_VECTOR_CHANGES[vector_name], (
        f"{vector_name}: unexpected phase timeline "
        f"(golden={changes}, expected={_SIGNAL_VECTOR_CHANGES[vector_name]})"
    )


@pytest.mark.parametrize(
    "vector_name",
    [name for name in sorted(_SIGNAL_VECTOR_CHANGES) if name != "signalled_light_baseline"],
)
def test_an_action_vector_differs_from_the_default_behaviour(vector_name: str) -> None:
    """The action must actually change the episode.

    Without this assertion the exact-equality check would be vacuous: it
    would pass even if *both* sides ignored the actions.
    """
    baseline = _require_snapshot(_golden_path("signalled_light_baseline"))
    actioned = _require_snapshot(_golden_path(vector_name))
    assert actioned["samples"] != baseline["samples"], (
        f"{vector_name}: the golden is identical to the no-action baseline — "
        f"the action changed nothing, so the comparison proves nothing"
    )


def test_the_preempt_boundary_case_keeps_the_light_alive() -> None:
    """The clearance-boundary regression, now at the trajectory level.

    A `preempt` that lands on the step right after a clearance ended used to
    record the all-red state as the resume point, and the light then never
    went green again. The golden must show the
    phase coming back.
    """
    golden = _require_snapshot(_golden_path("signalled_light_preempt_boundary"))
    by_step = {s["step"]: s["light"] for s in golden["samples"]}
    # All-red through the two clearances (steps 10..39 and 40..69).
    assert by_step[30] == {"nsGreen": False, "ewGreen": False}
    assert by_step[60] == {"nsGreen": False, "ewGreen": False}
    # The phase resumed inside step 40 and was cleared again by the second
    # preempt, so the sample on step 40 is all-red too ...
    assert by_step[40] == {"nsGreen": False, "ewGreen": False}
    # ... and the phase is back (it resumes inside step 70).
    assert by_step[70] == {"nsGreen": True, "ewGreen": False}

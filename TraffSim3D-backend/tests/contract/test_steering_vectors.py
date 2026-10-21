"""Plan 076 S5a: the turning dimension is covered by the cross-language contract.

Before this slice every contract vector was a **straight-line** scenario:
the ego drove straight at its target, Pure Pursuit's angle was ~0, `steer`
was 0, and the three turning constants (`LOOKAHEAD_DISTANCE`, `MAX_STEER`,
`EGO_WHEELBASE`) could not change any trajectory. ADR-008 D3 lists them as
measured blind spots, and `docs/contracts/sim-snapshot.md` carries the same
table.

This module is the *coverage* proof for the two vectors that turn:

  1. the steer is **non-zero on every step** (a vector whose steer was still
     ~0 would cover nothing);
  2. the steer **reaches the `MAX_STEER` clamp**, so the clamp itself is
     exercised - a clamp that never binds is as blind as no clamp at all;
  3. **mutating any of the three constants turns the contract red** - the
     mutation is done at runtime (the method ADR-008 used for its own
     sweeps), so the check is a committed gate instead of a one-off
     measurement;
  4. the two sides stay **inside the cross-runtime noise floor**, which is
     what makes the contract's comparison a bounded relaxation rather than
     an open-ended tolerance.

The steer is observed through the heading it produces (`heading += steer *
dt`), never by re-implementing the Pure Pursuit formula: a second copy of
the formula could drift from the sim and make these assertions vacuous.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl import sim_core
from app.apps.rl.sim_core import SimCore, TrafficLight, Vehicle

try:
    # pytest's default ("prepend") import mode puts this directory on
    # `sys.path`, so the sibling module is importable by its bare name.
    from test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
        _vector_names,
    )
except ImportError:  # pragma: no cover - alternative import mode
    from tests.contract.test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
        _vector_names,
    )

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"
SNAPSHOT_DIR = CONTRACT_DIR / "snapshots"

# The vectors whose trajectory turns **through the Pure Pursuit** — i.e. the
# ones that declare an `ego_start`, so the steer comes from the pursuit
# geometry rather than from the policy's steering residual.
#
# The contract's own classification (`_vector_names(turning=True)`) is
# broader: it also contains Plan 076 T12's `steer_residual` vector, whose
# ego turns because the *policy* commands a residual. That vector is still
# compared with the noise floor (the two runtimes' `sin`/`atan2` disagree in
# the last bit on any turning trajectory) — but the assertions below are
# about the **Pure Pursuit constants**, and they only make sense for the
# vectors that exercise the pursuit.
TURNING_VECTORS = [name for name in _vector_names(turning=True) if "ego_start" in _vector(name)]

# The three constants that used to be blind, and a mutation that is large
# enough to be unmistakable but small enough to stay physically plausible.
#
# The factors are deliberately NOT all the same: the Pure Pursuit steer
# depends on the constants only through the **ratio**
# `2 * EGO_WHEELBASE / LOOKAHEAD_DISTANCE`, so scaling the wheelbase and the
# lookahead by the same factor leaves the trajectory bit-identical (the two
# mutations cancel). Using different factors keeps this test meaningful even
# when it runs inside an outer mutation of the other constant.
TURNING_CONSTANTS = [
    ("MAX_STEER", sim_core.MAX_STEER * 1.25),
    ("LOOKAHEAD_DISTANCE", sim_core.LOOKAHEAD_DISTANCE * 1.5),
    ("EGO_WHEELBASE", sim_core.EGO_WHEELBASE * 1.5),
]


def _sample_every() -> int:
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    return int(data.get("sample_every", 5))


def _episode(v: dict) -> SimCore:
    """The episode a vector describes, with its overrides applied.

    The same order as the contract harness: `reset()`, then the light
    override, then the ego-pose override.
    """
    core = SimCore(scene_kind=v["scene_kind"], max_steps=v.get("max_steps", 200))
    core.reset()
    light = v.get("light_override")
    if light is not None:
        core.light = TrafficLight(ns_green=light["ns_green"], ew_green=light["ew_green"])
    start = v.get("ego_start")
    if start is not None:
        core.ego = Vehicle(
            x=float(start["x"]),
            z=float(start["z"]),
            heading=float(start["heading"]),
            speed=float(start["speed"]),
        )
    return core


def _actions(v: dict) -> list[list[float]]:
    if "repeat" not in v:
        return list(v["actions"])
    return list(v["actions"]) * v["repeat"]


def _steer_series(v: dict) -> list[float]:
    """The steer the sim actually applied, step by step.

    Derived from the heading change the steer produces
    (`heading += steer * dt`), so this observes the *effect* of the Pure
    Pursuit instead of re-implementing its formula.
    """
    core = _episode(v)
    steers: list[float] = []
    for action in _actions(v):
        heading_before = core.ego.heading
        core.step(np.asarray(action, dtype=np.float32))
        steers.append((core.ego.heading - heading_before) / sim_core.DT)
        if core._terminated or core._truncated:
            break
    return steers


def _golden(name: str) -> dict:
    return json.loads(_golden_path(name).read_text(encoding="utf-8"))


def test_the_turning_vectors_exist_and_declare_an_ego_start() -> None:
    """There is at least one vector that turns - and it says how it starts."""
    assert TURNING_VECTORS, "no vector turns: the blind spot is still open"
    for name in TURNING_VECTORS:
        v = _vector(name)
        assert "ego_start" in v, f"{name}: a turning vector must declare its ego start"
        for key in ("x", "z", "heading", "speed"):
            assert key in v["ego_start"], f"{name}: ego_start.{key} is missing"


@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_the_steer_is_not_zero_on_any_step(vector_name: str) -> None:
    """The whole point: `steer` is never 0, so the constants can bite.

    A vector whose steer was still ~0 would cover exactly as much as the
    straight-line vectors did - which is nothing.
    """
    steers = _steer_series(_vector(vector_name))
    assert steers, f"{vector_name}: the episode ran no step"
    zero = [i + 1 for i, s in enumerate(steers) if s == 0.0]
    assert not zero, (
        f"{vector_name}: the steer is exactly 0 on step(s) {zero} - "
        f"this vector covers nothing there"
    )


@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_the_steer_reaches_the_max_steer_clamp(vector_name: str) -> None:
    """The clamp is exercised, not merely present.

    `MAX_STEER` only affects a trajectory while the raw steer is *above*
    the bound - a steer that never reaches the clamp cannot tell the clamp
    from no clamp at all.
    """
    steers = _steer_series(_vector(vector_name))
    peak = max(abs(s) for s in steers)
    assert peak >= sim_core.MAX_STEER - 1e-9, (
        f"{vector_name}: the peak steer {peak!r} never reaches the "
        f"MAX_STEER bound {sim_core.MAX_STEER!r}, so the clamp is not exercised"
    )
    assert peak <= sim_core.MAX_STEER + 1e-9, (
        f"{vector_name}: the peak steer {peak!r} is above the MAX_STEER bound "
        f"{sim_core.MAX_STEER!r} - the clamp did not hold"
    )


@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_the_ego_start_override_is_the_first_sample(vector_name: str) -> None:
    """The override really replaced the scene's start pose.

    Checked on **both** sides: the committed golden's first sample and the
    live Python sim's first sample.
    """
    v = _vector(vector_name)
    start = v["ego_start"]
    golden = _golden(vector_name)
    first = golden["samples"][0]
    assert first["x"] == float(start["x"])
    assert first["z"] == float(start["z"])
    assert first["heading"] == float(start["heading"])
    assert first["speed"] == float(start["speed"])

    core = _episode(v)
    assert core.ego.x == float(start["x"])
    assert core.ego.z == float(start["z"])
    assert core.ego.heading == float(start["heading"])
    assert core.ego.speed == float(start["speed"])


@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_the_golden_shows_the_ego_turning(vector_name: str) -> None:
    """The committed golden records a trajectory that turned."""
    golden = _golden(vector_name)
    headings = [s["heading"] for s in golden["samples"]]
    assert (
        headings[0] != headings[-1]
    ), f"{vector_name}: the heading never changed - the ego drove straight"
    assert abs(headings[-1] - headings[0]) > 0.5, (
        f"{vector_name}: the heading moved by only "
        f"{abs(headings[-1] - headings[0])!r} rad - too little to observe"
    )


def test_every_other_vector_is_straight_line() -> None:
    """Why the blind spot existed - and why it is now closed.

    The remaining vectors drive straight at their target, so their steer is
    0 (or ~1e-16, the ego passing its target) and no turning constant can
    touch their trajectory. They are still compared with exact equality
    (ADR-008 D3); the turning vectors are the ones that need the noise
    floor.
    """
    straight = _vector_names(turning=False)
    assert straight, "the straight-line vectors disappeared"
    for name in straight:
        golden = _golden(name)
        headings = [s["heading"] for s in golden["samples"]]
        spread = max(headings) - min(headings)
        assert spread <= _LIBM_NOISE_FLOOR, (
            f"{name}: the heading moves by {spread!r} rad - this vector turns "
            f"materially and belongs in the turning group"
        )


@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_the_two_sides_stay_inside_the_noise_floor(vector_name: str) -> None:
    """The relaxation is an operating point, not a licence.

    The contract compares a turning trajectory within `_LIBM_NOISE_FLOOR`
    (1e-9). The **measured** divergence must stay an order of magnitude
    below that, so a real drift (metres) is unmistakably different from the
    two runtimes' last-bit disagreement - and so the floor cannot be
    widened silently.
    """
    v = _vector(vector_name)
    py = _ensure_python_snapshot(v, sample_every=_sample_every())
    ts = _golden(vector_name)
    worst = 0.0
    for ps, tsam in zip(py["samples"], ts["samples"], strict=True):
        for key in ("x", "z", "heading"):
            worst = max(worst, abs(ps[key] - tsam[key]))
    assert worst <= _LIBM_NOISE_FLOOR / 10.0, (
        f"{vector_name}: the two sides diverge by {worst!r}, which is within an "
        f"order of magnitude of the comparison floor {_LIBM_NOISE_FLOOR!r}"
    )


@pytest.mark.parametrize(("constant", "value"), TURNING_CONSTANTS)
@pytest.mark.parametrize("vector_name", TURNING_VECTORS)
def test_a_mutated_turning_constant_turns_the_contract_red(
    vector_name: str, constant: str, value: float, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Plan 076 S5a: the blind spots are closed, and the check is permanent.

    The constant is mutated **at runtime** - the method ADR-008 used for
    its own sweeps - so the test proves what the mutation check proved by
    hand: the Python trajectory no longer matches the committed golden, and
    the contract's own comparison goes red.

    Before this slice the same mutation left the whole contract green.
    """
    v = _vector(vector_name)
    ts = _golden(vector_name)
    baseline = _ensure_python_snapshot(v, sample_every=_sample_every())

    monkeypatch.setattr(sim_core, constant, value)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    # The contract's comparison must reject the mutated trajectory.
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)

    # ... and it must reject it because the trajectory moved, not because of
    # a rounding artefact: the drift is metres, the noise floor is 1e-9.
    drift = max(
        abs(ps[key] - ms[key])
        for ps, ms in zip(baseline["samples"], mutated["samples"], strict=True)
        for key in ("x", "z", "heading")
    )
    assert drift > 1e-3, (
        f"{vector_name}: mutating {constant} moved the trajectory by only "
        f"{drift!r} - the constant is still (almost) a blind spot"
    )

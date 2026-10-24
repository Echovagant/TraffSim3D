"""The training sim's junction box radius - what it is, and what pins it.

The browser and the training sim have **two** junction-box radii, and they
are deliberately two different numbers:

| side | radius | the rule behind it |
|---|---|---|
| the product (browser) | 15.0 m for the 6-lane cross scene | `src/domain/services/junctionRadius.ts` -> `halfWidth + INTERSECTION_CLEARANCE_M` (4.5 m) |
| the training sim (Python) | 8.0 m | `app/apps/rl/sim_core.py` -> `INTERSECTION_RADIUS` (a literal) |

**They are different quantities, and this module is what keeps them that
way.** The product's number is *derived* from a lane model: the box has to
hold the crossing carriageway (its half-width) plus the room a vehicle
waiting at the stop line needs, because the stop rule acts on the
vehicle's **centre** and a real vehicle has a length, so it may overhang
by up to half of it.

**That overhang cannot happen in the training sim, because its vehicles are
POINTS.** The `Vehicle` dataclass carries no length, the collision test is
centre-to-centre, the queue gap is centre-to-centre, and the stop rule and
the occupancy test both read the vehicle's centre. So:

- the clearance term **does not exist** on this side;
- the 8 m box is a **measured margin over the carriageway**
  (`ROAD_HALF_WIDTH` = 3.5 m), not a derived value;
- `ROAD_HALF_WIDTH + 4.5 == 8.0` is an **arithmetic coincidence**, not a
  shared rule. Importing the browser's clearance constant here would
  "unify" two different quantities and re-couple this number to the
  product's lane model.

What pins the value (all of it is asserted below):

1. the **value** - 8.0 m, a literal;
2. the **floor** - the box has to contain the whole carriageway;
3. the **sample grid** - the contract's `red_light_axis_disagreement`
   vector's red-light termination has to land on a 10-step sample step,
   and the committed golden pins it to step 30. Measured by bisection on
   the radius: that termination lands on the grid only for a radius in
   (7.852, 8.541] m (step 30), (13.712, 14.172] m (step 20) or
   (17.274, 17.504] m (step 10). 8.0 m is in the first window; the other
   two would keep the grid but still move the committed golden. A radius
   above 15.555 m additionally breaks the contract's own gate, which
   asserts that the vector's ego **starts outside** the box;
4. the **training baselines** - the reward numbers in
   `tests/test_rl_signal_train.py`, `tests/test_signal_conflict.py` and
   `tests/test_signal_open_traffic.py` all move with it (measured: 10
   test failures at 14.0 m);
5. the **premise** - the vehicles have no body (test
   `test_the_vehicles_have_no_body`). If that ever stops being true, the
   radius has to be re-derived: the box would then have to hold a
   vehicle's overhang, and the number would stop being a measured margin
   over the carriageway.
"""

from __future__ import annotations

import dataclasses
import json
import math
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl import sim_core
from app.apps.rl.sim_core import SimCore, TrafficLight, Vehicle

CONTRACT_DIR = Path(__file__).resolve().parent / "contract"
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"

#: The contract vector whose red-light termination lands on a sample step.
AXIS_VECTOR = "red_light_axis_disagreement"
#: The contract's sampling interval (in steps).
SAMPLE_EVERY = 10
#: The step the committed golden pins that termination to.
GOLDEN_TERMINATION_STEP = 30
#: The reward-baseline files whose numbers move with the radius.
BASELINE_FILES = (
    "tests/test_rl_signal_train.py",
    "tests/test_signal_conflict.py",
    "tests/test_signal_open_traffic.py",
)


# --------------------------------------------------------------------------
# The contract vector
# --------------------------------------------------------------------------


def _vector(name: str) -> dict:
    """The contract's vector definition (the single source of truth)."""
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    for v in data["vectors"]:
        if v["name"] == name:
            return v
    raise KeyError(name)


def _expand_actions(v: dict) -> list[list[float]]:
    """The contract's action-expansion rule: `repeat` copies of `actions`."""
    if "repeat" not in v:
        return list(v["actions"])
    return list(v["actions"]) * int(v["repeat"])


def _run_axis_vector(radius: float, monkeypatch: pytest.MonkeyPatch) -> int:
    """Run the axis vector at `radius`; return the step it ended on.

    The radius is patched on the module (both the red-light rule and the
    traffic model read the module global at call time), so the run is
    exactly the one the radius would produce.
    """
    monkeypatch.setattr(sim_core, "INTERSECTION_RADIUS", radius)
    monkeypatch.setattr(sim_core, "STOP_LINE_DISTANCE", radius)
    v = _vector(AXIS_VECTOR)
    core = SimCore(scene_kind=v["scene_kind"], max_steps=int(v.get("max_steps", 200)))
    core.reset()
    light = v["light_override"]
    core.light = TrafficLight(ns_green=bool(light["ns_green"]), ew_green=bool(light["ew_green"]))
    start = v["ego_start"]
    core.ego = Vehicle(
        x=float(start["x"]),
        z=float(start["z"]),
        heading=float(start["heading"]),
        speed=float(start["speed"]),
    )
    for action in _expand_actions(v):
        core.step(np.asarray(action, dtype=np.float32))
        if core._terminated or core._truncated:
            break
    return core.step_count


def _step_window(step: int, monkeypatch: pytest.MonkeyPatch) -> tuple[float, float]:
    """The radius interval in which the axis vector terminates on `step`.

    The termination gets *earlier* as the box grows (a bigger box is
    entered earlier), so the interval can be bracketed by bisection.

    The window is **re-measured** here rather than written down, so the
    pin cannot go stale: if the model changes, the window moves with it
    and the assertion still means what it says.
    """
    low, high = 0.5, 40.0
    # the largest radius that still terminates on `step` or later
    a, b = low, high
    for _ in range(50):
        mid = (a + b) / 2
        if _run_axis_vector(mid, monkeypatch) >= step:
            a = mid
        else:
            b = mid
    upper = a
    # the smallest radius that terminates on `step` or earlier
    a, b = low, high
    for _ in range(50):
        mid = (a + b) / 2
        if _run_axis_vector(mid, monkeypatch) > step:
            a = mid
        else:
            b = mid
    lower = b
    return lower, upper


# --------------------------------------------------------------------------
# The pins
# --------------------------------------------------------------------------


def test_the_radius_is_8_0() -> None:
    """The value itself - a literal, because there is no derivation to
    write down (see the module docstring for why)."""
    assert sim_core.INTERSECTION_RADIUS == 8.0


def test_the_box_holds_the_whole_carriageway() -> None:
    """The floor: the NPCs sit at +/- 3.5 m from the centreline, so the
    box has to be wider than that. A box narrower than the carriageway
    leaves the outer lane outside it - the defect the product's rule
    exists to fix, and the reason the training sim's box has a margin
    at all."""
    radius = sim_core.INTERSECTION_RADIUS
    assert radius > sim_core.ROAD_HALF_WIDTH
    core = SimCore(scene_kind="cross")
    core.reset()
    core.npcs = [Vehicle(x=sim_core.ROAD_HALF_WIDTH, z=0.0, heading=0.0, speed=0.0)]
    assert core._occupied_axes() == {"ew"}
    # just outside the box -> not in the junction any more
    core.npcs[0].x = radius + 0.01
    assert core._occupied_axes() == set()


def test_the_vehicles_have_no_body() -> None:
    """The premise the radius rests on: this sim's vehicles have **no
    body**, so the product's nose-overhang clearance cannot apply here.

    If this test ever fails, the radius has to be re-derived rather than
    moved: the box would then have to hold a vehicle's overhang, and the
    number would stop being a measured margin over the carriageway.
    """
    fields = {f.name for f in dataclasses.fields(Vehicle)}
    assert not fields & {
        "length",
        "width",
        "half_length",
        "half_width",
        "footprint",
    }
    # The collision test is a centre-to-centre threshold: two vehicles
    # whose centres are 3.0 m apart are a normal queue, even though a
    # 4.5 m car body would overlap there.
    core = SimCore(scene_kind="cross")
    core.reset()
    core.ego = Vehicle(x=0.0, z=-10.0, heading=math.pi / 2, speed=0.0)
    core.npcs = [Vehicle(x=0.0, z=-13.0, heading=math.pi / 2, speed=0.0)]
    _, _, terminated, _, info = core.step(np.asarray([0.0, 0.0], dtype=np.float32))
    assert info["reason"] != "collision"
    assert not terminated


def test_the_clearance_term_does_not_exist_here() -> None:
    """The product's rule is `halfWidth + INTERSECTION_CLEARANCE_M`; this
    sim has **no** clearance term, and importing one would re-couple the
    two numbers to each other."""
    assert not hasattr(sim_core, "INTERSECTION_CLEARANCE_M")
    # The margin above the carriageway is 4.5 m - numerically the same as
    # the browser's clearance constant, but a different quantity: there is
    # no vehicle body here for it to make room for.
    assert sim_core.INTERSECTION_RADIUS - sim_core.ROAD_HALF_WIDTH == 4.5


def test_the_red_light_termination_lands_on_the_sample_grid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The contract samples the episode every 10 steps, so the vector's
    red-light termination has to BE a sample step - and the committed
    golden pins it to step 30."""
    radius = sim_core.INTERSECTION_RADIUS
    step = _run_axis_vector(radius, monkeypatch)
    assert step % SAMPLE_EVERY == 0
    assert step == GOLDEN_TERMINATION_STEP


def test_the_radius_sits_in_the_window_where_the_golden_stays_put(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The **reason** the radius cannot move: the committed golden pins
    the termination to step 30, and only a radius inside that window
    produces it.

    The window is re-measured (bisection on the radius) rather than
    written down, so this test cannot go stale.
    """
    radius = sim_core.INTERSECTION_RADIUS
    lower, upper = _step_window(GOLDEN_TERMINATION_STEP, monkeypatch)
    assert lower < radius <= upper, (
        f"the radius {radius} m is outside the window ({lower:.3f}, {upper:.3f}] "
        "in which the contract's red-light termination stays on step "
        f"{GOLDEN_TERMINATION_STEP}"
    )


def test_the_reward_baselines_that_pin_the_radius_are_still_there() -> None:
    """The radius moves the training sim's reward baselines (measured:
    10 test failures at 14.0 m). This test asserts that the files
    holding those baselines are still there - if they are moved or
    deleted, the pin is gone and this goes red."""
    root = Path(__file__).resolve().parent.parent
    for relative in BASELINE_FILES:
        assert (root / relative).exists(), f"the reward baseline {relative} is gone"

"""The contract vectors that make the road rules non-vacuous.

Before the fix the cross-language contract could not see two of the ego sim's
rules at all:

- the **red-light axis** — the TS mirror classified the axis with the old
  "within 0.5 rad of north" heuristic while Python used the traffic model's
  own `approach_axis()` (they disagree on 26 of the 72 sampled headings);
- the **success condition's road constraint** — the TS mirror scored a
  success for an ego that had left the road, Python did not.

Both were *latent* drifts: no contract vector exercised them, so the
contract stayed green while the two sides meant different things.

This module adds the gates:

1. `red_light_axis_disagreement` — the ego sits **inside the intersection**
   with a heading of 50 degrees (inside the band where the two rules
   disagree) and the NS axis red. Python calls it a red-light run; the old
   heuristic called the ego "ew" and let it through.
2. `off_road_no_success` — the ego starts 6 m off the centreline (beyond
   the 3.5 m road half-width) and drives **across** the goal line: neither
   side may score the success.
3. `steer_residual` — a non-zero steering channel (`action[1]`), i.e. the
   policy's residual on top of the scripted Pure Pursuit steer. The old
   mirror ignored `action[1]` entirely.

Each gate is a **mutation**: the rule is broken at runtime on the Python
side and the contract's own comparison has to go red. A vector that cannot
detect the broken rule would be decoration, not a gate.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl import sim_core
from app.apps.rl.sim_core import SimCore

try:
    # pytest's default ("prepend") import mode puts this directory on
    # `sys.path`, so the sibling module is importable by its bare name.
    from test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
    )
except ImportError:  # pragma: no cover - alternative import mode
    from tests.contract.test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
    )

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"

#: The vector that parks the ego in the intersection on a disputed heading.
AXIS_VECTOR = "red_light_axis_disagreement"
#: The vector that leaves the road and crosses the goal line.
OFF_ROAD_VECTOR = "off_road_no_success"
#: The vector that commands a non-zero steering residual.
RESIDUAL_VECTOR = "steer_residual"


#: The old red-light axis heuristic — the one the TS mirror used until the fix.
def _old_approach_axis(heading: float) -> str:
    """The previous heuristic: "within 0.5 rad of north" means the NS axis."""
    heading_ns = abs((heading % (2 * math.pi)) - math.pi / 2) < 0.5
    return "ns" if heading_ns else "ew"


def _sample_every() -> int:
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    return int(data.get("sample_every", 5))


def _golden(name: str) -> dict:
    return json.loads(_golden_path(name).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# The axis rule
# --------------------------------------------------------------------------


def test_the_axis_vector_sits_on_a_disputed_heading() -> None:
    """The vector is *inside* the band where the two rules disagree.

    Without that, the vector would pass on both sides and the gate would
    be decoration.

    The ego **starts outside** the intersection and drives in on that
    heading: the scripted steer is exactly 0 (it starts on the 50-degree
    ray towards the Pure Pursuit target), so the heading cannot drift out
    of the band before the ego enters the box — and the entry lands on a
    **sample step** (step 30), so the contract's sampled comparison sees
    the event too.
    """
    v = _vector(AXIS_VECTOR)
    heading = float(v["ego_start"]["heading"])

    assert sim_core.approach_axis(heading) == "ns"
    assert _old_approach_axis(heading) == "ew", (
        "the vector's heading no longer sits in the band where the old "
        "heuristic and the traffic model disagree"
    )
    # it starts outside the intersection ...
    assert abs(float(v["ego_start"]["x"])) >= sim_core.INTERSECTION_RADIUS
    assert abs(float(v["ego_start"]["z"])) >= sim_core.INTERSECTION_RADIUS
    # ... and the termination (the entry) is a sample point.
    golden = _golden(AXIS_VECTOR)
    steps = [s["step"] for s in golden["samples"]]
    assert golden["final_state"]["final_step"] in steps, (
        "the termination step is not sampled, so the sampled comparison " "would not see the event"
    )


def test_the_axis_vector_terminates_on_the_red_light() -> None:
    """Both sides call it a red-light run (the golden is the TS side)."""
    golden = _golden(AXIS_VECTOR)
    assert golden["final_state"]["reason"] == "red_light"


def test_the_old_axis_heuristic_would_have_missed_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: break the axis rule and the contract must go red.

    The old heuristic classified the ego's 50-degree heading as the **ew**
    axis, where the light is green — so the run went unpunished and the
    episode continued. That is the exact drift that was found, and this is the
    check that keeps it fixed.
    """
    v = _vector(AXIS_VECTOR)
    ts = _golden(AXIS_VECTOR)

    monkeypatch.setattr(sim_core, "approach_axis", _old_approach_axis)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert mutated["final_state"]["reason"] != "red_light", (
        "the old heuristic still catches this run - the vector no longer "
        "discriminates the two rules"
    )
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


# --------------------------------------------------------------------------
# The road rule
# --------------------------------------------------------------------------


def test_the_off_road_vector_crosses_the_goal_line_without_scoring() -> None:
    """The ego got there — it just may not score for it.

    The rule is about the *route*, not about the destination: an ego that
    left the road and crossed the line has not arrived.
    """
    v = _vector(OFF_ROAD_VECTOR)
    golden = _golden(OFF_ROAD_VECTOR)

    assert (
        float(v["ego_start"]["x"]) > sim_core.ROAD_HALF_WIDTH
    ), "the vector's start is not off the road any more"
    assert golden["final_state"]["reason"] != "success"
    # The ego really did cross the goal line: the episode ended later than
    # the fastest arrival, and it is past the line.
    assert golden["final_state"]["final_z"] > sim_core.SCENE_GOAL_Z["cross"]


def test_without_the_road_rule_the_off_road_vector_would_score(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: remove the road constraint and the contract must go red."""
    v = _vector(OFF_ROAD_VECTOR)
    ts = _golden(OFF_ROAD_VECTOR)

    monkeypatch.setattr(sim_core, "lateral_offset", lambda vehicle: 0.0)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert (
        mutated["final_state"]["reason"] == "success"
    ), "with the road constraint removed the vector no longer discriminates it"
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


# --------------------------------------------------------------------------
# The steering residual
# --------------------------------------------------------------------------


def test_the_residual_vector_is_observable() -> None:
    """The steering channel is not inert: it moves the ego.

    The residual vector's trajectory differs from the same vector with no
    residual — which is what makes the two sides' agreement on it
    meaningful.
    """
    v = _vector(RESIDUAL_VECTOR)
    golden = _golden(RESIDUAL_VECTOR)
    headings = [s["heading"] for s in golden["samples"]]
    assert (
        abs(headings[-1] - headings[0]) > 0.1
    ), "the residual barely moved the ego - the vector covers nothing"

    core = SimCore(scene_kind=v["scene_kind"], max_steps=v.get("max_steps", 200))
    core.reset()
    for _ in range(10):
        core.step(np.asarray(v["actions"][0], dtype=np.float32))
    with_residual = core.ego.heading

    plain = SimCore(scene_kind=v["scene_kind"], max_steps=v.get("max_steps", 200))
    plain.reset()
    for _ in range(10):
        plain.step(np.asarray([v["actions"][0][0], 0.0], dtype=np.float32))
    assert abs(with_residual - plain.ego.heading) > 0.1, (
        "the residual and the no-residual run are the same - the steering " "channel is inert"
    )


def test_the_two_sides_agree_on_the_residual_trajectory() -> None:
    """The residual vector is a turning one, so it uses the noise floor."""
    v = _vector(RESIDUAL_VECTOR)
    py = _ensure_python_snapshot(v, sample_every=_sample_every())
    ts = _golden(RESIDUAL_VECTOR)
    _assert_agrees(v, py, ts, _LIBM_NOISE_FLOOR)

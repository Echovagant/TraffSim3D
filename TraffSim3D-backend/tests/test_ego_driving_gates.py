"""The ego's four gates — the regressions the four fixes pin.

Four things changed in `app/apps/rl/sim_core.py`:

1. **steering authority** — `action[1]` became a *residual* on top of the
   scripted Pure Pursuit steer (the scripted controller is the baseline);
2. **the alive bonus** — it is tied to the progress the ego makes, so it
   can no longer be farmed by standing still or by creeping;
3. **the success condition** — it needs the ego to have *stayed* on the
   road, not merely to have crossed the goal line somewhere;
4. **the red-light axis** — it uses the traffic model's own
   `approach_axis`, so the two can no longer disagree about which axis the
   ego is on.

One test per fix, plus the steering-residual test (the fourth change is
covered by the same file because it is the *semantics* of the action
space the other three sit on).

Every test here is written so that the **previous** code fails it: the
old alive bonus paid a standing step, the old success condition was
route-agnostic, and the old red-light rule disagreed with the traffic
model on 23 of the 68 sampled headings that are not on the axis
boundary (and on the four boundary headings as well).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.sim_core import (
    MAX_STEER,
    PROGRESS_WEIGHT,
    ROAD_HALF_WIDTH,
    TIME_COST,
    SimCore,
    Vehicle,
    approach_axis,
)

#: The 72 headings the axis classification is asserted on (every 5 degrees).
SAMPLED_HEADINGS = [math.radians(deg) for deg in range(0, 360, 5)]


def _old_heading_ns(heading: float) -> bool:
    """The **previous** red-light axis heuristic, kept to pin what it got wrong.

    It read the axis off the heading as "within 0.5 rad of north"
    (61.35deg - 118.65deg), while the traffic model uses
    `|sin h| >= |cos h|` (45deg - 135deg and 225deg - 315deg).
    """
    return abs((heading % (2 * math.pi)) - math.pi / 2) < 0.5


def _drive(core: SimCore, action: tuple[float, float], steps: int) -> float:
    """Step `core` and return the accumulated reward."""
    total = 0.0
    for _ in range(steps):
        _, reward, terminated, truncated, _ = core.step(
            np.array([action[0], action[1]], dtype=np.float32)
        )
        total += float(reward)
        if terminated or truncated:
            break
    return total


# --------------------------------------------------------------------------
# Fix 2 — the alive bonus cannot be farmed by standing still
# --------------------------------------------------------------------------


def test_the_time_cost_makes_standing_still_a_loss() -> None:
    """A step that covers no ground earns nothing; doing nothing loses.

    The per-step alive bonus used to be a flat 0.05 per step: it paid a
    policy for *existing*. Standing still collected it, and creeping
    collected it more often than driving did - which is why the trained
    policy beat "constant full throttle" only because it drove slower,
    and still lost to the best constant throttle.

    The per-step term was turned around: the passage of time is
    now **charged** (`TIME_COST`), so a step that makes no progress is a
    pure loss, and an episode that does nothing scores **worse** than one
    that drives to the goal.
    """
    standing = SimCore(scene_kind="cross", max_steps=200)
    standing.reset()
    for _ in range(20):
        _, reward, terminated, truncated, _ = standing.step(np.array([0.0, 0.0], dtype=np.float32))
        # The previous code paid +0.05 here.
        assert reward == pytest.approx(-TIME_COST), f"a standing step earned {reward}"
        assert not terminated and not truncated

    # The whole episode: doing nothing means being rear-ended.
    idle = SimCore(scene_kind="cross", max_steps=200)
    idle.reset()
    idle_return = _drive(idle, (0.0, 0.0), 200)
    assert idle._terminated_reason == "collision"

    # ... and driving to the goal scores strictly better.
    driving = SimCore(scene_kind="cross", max_steps=200)
    driving.reset()
    driving_return = _drive(driving, (1.0, 0.0), 200)
    assert driving._terminated_reason == "success"

    assert idle_return < driving_return, (
        f"doing nothing ({idle_return:.3f}) must score worse than "
        f"driving ({driving_return:.3f})"
    )


def test_the_reward_is_progress_minus_a_time_cost() -> None:
    """The shape of the reward: progress per metre, time charged per step.

    It pins the *shape* of the reward: a step that advances `d` metres
    pays `PROGRESS_WEIGHT * d` for the distance and `TIME_COST` for the
    time it took, so arriving sooner is worth more and standing still is
    worth less.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    _, reward, _, _, info = core.step(np.array([1.0, 0.0], dtype=np.float32))
    progress = float(info["progress"])
    assert progress > 0.0
    assert reward == pytest.approx(PROGRESS_WEIGHT * progress - TIME_COST)


# --------------------------------------------------------------------------
# The progress reward must not be farmable either
# --------------------------------------------------------------------------


def test_driving_past_the_goal_cannot_be_farmed() -> None:
    """An off-road ego that drives past the goal earns less than a success.

    The success needs the ego to have stayed on the road, so
    an off-road ego is never terminated by it — and if the progress reward
    were unbounded it could drive past the goal and earn progress forever.
    The first training run found exactly that (episode returns of 283
    against a ceiling of ~59).

    The progress is bounded by the goal line, so the off-road run earns the
    distance to the goal and **not** the success bonus: strictly less than
    an on-road run.
    """
    on_road = SimCore(scene_kind="cross", max_steps=200)
    on_road.reset()
    on_road_return = _drive(on_road, (1.0, 0.0), 200)
    assert on_road._terminated_reason == "success"

    # Off the road: the same throttle, but the ego is 6 m off the centreline.
    off_road = SimCore(scene_kind="cross", max_steps=200)
    off_road.reset()
    off_road.ego.x = 6.0
    off_road.ego.heading = math.pi / 2
    off_road_return = _drive(off_road, (1.0, 0.0), 200)
    assert off_road._off_road is True
    assert off_road._terminated_reason != "success"

    assert off_road_return < on_road_return, (
        f"the off-road run ({off_road_return:.3f}) must score worse than "
        f"the successful one ({on_road_return:.3f})"
    )


def test_zig_zagging_cannot_be_farmed() -> None:
    """A step backwards cancels the step before it — and costs time.

    The old progress term was `max(0, dz)`: a backwards step was clipped
    away, so the ego could drive north, south, north, south and collect the
    progress again and again. The progress is signed now, so the zig-zag
    nets out, and the time it took is charged on top.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    core.ego.z = -25.0

    # Two steps north, then two steps south at the same speeds.
    core.ego.heading = math.pi / 2
    north = 0.0
    north_progress = 0.0
    for _ in range(2):
        _, reward, _, _, info = core.step(np.array([0.5, 0.0], dtype=np.float32))
        north += reward
        north_progress += float(info["progress"])
    core.ego.heading = -math.pi / 2
    core.ego.speed = 0.0
    south = 0.0
    south_progress = 0.0
    for _ in range(2):
        _, reward, _, _, info = core.step(np.array([0.5, 0.0], dtype=np.float32))
        south += reward
        south_progress += float(info["progress"])

    assert north_progress > 0.0
    # The way back cancels the progress exactly ...
    assert south_progress == pytest.approx(-north_progress, abs=1e-12)
    # ... and the time the round trip took makes it a loss, where the old
    # `max(0, dz)` term paid the north leg twice.
    assert north + south < 0.0


# --------------------------------------------------------------------------
# Fix 3 — success needs the ego to have stayed on the road
# --------------------------------------------------------------------------


def _ego_at(core: SimCore, x: float, z: float, heading: float, speed: float) -> None:
    core.ego = Vehicle(x=x, z=z, heading=heading, speed=speed)


def test_an_ego_that_leaves_the_road_does_not_get_success() -> None:
    """Crossing the goal line off the road is not a success.

    The success condition used to be route-agnostic (`ego.z > 25`), so a
    wrong route that left the road scored the same success - and the same
    +5 bonus - as the right one.

    The road half-width is 3.5 m: the scenes place their NPCs at a 3.5 m
    lateral offset from the centreline (`_reset_cross`: the southbound
    NPC at `x = 3.5`, the westbound one at `z = 3.5`), so 3.5 m is the
    half-width the scene itself implies.
    """
    assert ROAD_HALF_WIDTH == 3.5

    # The control: in the lane, past the line -> success.
    on_road = SimCore(scene_kind="cross", max_steps=200)
    on_road.reset()
    _ego_at(on_road, 0.0, 25.5, math.pi / 2, 5.0)
    on_road.step(np.array([1.0, 0.0], dtype=np.float32))
    assert on_road.ego.z > 25.0
    assert on_road._terminated_reason == "success"

    # The case under test: 6 m off the centreline (> the 3.5 m half-width),
    # past the same line -> NOT a success.
    off_road = SimCore(scene_kind="cross", max_steps=200)
    off_road.reset()
    _ego_at(off_road, 6.0, 25.5, math.pi / 2, 5.0)
    off_road.step(np.array([1.0, 0.0], dtype=np.float32))
    assert off_road.ego.z > 25.0  # it DID cross the line
    assert off_road._off_road is True
    assert off_road._terminated_reason != "success"


def test_leaving_the_road_is_latched_for_the_whole_episode() -> None:
    """The success needs the ego to have **stayed** on the road.

    An ego that leaves the road and comes back has still not stayed on
    it, so it may not score the success either.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    # One step off the road.
    _ego_at(core, 5.0, -20.0, math.pi / 2, 5.0)
    core.step(np.array([1.0, 0.0], dtype=np.float32))
    assert core._off_road is True

    # Back in the lane, past the line -> still not a success.
    _ego_at(core, 0.0, 25.5, math.pi / 2, 5.0)
    core.step(np.array([1.0, 0.0], dtype=np.float32))
    assert core.ego.z > 25.0
    assert core._terminated_reason != "success"

    # A fresh episode clears the latch.
    core.reset()
    assert core._off_road is False


# --------------------------------------------------------------------------
# Fix 4 — the red-light axis is the traffic model's own classification
# --------------------------------------------------------------------------


def test_the_red_light_axis_matches_the_traffic_model_on_every_sampled_heading() -> None:
    """All 72 sampled headings (every 5 degrees), both directions.

    The rule must fire exactly when the light is red **for the axis the
    ego is on** — and that axis is the traffic model's `approach_axis`,
    the same function the traffic model itself uses.
    """
    assert len(SAMPLED_HEADINGS) == 72

    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    # In the intersection: that is the only place the rule can fire.
    core.ego.x = 0.0
    core.ego.z = 0.0

    for heading in SAMPLED_HEADINGS:
        core.ego.heading = heading
        axis = approach_axis(heading)

        # (a) The light is green for the ego's axis -> no violation.
        core.light.ns_green = axis == "ns"
        core.light.ew_green = axis == "ew"
        assert core._check_red_light_run() is False, (
            f"heading {math.degrees(heading):.1f} deg (axis {axis}): "
            f"the rule fired on a green axis"
        )

        # (b) The light is red for the ego's axis -> a violation.
        core.light.ns_green = axis == "ew"
        core.light.ew_green = axis == "ns"
        assert core._check_red_light_run() is True, (
            f"heading {math.degrees(heading):.1f} deg (axis {axis}): "
            f"the rule missed a red light"
        )


def test_the_old_axis_heuristic_disagreed_with_the_traffic_model() -> None:
    """The fix is not vacuous: the old rule really did disagree.

    23 of the 68 sampled headings that are **not** on the axis boundary
    were classified differently by the old "within 0.5 rad of north"
    heuristic than by the traffic model - which is exactly why the two
    rules could produce a false "red light" termination *and* miss a real
    one.

    The four headings that sit exactly on the boundary (45, 135, 225 and
    315 degrees) are counted separately. There the two projections are
    mathematically equal, and the tie is broken to "ns" on **every**
    platform (see `approach_axis`): the rounding there exists precisely
    because `sin` and `cos` of one angle can differ in the last bit
    between platforms, which used to make this count - and the recorded
    contract goldens - depend on the machine. Counting the boundary
    headings into the total would put that dependency straight back.
    """
    disagreements = [
        heading
        for heading in SAMPLED_HEADINGS
        if _old_heading_ns(heading) != (approach_axis(heading) == "ns")
    ]
    off_boundary = [h for h in disagreements if round(math.degrees(h)) % 90 != 45]
    assert len(off_boundary) == 23
    # The boundary itself: a tie, broken the same way on every platform.
    for deg in (45.0, 135.0, 225.0, 315.0):
        heading = math.radians(deg)
        assert approach_axis(heading) == "ns", deg
        assert _old_heading_ns(heading) is False, deg


def test_the_false_positive_and_the_missed_violation_are_gone() -> None:
    """The two concrete failures the old rule produced, both closed.

    - **False positive**: at 45 degrees the traffic model says the ego is
      on the NS axis; the old rule said EW, so an ego on the *green* NS
      axis was terminated as "red light".
    - **Missed violation**: at 230 degrees the traffic model says NS; the
      old rule said EW, so a real red-light run was not punished.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    core.ego.x = 0.0
    core.ego.z = 0.0

    # The false positive: NS green, EW red, ego on the NS axis.
    core.ego.heading = math.radians(45.0)
    assert approach_axis(core.ego.heading) == "ns"
    assert _old_heading_ns(core.ego.heading) is False  # the old rule said EW
    core.light.ns_green = True
    core.light.ew_green = False
    assert core._check_red_light_run() is False

    # The missed violation: NS red, EW green, ego on the NS axis.
    core.ego.heading = math.radians(230.0)
    assert approach_axis(core.ego.heading) == "ns"
    assert _old_heading_ns(core.ego.heading) is False  # the old rule said EW
    core.light.ns_green = False
    core.light.ew_green = True
    assert core._check_red_light_run() is True


# --------------------------------------------------------------------------
# Fix 1 — the steering residual
# --------------------------------------------------------------------------


def test_the_steer_channel_is_a_residual_on_the_scripted_pursuit() -> None:
    """`action[1]` corrects the scripted steer; it does not replace it.

    The scripted Pure Pursuit is the baseline: with no correction the
    trajectory is exactly the one the baseline drives. A positive
    correction raises the heading (a left turn in this plane) and a
    negative one lowers it, so the two drives end up on opposite sides of
    the scripted line.
    """
    from app.apps.rl.env import TrafficEnv

    def run(steer: float) -> list[tuple[float, float, float]]:
        env = TrafficEnv(max_steps=200, scene_kind="cross")
        env.reset(seed=0)
        trace: list[tuple[float, float, float]] = []
        for _ in range(30):
            _, _, terminated, truncated, _ = env.step(np.array([0.5, steer], dtype=np.float32))
            trace.append((env.core.ego.x, env.core.ego.z, env.core.ego.heading))
            if terminated or truncated:
                break
        return trace

    neutral = run(0.0)
    positive = run(1.0)
    negative = run(-1.0)

    # The neutral command is the scripted baseline: the ego drives the
    # scripted line, which in this scene is x == 0.
    assert max(abs(x) for x, _, _ in neutral) < 1e-6
    # The corrections push it to the two sides, and to opposite sides.
    assert positive[-1][2] > neutral[-1][2]
    assert negative[-1][2] < neutral[-1][2]
    assert positive[-1][0] < -1.0
    assert negative[-1][0] > 1.0


def test_the_steer_residual_is_bounded_by_the_actuator_limit() -> None:
    """The total steer stays inside `MAX_STEER`, whatever the policy asks.

    The residual is scaled by `MAX_STEER` and the sum is clipped, so a
    policy commanding the maximum cannot exceed the scripted controller's
    own actuator limit.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    # Put the ego at a heading where the scripted steer saturates.
    core.ego.heading = math.pi / 2 + 1.0
    core.ego.x = 0.0
    core.ego.z = -10.0
    before = core.ego.heading
    core.step(np.array([0.0, 1.0], dtype=np.float32))
    delta = core.ego.heading - before
    assert delta <= MAX_STEER * 0.1 + 1e-12  # one step of the clipped steer

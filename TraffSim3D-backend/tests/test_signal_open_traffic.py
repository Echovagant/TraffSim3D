"""The **open** traffic model — the gates that make it real.

The original training scenario was a **closed loop**: every lane carried a
fixed fleet of vehicles that was respawned at the mirrored position when it
left the world. The consequence was a hard cap on the price of starving an
axis: the queue could never be longer than that fleet, so the delay of a
starved axis was bounded by (fleet size x episode length) — while the
browser's traffic is **open** (spawned at a fixed headway, gone after the
crossing) and its delay is not.

The open traffic replaces the closed loop with the open flow, behind a **knob**
(`SimCore.open_traffic`, default OFF, so the cross-language contract's
default path stays bit-identical) and turns it on in `SignalEnv`.

The gates below are the ones the design asks for (Gate C):

1. the starvation penalty is **no longer capped** — its delay must grow
   with the episode length, and the queue must grow with it;
2. the fixed-cycle baseline is **re-measured** (the traffic changed, so the
   baseline changed);
3. the original precondition still holds — the two axes carry an **unbalanced**
   demand, so "starve one axis" is not a degenerate optimum.
"""

from __future__ import annotations

import pytest

from app.apps.rl.signal_conditions import (
    EVAL_CONDITION,
    HOLDOUT_CONDITION,
    TRAIN_CONDITION,
)
from app.apps.rl.signal_env import SignalEnv
from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES, SimCore

ACTION_INDEX = {name: index for index, name in enumerate(SIGNAL_ACTION_NAMES)}
NO_OP = ACTION_INDEX["no_op"]
PREEMPT = ACTION_INDEX["preempt"]


def _run(
    schedule: list[int],
    *,
    condition=TRAIN_CONDITION,
    open_traffic: bool = True,
) -> dict:
    """Run a fixed schedule and report the return and the queue's peak.

    The episode's horizon is the schedule's length — the schedule *is* the
    horizon, so the two can never drift apart.
    """
    steps = len(schedule)
    env = SignalEnv(max_steps=steps, condition=condition, open_traffic=open_traffic)
    env.reset(seed=0)
    total = 0.0
    max_queue = 0
    info: dict = {}
    for index in schedule:
        _, reward, terminated, truncated, info = env.step(index)
        total += float(reward)
        max_queue = max(max_queue, int(info["queue_ns"]) + int(info["queue_ew"]))
        if terminated or truncated:
            break
    return {
        "return": total,
        "max_queue": max_queue,
        "vehicles": len(env.core.npcs),
        "steps_run": steps,
        "reason": info.get("reason", ""),
    }


# --------------------------------------------------------------------------
# The knob
# --------------------------------------------------------------------------


def test_the_open_traffic_is_a_knob_and_the_default_path_is_untouched() -> None:
    """The contract's default path must not move — not by one vehicle.

    The open traffic is **off** in `SimCore` (the contract vectors run on
    the default path) and **on** in `SignalEnv` (the signal agent trains
    on the browser-like traffic).
    """
    assert SimCore().open_traffic is False
    assert SignalEnv().core.open_traffic is True

    # The closed loop is still reachable and still gives its own numbers.
    closed = _run([NO_OP] * 600, open_traffic=False)
    assert closed["return"] == pytest.approx(-423.1, abs=0.05), (
        "the closed loop's fixed-cycle number moved - the knob changed more " "than it should"
    )


# --------------------------------------------------------------------------
# Gate C1: the starvation penalty is no longer capped
# --------------------------------------------------------------------------


def test_the_queue_is_no_longer_capped_by_the_fleet_size() -> None:
    """A starved lane's queue must keep growing with the episode.

    The closed loop's queue was pinned at the fleet size (14 vehicles on
    the road); the open model's queue grows with the time the axis is
    starved, because the arrivals keep coming and nobody leaves the
    world.
    """
    short = _run([PREEMPT] * 600)
    long = _run([PREEMPT] * 2400)
    closed_long = _run([PREEMPT] * 2400, open_traffic=False)

    assert long["max_queue"] > short["max_queue"], (
        f"the queue did not grow with the episode "
        f"({short['max_queue']} at 600 steps, {long['max_queue']} at 2400)"
    )
    assert long["max_queue"] > closed_long["max_queue"], (
        "the open model must be able to hold a longer queue than the " "closed loop's fleet"
    )


def test_the_starvation_delay_grows_with_the_episode_length() -> None:
    """The delay of a starved axis must grow — and grow faster than the
    closed loop's, which was capped by the fleet size.

    The closed loop's delay was linear in the episode length (a constant
    queue, so the area under the curve grows linearly). The open model's
    queue *grows*, so the area — the delay — grows super-linearly. That
    is the migration risk the plan wanted removed: in the browser,
    starving an axis gets more expensive the longer you do it.
    """
    delays = []
    for steps in (600, 1200, 2400):
        delays.append(-_run([PREEMPT] * steps)["return"])

    # Strictly more delay as the episode gets longer ...
    assert delays[0] < delays[1] < delays[2]
    # ... and more delay *per step*, which a capped queue cannot do.
    per_step = [d / s for d, s in zip(delays, (600, 1200, 2400), strict=True)]
    assert (
        per_step[0] < per_step[1] < per_step[2]
    ), f"the delay per step must grow with the episode {per_step}"

    # And at the long horizon the open model is much worse than the closed
    # one, because the closed one's queue was capped.
    closed = -_run([PREEMPT] * 2400, open_traffic=False)["return"]
    assert delays[2] > closed * 2.5, (
        f"the open model's starvation delay ({delays[2]:.1f}) should be "
        f"far worse than the closed loop's ({closed:.1f})"
    )


# --------------------------------------------------------------------------
# Gate C2: the baseline is re-measured
# --------------------------------------------------------------------------


def test_the_fixed_cycle_baseline_is_measured_on_the_open_traffic() -> None:
    """The fixed 30/30 cycle on the open traffic — the new baseline.

    The closed loop's number was -423.1 (the earlier measurement). The traffic
    changed, so the baseline changed: this is the number a trained policy
    has to beat.
    """
    result = _run([NO_OP] * 600)
    assert result["return"] == pytest.approx(-292.8, abs=0.05)


def test_starving_one_axis_is_still_the_worst_schedule() -> None:
    """The original precondition: "starve one axis" is not a degenerate optimum.

    In the open model it is not merely suboptimal — it is by far the worst
    schedule, because the price of starving now grows without bound.
    """
    fixed = _run([NO_OP] * 600)["return"]
    starve = _run([ACTION_INDEX["extend_green"]] * 600)["return"]
    all_red = _run([PREEMPT] * 600)["return"]

    assert fixed > starve, f"holding one axis green must cost more ({fixed} vs {starve})"
    assert starve > all_red, f"an all-red must cost the most ({starve} vs {all_red})"


# --------------------------------------------------------------------------
# The demand: still unbalanced, and now expressed as an arrival rate
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "condition", [TRAIN_CONDITION, EVAL_CONDITION, HOLDOUT_CONDITION], ids=lambda c: c.name
)
def test_the_two_axes_carry_an_unbalanced_demand(condition) -> None:
    """The original precondition, in the new units.

    The demand is now **arrivals per hour per lane** (the closed loop
    could not express a demand at all), and the EW axis still carries a
    third more than the NS one — otherwise the model has a degenerate
    optimum ("hold one axis green forever").
    """
    assert condition.ew_arrivals_per_hour > condition.ns_arrivals_per_hour
    ratio = condition.ew_arrivals_per_hour / condition.ns_arrivals_per_hour
    assert ratio == pytest.approx(
        4 / 3, rel=0.2
    ), f"the EW axis must stay about a third busier, got {ratio:.3f}"
    assert condition.ns_arrivals_per_hour > 0


def test_the_arrivals_follow_the_demand() -> None:
    """The spawner must deliver the condition's arrival rate.

    Measured over 600 steps (60 s) on the TRAIN condition. The spawner
    gives **every lane** its own headway (`3600 / arrivals_per_hour`),
    and the cross scene has two lanes per axis, so 60 s delivers

        NS: 2 lanes x 60 s / 12 s = 10
        EW: 2 lanes x 60 s /  9 s = 13

    minus the arrivals whose headway lands on the last step's boundary:
    20.

    ## Why the arrivals are counted through a held reference

    The count used to be "an npc whose ``id()`` was not in the previous
    step's set and not among the ids ever seen". ``id()`` is a **memory
    address**: once an npc is garbage collected, a later npc can be
    allocated at the same address — and the arrival was then silently
    missed. The count therefore depended on the allocator's mood: the
    same code with the same seed measured 11, 12, 12, 11 and 13
    arrivals on five consecutive runs, and the assertion band (9..14) had
    been fitted to that **undercount**. Under memory pressure the count
    fell below 9 and the test failed for no reason at all.

    Holding a reference to every arrival keeps its address alive, so it
    cannot be recycled, and the count becomes exact.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)
    arrivals = 0
    seen: set[int] = set()
    # Keeps the arrivals alive so their `id()` cannot be recycled.
    held: list[object] = []
    for _ in range(600):
        before = {id(npc) for npc in env.core.npcs}
        env.step(NO_OP)
        for npc in env.core.npcs:
            if id(npc) not in before and id(npc) not in seen:
                seen.add(id(npc))
                held.append(npc)
                arrivals += 1
    # 2 NS lanes x 60 s / 12 s + 2 EW lanes x 60 s / 9 s = 23.3, minus the
    # arrivals whose headway lands on the step boundary: 20.
    #
    # The band pins the **unit** as well as the number: the demand is per
    # **lane** (`TrafficCondition`: "how many vehicles arrive per hour per
    # lane on each axis"), so a per-axis reading would deliver about 12
    # arrivals in 60 s and fall out of the band. The field's name
    # (`ns_arrivals_per_hour`, with no `_per_lane` suffix, unlike
    # `ns_vehicles_per_lane`) is what makes that reading look natural —
    # measured 2026-10-25: EW lane 6 arrivals (400/h expected 6.67), NS
    # lane 4 arrivals (300/h expected 5.0).
    assert 18 <= arrivals <= 24, f"the arrivals do not follow the demand: {arrivals}"


def test_the_queue_disperses_at_the_shipped_demand() -> None:
    """The open model's precondition: the demand stays **below** the
    saturation flow rate, so the queue disperses instead of growing for
    ever.

    Measured over 240 s (the longest training horizon) with the TRAIN
    condition and the fixed cycle: the NS axis's queue is empty 59 % of
    the steps and the EW axis's 38 % — the saw-tooth of a working
    signal (the queue builds during the red and disperses during the
    green). A demand above the saturation rate would keep the queue
    non-empty for the whole episode, and the model's whole point (an
    unbounded price for starving an axis) would be measured on a world
    that is jammed rather than on a world that can serve.
    """
    steps = 2400
    env = SignalEnv(max_steps=steps)
    env.reset(seed=0)
    empty_ns = 0
    empty_ew = 0
    for _ in range(steps):
        obs, _reward, _terminated, _truncated, _info = env.step(NO_OP)
        if obs[0] == 0:
            empty_ns += 1
        if obs[1] == 0:
            empty_ew += 1
    # The bounds are loose on purpose: they separate "the queue disperses"
    # from "the queue only ever grows", and nothing else.
    assert empty_ns / steps > 0.35, (
        f"the NS queue never disperses — it is empty in only "
        f"{empty_ns / steps * 100:.1f} % of the episode"
    )
    assert empty_ew / steps > 0.20, (
        f"the EW queue never disperses — it is empty in only "
        f"{empty_ew / steps * 100:.1f} % of the episode"
    )


def test_the_vehicles_leave_the_world_instead_of_cycling_back() -> None:
    """The open flow's other half: a vehicle that crossed is gone.

    In the closed loop a vehicle that left the world was respawned at the
    mirrored position, so the population was constant. In the open model
    the population is the arrivals that have not crossed yet.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)
    start = len(env.core.npcs)
    for _ in range(600):
        env.step(NO_OP)
    end = len(env.core.npcs)

    assert end < start, (
        f"the population grew from {start} to {end}: the vehicles are not " "leaving the world"
    )

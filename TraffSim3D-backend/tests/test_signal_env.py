"""The signal agent's environment.

The gate that matters here is the **counterfactual reward test**: from
the same initial state, a schedule that serves both axes must score
better than a schedule that only ever serves one. If the two came out
equal (or reversed), the reward would not be pricing the *cross-axis*
delay and the counterfactual-reward rule would not be met — the agent would learn to
starve the opposite axis.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.signal_env import MAX_QUEUE, SIG_OBS_DIM, SignalEnv
from app.apps.rl.sim_core import (
    DT,
    MIN_GREEN_SECS,
    NPC_SPEED,
    PHASE_ADJUST_SECS,
    SIGNAL_ACTION_NAMES,
    SimCore,
    Vehicle,
)

# The action index is the position in `SIGNAL_ACTION_NAMES` — the order
# is part of the cross-language contract.
ACTION_INDEX = {name: index for index, name in enumerate(SIGNAL_ACTION_NAMES)}


def _run(schedule: list[int], steps: int = 600) -> tuple[float, dict]:
    """Run a fixed action schedule from the default initial state."""
    env = SignalEnv(max_steps=steps)
    env.reset(seed=0)
    total = 0.0
    info: dict = {}
    for index in schedule:
        _, reward, terminated, truncated, info = env.step(index)
        total += reward
        if terminated or truncated:
            break
    return total, info


def _queued_steps(schedule: list[int], axis: str, steps: int = 600) -> int:
    """How many steps the given axis had a non-empty queue."""
    env = SignalEnv(max_steps=steps)
    env.reset(seed=0)
    count = 0
    for index in schedule:
        _, _, terminated, truncated, _ = env.step(index)
        count += env.core.queue_length(axis) > 0
        if terminated or truncated:
            break
    return count


def test_the_env_turns_on_the_responsive_traffic_but_the_core_default_does_not() -> None:
    """The responsive traffic is opt-in: the contract vectors keep
    running the default path, which must stay bit-identical."""
    assert SimCore().responsive_traffic is False
    env = SignalEnv()
    assert env.core.responsive_traffic is True


def test_the_observation_has_the_planned_shape_and_stays_in_range() -> None:
    env = SignalEnv(max_steps=40)
    obs, _ = env.reset(seed=0)

    assert obs.shape == (SIG_OBS_DIM,)
    assert obs.dtype == np.float32
    assert env.observation_space.contains(obs)

    for index in range(len(SIGNAL_ACTION_NAMES)):
        obs, reward, terminated, truncated, _ = env.step(index)
        assert env.observation_space.contains(obs), f"action {index} left the observation box"
        assert reward <= 0.0, "the reward is a negative delay"


def test_the_action_index_maps_to_the_signal_action_names_in_order() -> None:
    """The mapping is the *position* in `SIGNAL_ACTION_NAMES` — the order
    is a cross-language contract, not an implementation detail."""
    assert SIGNAL_ACTION_NAMES == (
        "extend_green",
        "shorten_red",
        "preempt",
        "force_all_red",
        "no_op",
    )
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    for index, name in enumerate(SIGNAL_ACTION_NAMES):
        _, _, _, _, info = env.step(index)
        assert info["action"] == name
        assert ACTION_INDEX[name] == index


def test_the_chosen_action_really_reaches_the_light() -> None:
    """`preempt` puts the light into the all-red clearance — the
    observation must show it (idx 4)."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    env.step(ACTION_INDEX["preempt"])
    obs = env._obs()
    assert obs[2] == 0.0, "the NS axis must not be green"
    assert obs[3] == 0.0, "the EW axis must not be green"
    assert obs[4] == 1.0, "both axes stopped = all-red"


def test_the_observation_layout_matches_the_plan() -> None:
    """The observation layout, index by index."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    # Two vehicles queue up on the NS axis, the EW road stays empty.
    env.core.npcs = [
        Vehicle(x=0.0, z=-20.0, heading=np.pi / 2, speed=NPC_SPEED),
        Vehicle(x=0.0, z=-30.0, heading=np.pi / 2, speed=NPC_SPEED),
    ]
    env.core.light.ns_green = False
    env.core.light.ew_green = True
    for _ in range(60):
        env.core.light.ns_green = False
        env.core.light.ew_green = True
        env.core.light.cycle_timer = 0.0
        env.step(ACTION_INDEX["no_op"])

    obs = env._obs()
    assert obs[0] == pytest.approx(2 / MAX_QUEUE), "idx 0: NS queue / MAX_QUEUE"
    assert obs[1] == 0.0, "idx 1: EW queue / MAX_QUEUE"
    assert obs[2] == 0.0, "idx 2: NS has right of way"
    assert obs[3] == 1.0, "idx 3: EW has right of way"
    assert obs[4] == 0.0, "idx 4: not all-red"

    # idx 5: the phase clock, as a fraction of the cycle duration.
    env.core.light.cycle_timer = 15.0
    assert env._obs()[5] == pytest.approx(0.5)
    env.core.light.cycle_timer = 0.0
    assert env._obs()[5] == pytest.approx(0.0)


def test_the_reward_is_the_negative_delay() -> None:
    """The reward is the negative area under the queue curve."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    _, reward, _, _, info = env.step(ACTION_INDEX["no_op"])
    assert reward == pytest.approx(-(info["queue_ns"] + info["queue_ew"]) * DT)
    assert reward <= 0.0


def test_serving_both_axes_beats_starving_one_axis() -> None:
    """The counterfactual gate (the reward must price the cross-axis delay).

    Both schedules start from the same initial state:

    * "serve both" shortens the red on every step, so the phase turns
      over and neither axis is starved;
    * "serve one axis" extends the green on every step, so the green is
      held for the whole episode and the cross traffic waits.

    The second one must score *worse*. The reward therefore has to price
    the cross-axis delay — otherwise "extend forever" would be optimal,
    which is exactly the residual risk the rule was written to mitigate.
    """
    serve_both, both_info = _run([ACTION_INDEX["shorten_red"]] * 600)
    serve_one, one_info = _run([ACTION_INDEX["extend_green"]] * 600)

    assert serve_both > serve_one, (
        f"the schedule that starves one axis must score worse "
        f"(serve_both={serve_both}, serve_one={serve_one})"
    )
    # The mechanism behind the number: it is the *cross* axis that pays.
    # Under the starving schedule the cross axis is queued on EVERY step
    # of the episode (its queue never drains); under the "serve both"
    # schedule it drains regularly.
    assert one_info["queue_ew"] > 0, "the starved axis must be queued"
    assert (
        _queued_steps([ACTION_INDEX["extend_green"]] * 600, "ew") == 600
    ), "the starved axis must be queued on every step"
    assert (
        _queued_steps([ACTION_INDEX["shorten_red"]] * 600, "ew") < 600
    ), "the alternating schedule must let the cross axis drain"

    # A less extreme "serve both" schedule must beat it as well, so the
    # result does not hinge on one particular action pattern.
    moderate = [
        ACTION_INDEX["shorten_red"] if i % 10 == 0 else ACTION_INDEX["no_op"] for i in range(600)
    ]
    moderate_return, _ = _run(moderate)
    assert moderate_return > serve_one


def test_the_episode_ends_with_the_step_limit() -> None:
    """The signal agent has no success condition of its own: the episode
    ends by truncation."""
    env = SignalEnv(max_steps=25)
    env.reset(seed=0)

    truncated = False
    for _ in range(25):
        _, _, terminated, truncated, _ = env.step(ACTION_INDEX["no_op"])
        if terminated:
            break
    assert truncated is True


def test_an_out_of_range_action_is_rejected() -> None:
    env = SignalEnv(max_steps=10)
    env.reset(seed=0)

    with pytest.raises(ValueError):
        env.step(len(SIGNAL_ACTION_NAMES))


# --------------------------------------------------------------------------
# The minimum green time
# --------------------------------------------------------------------------


def test_the_env_refuses_to_shorten_a_green_below_the_minimum_green_time() -> None:
    """The environment masks `shorten_red` when the green has too little
    time left — and the light is not touched at all.

    The mask lives in the environment, not in the physical light model:
    `sim_core.TrafficLight.consume_actions` is untouched, so the
    cross-language contract's default behaviour stays bit-identical.
    """
    env = SignalEnv(max_steps=60)
    env.reset(seed=0)
    light = env.core.light

    # 12 s of green left: a shorten would take it to 7 s, below the
    # 10 s minimum → the action must be masked.
    light.cycle_timer = light.cycle_duration - 12.0
    before = light.cycle_timer
    _, _, _, _, info = env.step(ACTION_INDEX["shorten_red"])

    assert info["masked"] is True
    # The light was not touched by the action: the only clock movement is
    # the step's own DT tick.
    assert light.cycle_timer == pytest.approx(before + DT)

    # With 20 s of green left there IS room: the shorten is applied and
    # takes the phase-adjust step off the green's remaining time.
    light.cycle_timer = light.cycle_duration - 20.0
    before = light.cycle_timer
    _, _, _, _, info = env.step(ACTION_INDEX["shorten_red"])

    assert info["masked"] is False
    assert light.cycle_timer == pytest.approx(before + PHASE_ADJUST_SECS + DT)
    # ... and the green's remaining is still at or above the minimum.
    assert light.cycle_duration - light.cycle_timer >= MIN_GREEN_SECS


def test_the_minimum_green_time_boundary_is_exact() -> None:
    """A shorten is allowed exactly when the green's *remaining* would
    still be at least `MIN_GREEN_SECS` afterwards."""
    env = SignalEnv(max_steps=60)
    env.reset(seed=0)
    light = env.core.light

    # remaining == MIN_GREEN_SECS + PHASE_ADJUST_SECS → the shorten lands
    # exactly on the minimum → allowed.
    light.cycle_timer = light.cycle_duration - (MIN_GREEN_SECS + PHASE_ADJUST_SECS)
    _, _, _, _, info = env.step(ACTION_INDEX["shorten_red"])
    assert info["masked"] is False

    # A hair below → the shorten would break the minimum → masked.
    env.reset(seed=0)
    light = env.core.light
    light.cycle_timer = light.cycle_duration - (MIN_GREEN_SECS + PHASE_ADJUST_SECS) + 0.1
    _, _, _, _, info = env.step(ACTION_INDEX["shorten_red"])
    assert info["masked"] is True


def test_the_flicker_schedule_no_longer_scores_a_free_lunch() -> None:
    """The minimum-green regression, pinned.

    Before the minimum green time the "flicker" schedule — `shorten_red`
    on every step — drove the light at 0.6 s per phase. The vehicles
    never came to a full stop, so they were never counted as queued and
    the schedule's reward was *exactly* 0.0: strictly better than any
    honest schedule, and a degenerate policy to learn.

    With the minimum green time the same schedule degenerates into a
    legal timed plan (15 s / 15 s here), the vehicles do stop at the
    stop line, and the delay is real again.
    """
    flicker, info = _run([ACTION_INDEX["shorten_red"]] * 600)

    assert flicker < 0.0, (
        "the flicker schedule must incur a real delay — a zero reward means "
        f"the vehicles never came to a stop (flicker={flicker})"
    )
    assert info["total_delay"] > 0.0


def test_the_flicker_schedule_is_a_legal_timed_plan_now() -> None:
    """The masked flicker must respect the minimum green time.

    It is no longer the 0.6 s jitter of the old guard: the light alternates on a
    fixed, legal cycle, and every phase it runs is at least
    `MIN_GREEN_SECS` long.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)

    phase_started_at = 0.0
    previous_green = env.core.light.ns_green
    for _ in range(600):
        env.step(ACTION_INDEX["shorten_red"])
        green = env.core.light.ns_green
        if green != previous_green:
            # The phase that just ended must have run at least the
            # minimum green time.
            assert env.core.sim_time - phase_started_at >= MIN_GREEN_SECS
            phase_started_at = env.core.sim_time
            previous_green = green


def test_the_flicker_schedule_versus_the_default_schedule() -> None:
    """The prescribed comparison - and the measured result, **twice**.

    The minimum-green rule expected the masked flicker to score *worse* than the
    default 30/30 cycle. **Measured then, it did not**: the masked
    flicker scored -97.2 against the default's -109.2 - it was still
    the better schedule *in this model*.

    Why: the Python light model charged **no lost time** for a phase
    change (the swap was instantaneous - no yellow, no all-red), and
    the vehicles cleared the intersection comfortably inside a 15 s
    green. So a shorter cycle was pure gain for the delay metric (the
    area under the queue-length curve).

    **The lost time was added** (the 6 s inter-green clearance,
    charged by `SimCore` on every phase change) and the dense training
    scenario, and the flicker became worse than the alternating
    schedule (-437.2 against -423.1): in the **closed loop** the
    clearance was the expensive part, because it held the *whole fleet*
    still.

    **The traffic model changed again** (the closed loop became
    the browser-like open flow) and with it the comparison: the cost is
    no longer dominated by the clearance - it is the **red's duration**
    that costs, and a faster alternation has shorter reds. Measured on
    the open traffic (600 steps): flicker -260.8, fixed cycle -292.8 -
    the flicker is now the **better** schedule.

    So the *ordering* between the fixed cycle and the flicker is a
    property of the traffic model, not of the reward: it flipped when
    the traffic changed. What does **not** flip is the gate that
    matters - "starve one axis" is still the worst schedule by a wide
    margin (see `test_signal_open_traffic.py`).
    """
    flicker, _ = _run([ACTION_INDEX["shorten_red"]] * 600)
    default, _ = _run([ACTION_INDEX["no_op"]] * 600)

    assert flicker > default, (
        "the measured open-traffic ordering changed: the flicker is now "
        "the better schedule, because the delay is dominated by the red's "
        f"duration (flicker={flicker}, default={default})"
    )

    # The closed loop is unchanged: there the clearance dominated and the
    # flicker was the worse schedule.
    closed_env = SignalEnv(max_steps=600, open_traffic=False)
    closed_env.reset(seed=0)
    closed_flicker = 0.0
    for _ in range(600):
        _, reward, terminated, truncated, _ = closed_env.step(ACTION_INDEX["shorten_red"])
        closed_flicker += float(reward)
        if terminated or truncated:
            break
    assert closed_flicker < -423.1, (
        "the closed loop's ordering changed - the old numbers in the "
        f"docs are stale (closed flicker={closed_flicker})"
    )

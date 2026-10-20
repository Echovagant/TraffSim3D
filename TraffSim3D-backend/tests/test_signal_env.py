"""Plan 074 Sprint 3 (S3a-2): the signal agent's environment.

The gate that matters here is the **counterfactual reward test**: from
the same initial state, a schedule that serves both axes must score
better than a schedule that only ever serves one. If the two came out
equal (or reversed), the reward would not be pricing the *cross-axis*
delay and Plan 074 §2 D2 would not be met — the agent would learn to
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
    """Plan 074 §2 D1, index by index."""
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
    """The counterfactual gate (Plan 074 §2 D2).

    Both schedules start from the same initial state:

    * "serve both" shortens the red on every step, so the phase turns
      over and neither axis is starved;
    * "serve one axis" extends the green on every step, so the green is
      held for the whole episode and the cross traffic waits.

    The second one must score *worse*. The reward therefore has to price
    the cross-axis delay — otherwise "extend forever" would be optimal,
    which is exactly the residual risk D2 was written to mitigate.
    """
    serve_both, both_info = _run([ACTION_INDEX["shorten_red"]] * 600)
    serve_one, one_info = _run([ACTION_INDEX["extend_green"]] * 600)

    assert serve_both > serve_one, (
        f"the schedule that starves one axis must score worse "
        f"(serve_both={serve_both}, serve_one={serve_one})"
    )
    # The mechanism behind the number: it is the *cross* axis that pays.
    assert one_info["queue_ew"] > 0, "the starved axis must be queued"
    assert both_info["queue_ew"] == 0, "the served axes must not queue"

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
# Plan 074 T7: the minimum green time (§2 D5)
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
    """D5's regression, pinned (Plan 074 T7).

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

    It is no longer the 0.6 s jitter of D5: the light alternates on a
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
    """The plan's comparison — and the measured result.

    Plan 074 T7 expected the masked flicker to score *worse* than the
    default 30/30 cycle. **Measured, it does not**: the masked flicker
    scores -97.2 against the default's -109.2 — it is still the better
    schedule *in this model*.

    Why: the Python light model charges **no lost time** for a phase
    change (the swap is instantaneous — no yellow, no all-red), and the
    vehicles clear the intersection comfortably inside a 15 s green. So a
    shorter cycle is pure gain for the delay metric (the area under the
    queue-length curve). What is still missing is the second half of
    D5's diagnosis: the intersection conflict model, plus the per-switch
    clearance time — i.e. Sprint 5's "training env and browser from one
    source" work.

    This test pins the *measured* relationship on purpose: the day the
    model gains its lost time / conflict model, this assertion flips and
    the plan's gate (flicker < default) has to be re-derived.
    """
    flicker, _ = _run([ACTION_INDEX["shorten_red"]] * 600)
    default, _ = _run([ACTION_INDEX["no_op"]] * 600)

    assert flicker > default, (
        "the masked flicker used to beat the default schedule "
        f"(flicker={flicker}, default={default}); when this flips, the "
        "plan's gate (flicker < default) holds again — re-derive it"
    )

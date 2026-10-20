"""Plan 073 Sprint 2 (A2a): the Python light accepts the shared signal actions.

The traffic signal became an externally-actionable control surface: the
Python training sim now accepts the same five action names as the
frontend's `RLController`
(`TraffSim3D-frontend/src/application/services/controllers/RLController.ts`),
so a policy trained here can drive the browser's signal.

The **vocabulary** is cross-language — the contract asserts it
(`test_cross_lang_consistency.py::test_signal_action_vocabulary_matches_the_typescript_golden`).
This module pins the **semantics** on the Python side.

Why the semantics are pinned per side and not across: the browser's signal
has a 3 s yellow phase per light and Python's has none, so the two phase
timelines cannot be compared step by step. See `docs/contracts/sim-snapshot.md`,
"What the contract does NOT cover".
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.sim_core import (
    ALL_RED_SECS,
    ALL_RED_STEPS,
    PHASE_ADJUST_SECS,
    SIGNAL_ACTION_NAMES,
    SimCore,
    TrafficLight,
)

# The scene used to observe a full 30 s phase.
#
# The signalled scenes cannot: a parked ego is hit by an NPC long before the
# first flip (measured: `cross` 39 steps, `corridor` 45, `t_junction` 257 —
# see `docs/contracts/sim-snapshot.md`, "Root cause of the remaining limit").
# The roundabout runs to the step limit without a collision, and its light
# is overridden below so that the swap is observable.
_SCENE_KIND = "roundabout"

# Enough steps to see the first flip (step 300) and the effect of the
# actions around it.
_STEPS = 400


def _run(
    action: str | None = None,
    steps: int = _STEPS,
    *,
    at_steps: dict[int, str] | None = None,
) -> list[tuple[bool, bool]]:
    """Run an episode and record the light bits after every step.

    The light bits are `(ns_green, ew_green)` — the same pair the contract
    samples carry.

    `at_steps` applies an action on the given **1-based** steps, so a
    scenario can act at a precise moment of the episode (e.g. right after
    a clearance ends). `action` applies one action before the first step.
    """
    core = SimCore(scene_kind=_SCENE_KIND, max_steps=steps + 1)
    core.reset()
    # The roundabout's light is both-green ("no traffic lights there"), so
    # its swap is a no-op. Override it with a plain NS-green light.
    core.light = TrafficLight(ns_green=True, ew_green=False)
    if action is not None:
        core.light.apply_action(action)
    bits: list[tuple[bool, bool]] = []
    for step in range(1, steps + 1):
        if at_steps and step in at_steps:
            core.light.apply_action(at_steps[step])
        core.step(np.zeros(2, dtype=np.float32))
        bits.append((bool(core.light.ns_green), bool(core.light.ew_green)))
    return bits


def _flips(bits: list[tuple[bool, bool]]) -> list[int]:
    """The 1-based steps at which the light changes."""
    return [i + 1 for i in range(1, len(bits)) if bits[i] != bits[i - 1]]


def _first_flip(bits: list[tuple[bool, bool]]) -> int:
    """The 1-based step at which the light swaps, or -1 if it never does."""
    for i in range(1, len(bits)):
        if bits[i] != bits[i - 1]:
            return i + 1
    return -1


def test_the_vocabulary_is_the_five_shared_actions_in_order() -> None:
    """The list the contract compares, item by item, against TypeScript."""
    assert list(SIGNAL_ACTION_NAMES) == [
        "extend_green",
        "shorten_red",
        "preempt",
        "force_all_red",
        "no_op",
    ]


def test_apply_action_rejects_an_unknown_name() -> None:
    """The vocabulary is a contract, not a free-form string."""
    light = TrafficLight()
    with pytest.raises(ValueError):
        light.apply_action("go_faster")


def test_apply_action_does_not_change_the_light_before_the_next_step() -> None:
    """`apply_action` is synchronous but inert: the light changes on the step."""
    core = SimCore(scene_kind="cross")
    core.reset()
    core.light.apply_action("preempt")
    assert core.light.ns_green is True
    assert core.light.ew_green is False
    assert core.light.pending_actions == ["preempt"]


def test_the_default_cycle_is_unchanged() -> None:
    """With no action the light swaps at step 300 — the pre-Sprint-2 value.

    This is the "the default behaviour must be bit-identical" guarantee,
    measured on the light bits of a 400-step episode.
    """
    bits = _run()
    assert bits[0] == (True, False)
    assert _flips(bits) == [300]
    assert bits[299] == (False, True)


def test_extend_green_delays_the_swap_by_five_seconds() -> None:
    """The green axis gets 5 s more: the swap moves 50 steps later."""
    assert _first_flip(_run()) == 300
    assert _first_flip(_run("extend_green")) == 300 + int(PHASE_ADJUST_SECS / 0.1)


def test_shorten_red_advances_the_swap_by_five_seconds() -> None:
    """The red axis waits 5 s less: the swap moves 50 steps earlier."""
    assert _first_flip(_run()) == 300
    assert _first_flip(_run("shorten_red")) == 300 - int(PHASE_ADJUST_SECS / 0.1)


def test_extend_green_delays_the_swap_clock() -> None:
    """The light-level view: the phase clock is pushed back by 5 s."""
    light = TrafficLight(cycle_timer=10.0)
    light.apply_action("extend_green")
    light.consume_actions()
    assert light.cycle_timer == 10.0 - PHASE_ADJUST_SECS


def test_shorten_red_advances_the_swap_clock() -> None:
    """The light-level view: the phase clock is pushed forward by 5 s."""
    light = TrafficLight(cycle_timer=10.0)
    light.apply_action("shorten_red")
    light.consume_actions()
    assert light.cycle_timer == 10.0 + PHASE_ADJUST_SECS


def test_shorten_red_caps_at_the_cycle_duration() -> None:
    """With less than 5 s left, the swap happens on the next step at the latest."""
    light = TrafficLight(cycle_timer=29.0)
    light.apply_action("shorten_red")
    light.consume_actions()
    assert light.cycle_timer == 30.0


def test_preempt_clears_both_axes_for_three_seconds() -> None:
    """Neither axis is green for `ALL_RED_SECS`, then the phase resumes."""
    bits = _run("preempt")
    all_red = [i + 1 for i, b in enumerate(bits) if b == (False, False)]
    assert len(all_red) == ALL_RED_STEPS
    assert all_red[0] == 1
    assert all_red[-1] == ALL_RED_STEPS
    # The interrupted phase resumes ...
    assert bits[ALL_RED_STEPS] == (True, False)
    # ... and the swap happens 30 steps later than it would have: the phase
    # clock was frozen during the clearance. The first change is the resume
    # itself, the second is the axis swap.
    assert _flips(bits) == [ALL_RED_STEPS + 1, 300 + ALL_RED_STEPS]


def test_force_all_red_behaves_like_preempt() -> None:
    """The two all-red actions are the same action under two names."""
    assert _run("force_all_red") == _run("preempt")


def test_no_op_changes_nothing() -> None:
    """`no_op` is inert."""
    assert _run("no_op") == _run()


def test_the_all_red_records_the_phase_to_resume() -> None:
    """The light-level view of the clearance."""
    light = TrafficLight()
    light.apply_action("preempt")
    light.consume_actions()
    assert light.ns_green is False
    assert light.ew_green is False
    assert light.all_red_steps == ALL_RED_STEPS
    assert light.resume_state == (True, False)


def test_the_all_red_clearance_is_three_seconds() -> None:
    """The constant the contract compares against the TypeScript side."""
    assert ALL_RED_SECS == 3.0
    assert ALL_RED_STEPS == 30


def test_a_preempt_right_after_a_clearance_does_not_kill_the_light() -> None:
    """The resume point must survive a preempt that lands on the boundary.

    Regression (Plan 073 Sprint 2 fix wave). The clearance that ended with
    the previous step leaves the light **all-red** until the resume happens
    inside the next step. A preempt applied on that step used to overwrite
    the resume point with the all-red state, and the light then never went
    green again — a permanent failure of one axis of the intersection.

    Timeline (1-based steps): preempt on step 1 → all-red for steps 1..30
    (the phase resumes inside step 31) → a second preempt on step 31 →
    all-red for steps 31..60 → the phase resumes inside step 61.

    The phase clock is frozen for both clearances, so the axis swap lands
    60 steps later than the default step 300.
    """
    bits = _run(at_steps={1: "preempt", ALL_RED_STEPS + 1: "preempt"})

    # The first clearance.
    assert bits[0] == (False, False)
    assert bits[ALL_RED_STEPS - 1] == (False, False)  # step 30

    # The second clearance starts on the very step the phase resumed: the
    # preempt is consumed in that same step, so the light is all-red again.
    assert bits[ALL_RED_STEPS] == (False, False)  # step 31
    assert bits[2 * ALL_RED_STEPS - 1] == (False, False)  # step 60

    # ... and the phase must come back.
    assert bits[2 * ALL_RED_STEPS] == (True, False), (
        "the light never went green again: the preempt on the boundary step "
        "overwrote the resume point with the all-red state"
    )

    # The phase clock was frozen for both clearances → the swap is 60 steps
    # later than it would have been.
    assert _flips(bits) == [2 * ALL_RED_STEPS + 1, 300 + 2 * ALL_RED_STEPS]


def test_a_preempt_during_a_clearance_keeps_the_original_resume_point() -> None:
    """A second preempt *inside* a clearance extends it, it does not reset it.

    This is the case that already worked before the fix wave — it is pinned
    so the boundary fix does not regress it. The clearance runs from step 1
    to step 20, is extended by 30 more steps, and the phase resumes inside
    step 51 (i.e. it is green from step 50 on).
    """
    bits = _run(at_steps={1: "preempt", 20: "preempt"})
    assert bits[48] == (False, False)  # step 49 — still clearing
    assert bits[49] == (True, False)  # step 50 — the phase resumes


def test_the_resume_point_is_never_an_all_red_state() -> None:
    """Invariant: a queued preempt never records an all-red resume point.

    The resume point is only ever the state of a light that actually had a
    green axis. This is the second half of the boundary fix — the first
    half restores the phase *before* the actions are consumed.
    """
    light = TrafficLight(ns_green=True, ew_green=False)
    light.apply_action("preempt")
    light.consume_actions()
    assert light.resume_state == (True, False)

    # A light that is already all-red and not clearing must not record a
    # resume point of (False, False) — that is the state that wedged it.
    wedged = TrafficLight(ns_green=False, ew_green=False)
    wedged.apply_action("preempt")
    wedged.consume_actions()
    assert wedged.resume_state is None


def test_extend_green_is_capped_at_max_green_seconds() -> None:
    """The green cannot grow without bound.

    A cap is required before a policy can be trained against this action
    space: an uncapped `extend_green` lets an agent hold one axis green
    forever, which starves the cross traffic and makes the training
    degenerate. The cap is the browser's existing `MAX_GREEN_SECS`
    convention (60 s), and it is part of the cross-language contract.
    """
    light = TrafficLight(cycle_timer=0.0)
    for _ in range(40):  # 40 × 5 s = 200 s without a cap
        light.apply_action("extend_green")
        light.consume_actions()
    # cycle_duration (30) - MAX_GREEN_SECS (60) = -30 is the floor.
    assert light.cycle_timer == -30.0
    # The green therefore lasts at most 60 s.
    assert light.cycle_duration - light.cycle_timer == 60.0


def test_extend_green_below_the_cap_is_unchanged() -> None:
    """The cap does not interfere with a single, ordinary extension."""
    light = TrafficLight(cycle_timer=10.0)
    light.apply_action("extend_green")
    light.consume_actions()
    assert light.cycle_timer == 10.0 - PHASE_ADJUST_SECS

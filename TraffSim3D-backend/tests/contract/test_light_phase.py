"""The traffic-light phase flip, pinned on the Python side.

Every committed golden carries the **initial** phase only (`nsGreen: true`
everywhere; the roundabout's light is both-green, so its swap is a no-op).
The shipped contract therefore proves that the two sides agree on a
*constant* phase — it never exercises the flip **boundary**. The
flip-parity evidence came only from mutation runs, where one side was moved
at a time; if both sides were changed to 20 s simultaneously, the contract
would compare flip-at-200 against flip-at-200 and never assert the parity.

The TypeScript side already pins the boundary in
`src/application/services/simCoreMirror.spec.ts` ("makes the phase
observable — the samples follow the light cycle"). This module is the
Python counterpart, so a committed artefact asserts the flip step on
**both** sides.

It also pins the **sampled window** — the bound that decides whether a
phase-duration drift is observable at all (see
`docs/contracts/sim-snapshot.md`, "The traffic-light phase duration").
"""

from __future__ import annotations

import numpy as np

from app.apps.rl.sim_core import SimCore

# The sample stride the contract uses (`test_vector.json` → `sample_every`).
_SAMPLE_EVERY = 10

# The longest *signalled* episode: a parked ego in the `t_junction` scene,
# hit by the northbound NPC. Same vector as `t_junction_lights`.
_SCENE_KIND = "t_junction"
_MAX_STEPS = 400


def _run_t_junction(cycle_duration: float) -> dict:
    """Run the `t_junction_lights` episode with a given phase duration.

    Returns the sampled steps, the sampled `ns_green` bits, the terminating
    step and the termination reason.
    """
    core = SimCore(scene_kind=_SCENE_KIND, max_steps=_MAX_STEPS)
    core.reset()
    # `reset()` re-creates the light with the default cycle duration, so the
    # override has to happen *after* the reset.
    core.light.cycle_duration = cycle_duration

    steps: list[int] = [0]
    ns_green: list[bool] = [bool(core.light.ns_green)]
    for i in range(1, _MAX_STEPS + 1):
        core.step(np.zeros(2, dtype=np.float32))
        if i % _SAMPLE_EVERY == 0 or i == _MAX_STEPS:
            steps.append(i)
            ns_green.append(bool(core.light.ns_green))
        if core._terminated or core._truncated:
            break
    return {
        "steps": steps,
        "ns_green": ns_green,
        "final_step": core.step_count,
        "reason": core._terminated_reason,
    }


def test_python_light_flips_at_step_11_with_a_one_second_cycle() -> None:
    """The Python flip step matches the TS mirror's (step 11).

    A 1 s cycle flips the phase every 10 steps at 10 Hz. The flip lands on
    step **11**, not 10: the accumulated timer is `0.9999999999999999` after
    ten `+= 0.1` additions, so it only reaches 1.0 on the eleventh step —
    and the next flip likewise on step 22. The TypeScript mirror
    (`simCoreMirror.spec.ts`) pins the very same boundary, so the two sides
    are pinned by committed artefacts, not only by the mutation runs that
    first exposed it.
    """
    core = SimCore(scene_kind="cross", max_steps=40)
    core.reset()
    core.light.cycle_duration = 1.0

    ns_green_per_step: list[bool] = []
    for _ in range(25):
        core.step(np.zeros(2, dtype=np.float32))
        ns_green_per_step.append(bool(core.light.ns_green))

    assert ns_green_per_step[:10] == [True] * 10, "steps 1-10 must still be NS-green"
    assert ns_green_per_step[10:21] == [False] * 11, "the flip must land on step 11"
    assert ns_green_per_step[21:] == [True] * 4, "the second flip must land on step 22"


def test_the_sampled_window_ends_at_250_although_the_episode_runs_to_257() -> None:
    """The observable window is 0…250 — the terminating step 257 is not sampled.

    This is the fact the coverage bound rests on: `sample_every` is 10, and
    257 is neither a multiple of 10 nor the last action index, so the last
    sample the contract actually compares is step **250**.
    """
    run = _run_t_junction(cycle_duration=30.0)
    assert run["final_step"] == 257
    assert run["reason"] == "collision"
    assert run["steps"] == list(range(0, 251, 10))
    assert run["steps"][-1] == 250


def test_a_flip_past_the_last_sample_is_invisible_but_one_at_it_is_not() -> None:
    """The measured `≤ 25.0 s` bound, asserted rather than asserted-about.

    The shipped 30 s phase flips at step 300, past the end of the episode.
    A 25.5 s phase flips at step 255 — between the last sample (250) and
    the collision (257) — so it changes **no sample** and is invisible to
    every gate. A 25.0 s phase flips exactly at step 250, which *is* a
    sample point, so it is caught.
    """
    baseline = _run_t_junction(cycle_duration=30.0)
    late_flip = _run_t_junction(cycle_duration=25.5)
    sampled_flip = _run_t_junction(cycle_duration=25.0)

    # The flip at 255 changes the light, but not any sampled sample.
    assert (
        late_flip["ns_green"] == baseline["ns_green"]
    ), "a flip at step 255 must be invisible: it lands past the last sample (250)"
    # The flip at 250 lands on a sample point, so it is caught.
    assert (
        sampled_flip["ns_green"] != baseline["ns_green"]
    ), "a flip at step 250 must be observable: it lands on the last sample"
    assert sampled_flip["ns_green"][-1] is False
    assert baseline["ns_green"][-1] is True

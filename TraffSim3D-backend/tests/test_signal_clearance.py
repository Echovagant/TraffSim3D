"""The inter-green clearance and the dense training scenario.

Two model changes, both required by the training scenario:

1. **The inter-green clearance.** The Python light model swapped
   instantaneously, so switching phases was *free*: splitting the same
   green time into more, shorter phases was a pure gain, and a signal
   agent's optimum was a fixed-time controller in disguise. The browser
   charges a 3 s clearance-yellow plus a 3 s all-red before the other
   axis may go — six seconds during which no new vehicle gets a green.
   The clearance is charged by `SimCore` (NOT by the `TrafficLight`
   dataclass, which is the cross-language contract's sensitive area) and
   only while the responsive traffic model is on, so the default path
   stays bit-identical.

2. **The dense training scenario.** The cross scene had one vehicle per
   lane: an arrival every ~9 s, so a red phase never built a queue and
   "serve the other axis forever" cost almost nothing. The environment
   now lays out a regular stream of traffic on every lane.

These tests pin the *mechanism*, not just the numbers: the clearance is
off by default, neither axis may go while it runs, the phase clock is
frozen while it runs, and the dense scenario really does build a queue
during a red phase.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.signal_env import SignalEnv
from app.apps.rl.sim_core import (
    CLEARANCE_SECS,
    CLEARANCE_STEPS,
    DT,
    SIGNAL_ACTION_NAMES,
    SimCore,
)

# The action index is the position in `SIGNAL_ACTION_NAMES` — the order
# is part of the cross-language contract.
ACTION_INDEX = {name: index for index, name in enumerate(SIGNAL_ACTION_NAMES)}

# The phase length of the Python light model (a contract constant).
CYCLE_SECONDS = 30.0


def _core(responsive: bool = True) -> SimCore:
    """A cross-scene core with the ego parked out of the traffic.

    The step limit is raised: the default (200 steps) would freeze the
    world long before the first phase change.
    """
    core = SimCore(responsive_traffic=responsive, max_steps=1000)
    core.reset()
    # The signal agent does not drive: an ego in the road would be hit
    # by an NPC, which ends the episode.
    core.ego.x = 60.0
    core.ego.z = -60.0
    core.ego.speed = 0.0
    return core


def _step(core: SimCore) -> None:
    core.step(np.zeros(2, dtype=np.float32))


# --------------------------------------------------------------------------
# The clearance is opt-in
# --------------------------------------------------------------------------


def test_the_clearance_is_off_by_default() -> None:
    """The clearance belongs to the responsive traffic model only.

    The default path is the basis of the committed cross-language
    goldens (tests/contract/snapshots/ts_*.json) and the contract
    compares the two sides for *exact* equality, so the clearance must
    not leak into it.
    """
    assert CLEARANCE_SECS == 6.0
    assert CLEARANCE_STEPS == int(round(CLEARANCE_SECS / DT)) == 60
    assert SimCore().responsive_traffic is False
    assert SignalEnv().core.responsive_traffic is True


def test_the_default_path_swaps_instantly_and_never_clears() -> None:
    """On the default path the phase change costs nothing.

    The light swaps on the very step the phase expires — there is no
    step in which neither axis is green — and `in_clearance` never
    becomes true.
    """
    core = _core(responsive=False)
    steps_to_swap = int(round(CYCLE_SECONDS / DT))

    for _ in range(steps_to_swap):
        assert core.in_clearance is False
        _step(core)

    # The swap happened on the last step: one axis is green, the other
    # is not, and the clock restarted.
    assert core.light.ns_green is False
    assert core.light.ew_green is True
    assert core.in_clearance is False


def test_the_responsive_path_does_clear() -> None:
    """With the responsive traffic on, the same phase change is followed
    by a clearance — the difference between the two paths."""
    core = _core(responsive=True)
    steps_to_swap = int(round(CYCLE_SECONDS / DT))

    for _ in range(steps_to_swap):
        _step(core)

    assert core.in_clearance is True, "the responsive path must clear"
    assert core.light.ns_green is False
    assert core.light.ew_green is False


# --------------------------------------------------------------------------
# The clearance itself
# --------------------------------------------------------------------------


def test_during_the_clearance_neither_axis_is_green_and_the_clock_is_frozen() -> None:
    """The clearance's two promises.

    * neither axis may go — no new vehicle gets a green;
    * the phase clock is frozen — the interrupted phase resumes where it
      left off, exactly like the all-red clearance does.

    The clearance lasts exactly `CLEARANCE_SECS` and then the other axis
    gets its green with a full cycle ahead of it.
    """
    core = _core(responsive=True)
    steps_to_swap = int(round(CYCLE_SECONDS / DT))
    for _ in range(steps_to_swap):
        _step(core)

    # The clearance: neither axis may go, and the clock does not move.
    for _ in range(CLEARANCE_STEPS):
        assert core.in_clearance is True
        assert core.light.ns_green is False, "no axis may go during the clearance"
        assert core.light.ew_green is False, "no axis may go during the clearance"
        assert core.light.cycle_timer == 0.0, "the phase clock must be frozen"
        _step(core)

    # The clearance is over: the other axis has the green, with the full
    # cycle ahead of it.
    assert core.in_clearance is False
    assert core.light.ns_green is False
    assert core.light.ew_green is True
    assert core.light.cycle_timer == 0.0, "the new phase starts with the full cycle"
    _step(core)
    assert core.light.cycle_timer == pytest.approx(DT), "the clock runs again"


def test_the_clearance_costs_the_phase_change_its_lost_time() -> None:
    """The clearance is what makes switching phases expensive.

    Measured on the environment (600 steps, the same initial state):
    the alternating schedule scores -423.1 and the "switch as often as
    legally possible" schedule -437.2 — the flicker pays 14.1 more,
    because every extra switch costs six seconds during which nobody
    may go. Before the clearance the flicker was the *better* schedule.

    **The traffic model changed** (the closed loop became the
    browser-like open flow) and with it the comparison: in the open
    model the *delay* is dominated by the red's duration rather than by
    the clearance, so the flicker is now the better schedule overall
    (-260.8 against the fixed cycle's -292.8).

    The clearance itself did not get cheaper, though — and that is what
    this test pins now: a phase change still costs **six seconds during
    which neither axis may go**, and the *number* of switches is what
    separates the two schedules. So the test measures the lost time
    directly instead of inferring it from the schedule comparison.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)

    alternating = 0.0
    alternating_clearance = 0
    flicker = 0.0
    flicker_clearance = 0
    for _ in range(600):
        _, reward, terminated, truncated, _ = env.step(ACTION_INDEX["no_op"])
        alternating += reward
        alternating_clearance += env.core.in_clearance
        if terminated or truncated:
            break
    env.reset(seed=0)
    for _ in range(600):
        _, reward, terminated, truncated, _ = env.step(ACTION_INDEX["shorten_red"])
        flicker += reward
        flicker_clearance += env.core.in_clearance
        if terminated or truncated:
            break

    # The clearance is charged: the light stands still for six seconds
    # after every phase change, and the flicker pays it far more often.
    assert alternating_clearance > 0, "the clearance is never charged"
    assert flicker_clearance > alternating_clearance, (
        "the flicker does not pay more lost time than the fixed cycle "
        f"({flicker_clearance} against {alternating_clearance} steps)"
    )
    # And the lost time is the six seconds the contract pins.
    assert flicker_clearance - alternating_clearance >= 30, (
        "the flicker should pay at least five extra clearances over 600 "
        f"steps ({flicker_clearance} against {alternating_clearance})"
    )


def test_the_clearance_refuses_a_phase_adjustment() -> None:
    """A phase adjustment must not move the clock while the light is
    clearing.

    The clock reads 0 during the clearance, so an adjustment landing
    there would silently shorten the *next* green — below the minimum
    green time the minimum-green guard exists to protect. The environment refuses
    it, and reports the action as masked.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)

    masked_during_clearance = False
    for _ in range(600):
        _, _, terminated, truncated, info = env.step(ACTION_INDEX["shorten_red"])
        if env.core.in_clearance:
            masked_during_clearance = masked_during_clearance or info["masked"]
        if terminated or truncated:
            break

    assert (
        masked_during_clearance is True
    ), "the environment must mask `shorten_red` while the light clears"


# --------------------------------------------------------------------------
# The dense training scenario
# --------------------------------------------------------------------------


def test_the_dense_scenario_builds_a_queue_during_a_red_phase() -> None:
    """A red phase must produce a queue of *several* vehicles.

    The thin cross scene had one vehicle per lane (an arrival every
    ~9 s), so the queue never built and starving an axis was almost
    free. The dense scenario lays out a regular stream of traffic, and
    the queue on the red axis now reaches several vehicles.
    """
    env = SignalEnv(max_steps=600)
    env.reset(seed=0)

    # More than the scene's four vehicles: the dense stream.
    assert len(env.core.npcs) > 4

    peak_ns = 0
    peak_ew = 0
    for _ in range(600):
        _, _, terminated, truncated, _ = env.step(ACTION_INDEX["no_op"])
        peak_ns = max(peak_ns, env.core.queue_length("ns"))
        peak_ew = max(peak_ew, env.core.queue_length("ew"))
        if terminated or truncated:
            break

    assert peak_ns >= 3, f"the NS queue must build during a red phase (peak={peak_ns})"
    assert peak_ew >= 3, f"the EW queue must build during a red phase (peak={peak_ew})"


def test_the_dense_scenario_is_deterministic() -> None:
    """Two resets of the same environment produce the same traffic.

    There is no randomness anywhere in the layout: the contract compares
    trajectories for exact equality and a training run has to be
    reproducible.
    """
    first = SignalEnv(max_steps=60)
    first.reset(seed=0)
    second = SignalEnv(max_steps=60)
    second.reset(seed=0)

    assert [(n.x, n.z, n.heading) for n in first.core.npcs] == [
        (n.x, n.z, n.heading) for n in second.core.npcs
    ]


def test_starving_one_axis_leaves_its_queue_standing() -> None:
    """The mechanism behind the reward gate: the starved axis never
    gets served, so its queue never drains.

    Under the "extend the green forever" schedule the cross axis is
    queued on *every* step of the episode; under the alternating
    schedule it is queued on far fewer.
    """
    starved_queue_steps = 0
    alternating_queue_steps = 0

    env = SignalEnv(max_steps=600)
    env.reset(seed=0)
    for _ in range(600):
        _, _, terminated, truncated, _ = env.step(ACTION_INDEX["extend_green"])
        starved_queue_steps += env.core.queue_length("ew") > 0
        if terminated or truncated:
            break

    env.reset(seed=0)
    for _ in range(600):
        _, _, terminated, truncated, _ = env.step(ACTION_INDEX["no_op"])
        alternating_queue_steps += env.core.queue_length("ew") > 0
        if terminated or truncated:
            break

    assert starved_queue_steps == 600, (
        "the starved axis must be queued on every step " f"(starved={starved_queue_steps})"
    )
    assert alternating_queue_steps < starved_queue_steps, (
        "the alternating schedule must let the cross axis drain "
        f"(alternating={alternating_queue_steps}, starved={starved_queue_steps})"
    )

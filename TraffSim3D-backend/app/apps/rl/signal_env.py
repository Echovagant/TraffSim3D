"""Plan 074 Sprint 3 (S3a-2): the environment a signal agent can learn in.

The agent controls the **traffic light**, not a vehicle. The traffic
itself is the thing being controlled: with `responsive_traffic` on
(Plan 074 S3a-1) the NPCs brake at the stop line on a red, queue up
behind each other and are released by the green — so the agent's action
has a *causal* effect on the traffic it is scored on.

Observation — Plan 074 §2 D1, six dimensions, and the order is part of
the cross-language contract:

===== ===================================================================
idx   meaning                        normalisation
===== ===================================================================
0     NS axis queue length           ``min(q / MAX_QUEUE, 1)``
1     EW axis queue length           ``min(q / MAX_QUEUE, 1)``
2     NS axis has right of way       0 / 1 (``light.ns_green``)
3     EW axis has right of way       0 / 1 (``light.ew_green``)
4     all-red (neither axis green)   0 / 1
5     phase clock                    ``cycle_timer / cycle_duration``
===== ===================================================================

Index 5 is the *elapsed* fraction of the current phase on the Python
side; the browser's counterpart is the *remaining* fraction. The two are
complements of each other — the plan deliberately compares the schema,
not the numbers (the two traffic models are not the same model).

Reward — Plan 074 §2 D2, the **total delay**: the negative area under the
per-axis queue-length curve, i.e. ``-(q_ns + q_ew) * dt`` per step. Both
axes are priced, which is what makes the reward a mitigation for the
"hold one axis green forever" risk: ``MAX_GREEN_SECS`` bounds the
green's *remaining* time, not its wall-clock duration, so a policy that
extends on every step would starve the cross traffic — and the
cross traffic's waiting is in the reward.

Minimum green time — Plan 074 T7 (§2 D5). A controller that shortens the
phase on every decision would *flicker* the light: 0.6 s per phase,
which no driver can react to and which — because the vehicles never come
to a full stop — was scored as "no delay at all" and therefore looked
optimal inside the model. The fix is a lower bound on the green phase's
remaining time, ``MIN_GREEN_SECS``. It is enforced **here**, in the
environment (the action is masked and the light is not touched), and NOT
in the physical light model (``sim_core``) — that model is the
cross-language contract's sensitive area and its default behaviour must
stay bit-identical. The browser's ``RLController`` enforces the same
bound on its side.
"""

from __future__ import annotations

import math
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .signal_conditions import (
    DENSE_EW_VEHICLES_PER_LANE,
    DENSE_NS_VEHICLES_PER_LANE,
    DENSE_STREAM_SPACING,
    DENSE_STREAM_START,
    EVAL_CONDITION,
    HOLDOUT_CONDITION,
    TRAIN_CONDITION,
    TrafficCondition,
)
from .sim_core import (
    DT,
    MAX_STEPS_DEFAULT,
    MIN_GREEN_SECS,
    NPC_SPEED,
    PHASE_ADJUST_SECS,
    SIGNAL_ACTION_NAMES,
    STOP_LINE_DISTANCE,
    SimCore,
    Vehicle,
    approach_axis,
)

__all__ = [
    "DENSE_EW_VEHICLES_PER_LANE",
    "DENSE_NS_VEHICLES_PER_LANE",
    "DENSE_STREAM_SPACING",
    "DENSE_STREAM_START",
    "EVAL_CONDITION",
    "HOLDOUT_CONDITION",
    "MAX_QUEUE",
    "SIG_OBS_DIM",
    "TRAIN_CONDITION",
    "SignalEnv",
    "TrafficCondition",
]

# The observation dimensionality (Plan 074 §2 D1).
SIG_OBS_DIM = 6

# The queue length that saturates the normalised observation (idx 0 / 1).
# The browser side must use the same value for the two observations to
# be comparable at all.
MAX_QUEUE = 10

# ===== Plan 074 T9/T10: the dense training scenario =====
#
# The scenario itself (the demand, the headway and the lane layout) lives
# in `signal_conditions.py` - it is the *training condition* of the
# signal agent, and the evaluation condition has to be defined next to
# it (Plan 074 T10). The constants are re-exported here so that the
# scenario keeps one obvious home for the code that builds it.
#
# The scene itself (`SimCore._reset_cross`) is NOT touched: the contract
# vectors run on it, and their goldens must not move.

# The four approaches of the cross scene: (axis, direction of travel) ->
# (the unit vector across the road, the unit vector along it, heading).
#
# The lateral offset itself comes from the scene's own vehicles, so the
# dense scenario follows the scene if the scene ever moves a lane.
_LANES: dict[tuple[str, int], tuple[tuple[float, float], tuple[float, float], float]] = {
    ("ns", 1): ((1.0, 0.0), (0.0, 1.0), math.pi / 2),
    ("ns", -1): ((1.0, 0.0), (0.0, -1.0), -math.pi / 2),
    ("ew", 1): ((0.0, 1.0), (1.0, 0.0), 0.0),
    ("ew", -1): ((0.0, 1.0), (-1.0, 0.0), math.pi),
}


def _lane_of(vehicle: Vehicle) -> tuple[str, int]:
    """The (axis, direction of travel) a vehicle runs in.

    The same rule the traffic model uses to tell the lanes apart: a
    heading within 45° of ±Z is the north-south road, one within 45° of
    ±X the east-west road; the sign is the direction of travel.
    """
    axis = approach_axis(vehicle.heading)
    if axis == "ns":
        direction = 1 if math.sin(vehicle.heading) >= 0 else -1
    else:
        direction = 1 if math.cos(vehicle.heading) >= 0 else -1
    return axis, direction


def _lateral_offset(vehicle: Vehicle, axis: str) -> float:
    """How far the vehicle sits off its road's centre line."""
    return vehicle.x if axis == "ns" else vehicle.z


def _lane_point(
    axis: str, lateral: float, along: tuple[float, float], distance: float
) -> tuple[float, float]:
    """A point on a lane.

    `lateral` metres off the road's centre line, `distance` metres
    along the lane measured from the stop line (negative = upstream,
    further back and waiting).
    """
    x = lateral if axis == "ns" else 0.0
    z = lateral if axis == "ew" else 0.0
    # The stop line sits `STOP_LINE_DISTANCE` before the intersection
    # centre, measured along the lane.
    x += along[0] * (distance - STOP_LINE_DISTANCE)
    z += along[1] * (distance - STOP_LINE_DISTANCE)
    return x, z


class SignalEnv(gym.Env[np.ndarray, int]):
    """Gymnasium env for the traffic-signal agent.

    * action: ``Discrete(5)`` — the index is the position in
      ``sim_core.SIGNAL_ACTION_NAMES``, i.e.
      ``0=extend_green, 1=shorten_red, 2=preempt, 3=force_all_red,
      4=no_op``. The order is a cross-language contract.
    * observation: the six dimensions documented above.
    * reward: the negative total delay (both axes).

    The ego vehicle is parked out of the traffic: the signal agent does
    not drive, and an ego sitting in the road would either be hit by an
    NPC or run a red light — both of which end the episode and would
    drown the signal's own learning signal.
    """

    metadata = {"render_modes": []}

    observation_space = spaces.Box(low=-1.0, high=1.0, shape=(SIG_OBS_DIM,), dtype=np.float32)
    action_space = spaces.Discrete(len(SIGNAL_ACTION_NAMES))

    def __init__(
        self,
        max_steps: int = MAX_STEPS_DEFAULT,
        scene_kind: str = "cross",
        condition: TrafficCondition = TRAIN_CONDITION,
    ) -> None:
        super().__init__()
        # `responsive_traffic=True` — without it the NPCs would ignore
        # the light and the reward would not depend on the action.
        self.core = SimCore(
            max_steps=max_steps,
            scene_kind=scene_kind,
            responsive_traffic=True,
        )
        # Plan 074 T10: the initial condition of the scene. The default is
        # the training condition, so the training episodes are exactly the
        # ones Plan 074 T9 measured (-423.1 for the fixed 30/30 cycle).
        self.condition = condition
        # The ego is a passenger here: no throttle, no steering.
        self._ego_action = np.zeros(2, dtype=np.float32)
        self._total_delay = 0.0

    # -- Gymnasium API ------------------------------------------------

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self.core.reset(seed=seed)
        # Plan 074 T10: the condition's signal offset. `SimCore.reset`
        # recreates the light, so the phase clock starts at 0 — the
        # condition puts it where the condition says.
        self.core.light.cycle_timer = self.condition.phase_offset
        self._park_ego()
        self._densify_traffic()
        self._total_delay = 0.0
        return self._obs(), {}

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        index = int(action)
        if not 0 <= index < len(SIGNAL_ACTION_NAMES):
            raise ValueError(
                f"signal action index {index} out of range; expected 0..{len(SIGNAL_ACTION_NAMES) - 1}"
            )
        name = SIGNAL_ACTION_NAMES[index]
        # Plan 074 T7 (§2 D5): the minimum green time. `shorten_red`
        # advances the swap, which takes `PHASE_ADJUST_SECS` off the
        # *current green's* remaining time — so applying it when the green
        # has less than `MIN_GREEN_SECS + PHASE_ADJUST_SECS` left would
        # push the green below the minimum. The action is then **masked**:
        # the light is not touched at all.
        masked = name == "shorten_red" and not self._may_shorten_red()
        if not masked:
            # The action is queued and consumed by this step's light update
            # (Plan 074 D3: applied *before* the step, consumed *in* it).
            self.core.light.apply_action(name)

        _, _, terminated, truncated, core_info = self.core.step(self._ego_action)

        queue_ns = self.core.queue_length("ns")
        queue_ew = self.core.queue_length("ew")
        # The delay accrued during this step: the area under the queue
        # curve. Both axes are priced — see the module docstring.
        delay = (queue_ns + queue_ew) * DT
        self._total_delay += delay
        reward = -delay

        info: dict[str, Any] = {
            "action": name,
            "masked": masked,
            "queue_ns": queue_ns,
            "queue_ew": queue_ew,
            "delay": delay,
            "total_delay": self._total_delay,
            "waiting_ns": self.core.waiting_time("ns"),
            "waiting_ew": self.core.waiting_time("ew"),
            "reason": core_info.get("reason", ""),
        }
        return self._obs(), float(reward), bool(terminated), bool(truncated), info

    def render(self) -> None:  # pragma: no cover
        pass

    # -- internals ----------------------------------------------------

    def _may_shorten_red(self) -> bool:
        """May a `shorten_red` action be applied right now?

        Plan 074 T7 (§2 D5): the minimum green time.

        The Python light model has a single phase clock, and `shorten_red`
        advances the swap by `PHASE_ADJUST_SECS` — so it takes exactly that
        much off the *current green's* remaining time, which is
        `cycle_duration - cycle_timer` (the clock advances one second per
        second of wall clock, so that value is the green's remaining
        seconds). Applying the action when the result would be below
        `MIN_GREEN_SECS` is refused: the action is masked and the light is
        not touched.

        The rule is the same one the browser's `RLController` applies to
        its green phase, and the constant is the same number on both
        sides (a cross-language contract constant).
        """
        if self.core.in_clearance:
            # Plan 074 T9: the light is in its inter-green clearance. The
            # phase clock is frozen there, so an adjustment would not
            # shorten the red - it would shorten the *next* green, below
            # the minimum green time. Refused.
            return False
        light = self.core.light
        remaining = light.cycle_duration - light.cycle_timer
        return remaining - PHASE_ADJUST_SECS >= MIN_GREEN_SECS

    def _park_ego(self) -> None:
        """Move the ego out of the traffic.

        It is parked beyond the respawn radius (|z| > 40), so no NPC can
        ever reach it, and it is far outside the intersection, so the
        ego's own red-light rule cannot fire either.
        """
        self.core.ego.x = 0.0
        self.core.ego.z = -45.0
        self.core.ego.speed = 0.0

    def _densify_traffic(self) -> None:
        """Lay out the dense scenario's traffic (Plan 074 T9).

        Every lane of the scene carries a regular *stream* of vehicles
        along its circulation path, spaced `DENSE_STREAM_SPACING` metres
        apart and starting at the respawn point. A red phase therefore
        builds a queue of SEVERAL vehicles instead of one or two, which
        is what gives the signal agent a real trade-off: serving one
        axis too long now costs the other axis a real queue.

        The lanes themselves (axis, direction of travel, lateral offset
        and heading) come from the scene's own vehicles, so the dense
        scenario follows the scene if the scene ever moves a lane; only
        the *positions* are the scenario's own. The scene itself
        (`SimCore._reset_cross`) is untouched - the contract vectors run
        on it and their goldens must not move.

        The placement is fully deterministic: no randomness anywhere.
        The numbers come from the env's **condition** (Plan 074 T10):
        the training condition reproduces the constants above, another
        condition lays the same kind of traffic out differently.
        """
        core = self.core
        stream: list[Vehicle] = []
        for npc in core.npcs:
            axis, direction = _lane_of(npc)
            lane = _LANES.get((axis, direction))
            if lane is None:
                continue
            _, along, heading = lane
            lateral = _lateral_offset(npc, axis)
            condition = self.condition
            count = (
                condition.ew_vehicles_per_lane if axis == "ew" else condition.ns_vehicles_per_lane
            )
            for index in range(count):
                distance = condition.stream_start + condition.stream_spacing * index
                x, z = _lane_point(axis, lateral, along, distance)
                stream.append(Vehicle(x=x, z=z, heading=heading, speed=NPC_SPEED))
        core.npcs = stream

    def _obs(self) -> np.ndarray:
        """The six-dimensional signal observation (Plan 074 §2 D1)."""
        light = self.core.light
        obs = np.zeros(SIG_OBS_DIM, dtype=np.float32)
        obs[0] = min(self.core.queue_length("ns") / MAX_QUEUE, 1.0)
        obs[1] = min(self.core.queue_length("ew") / MAX_QUEUE, 1.0)
        obs[2] = 1.0 if light.ns_green else 0.0
        obs[3] = 1.0 if light.ew_green else 0.0
        obs[4] = 1.0 if (not light.ns_green and not light.ew_green) else 0.0
        # The elapsed fraction of the phase. `extend_green` may push the
        # clock below zero (the green runs longer than the cycle), so the
        # value can be negative — hence the observation box is [-1, 1].
        obs[5] = light.cycle_timer / light.cycle_duration
        return obs

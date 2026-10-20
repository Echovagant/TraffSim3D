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
"""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .sim_core import DT, MAX_STEPS_DEFAULT, SIGNAL_ACTION_NAMES, SimCore

# The observation dimensionality (Plan 074 §2 D1).
SIG_OBS_DIM = 6

# The queue length that saturates the normalised observation (idx 0 / 1).
# The browser side must use the same value for the two observations to
# be comparable at all.
MAX_QUEUE = 10


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
    ) -> None:
        super().__init__()
        # `responsive_traffic=True` — without it the NPCs would ignore
        # the light and the reward would not depend on the action.
        self.core = SimCore(
            max_steps=max_steps,
            scene_kind=scene_kind,
            responsive_traffic=True,
        )
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
        self._park_ego()
        self._total_delay = 0.0
        return self._obs(), {}

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        index = int(action)
        if not 0 <= index < len(SIGNAL_ACTION_NAMES):
            raise ValueError(
                f"signal action index {index} out of range; expected 0..{len(SIGNAL_ACTION_NAMES) - 1}"
            )
        name = SIGNAL_ACTION_NAMES[index]
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

    def _park_ego(self) -> None:
        """Move the ego out of the traffic.

        It is parked beyond the respawn radius (|z| > 40), so no NPC can
        ever reach it, and it is far outside the intersection, so the
        ego's own red-light rule cannot fire either.
        """
        self.core.ego.x = 0.0
        self.core.ego.z = -45.0
        self.core.ego.speed = 0.0

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

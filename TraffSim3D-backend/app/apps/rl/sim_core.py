"""Plan 044: minimal Python sim core (mirror of TS tick.ts).

A research-quality reimplementation of the 4-way intersection scene
from frontend Plan 005/035. NOT a full port — only the subset needed
for PPO to learn. The frontend TS sim is authoritative for visual
quality; this Python sim is authoritative for training.

Layout (matches Plan 035 cross scene):
- NS road: x=0, z ∈ [-30, 30], heading north = +Z (heading=π/2 in
  heading-from-+X convention)
- EW road: z=0, x ∈ [-30, 30], heading east = +X (heading=0)
- Intersection: |x|<8 AND |z|<8
- NS traffic light: green when ego on NS road
- EW traffic light: green when ego on EW road

Ego starts south of intersection at (0, -25), heading north (π/2).
Four NPCs travel at constant speed on their respective lanes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

# Geometry constants (match frontend @shared/constants/simulation where applicable)
NS_HALF = 30.0          # NS road extends 60u total (-30 .. +30)
EW_HALF = 30.0          # EW road same
INTERSECTION_RADIUS = 8.0
ROUNDABOUT_RADIUS = 10.0  # roundabout circle radius [m]
SPEED_LIMIT = 16.67     # m/s (60 km/h)
NPC_SPEED = 8.0         # m/s (29 km/h, slower than speed limit)
EGO_WHEELBASE = 2.5     # m (approximate car wheelbase)
COLLISION_DISTANCE = 2.0  # m — closer than this = collision
MAX_STEPS_DEFAULT = 200
OBS_DIM = 14

# Pure Pursuit (Coulter 1992) — see ADR-004
LOOKAHEAD_DISTANCE = 8.0
MAX_STEER = 0.4         # rad
DT = 0.1                # seconds per sim step (matches frontend 10Hz)

# ===== Plan 073 Sprint 2 (A2a): the shared signal-action vocabulary =====
#
# The five action names are the externally-actionable control surface of
# the traffic signal (plans/legacy/007-m2-signal-controller.md §2). The
# frontend's `RLController` consumes the same names, so a policy trained
# here can drive the browser's signal.
#
# Each side owns ITS OWN copy of this list on purpose: a file both sides
# read would make the cross-language assertion vacuous. The contract
# compares the two copies item by item
# (tests/contract/test_cross_lang_consistency.py) — if they ever disagree,
# the contract goes red.
#
# The ORDER matters: the contract compares the lists positionally.

SIGNAL_ACTION_NAMES = (
    "extend_green",
    "shorten_red",
    "preempt",
    "force_all_red",
    "no_op",
)

# All-red clearance (s) applied by `preempt` / `force_all_red`.
# Mirrors `ALL_RED_SECS` in TraffSim3D-frontend/src/shared/constants/simulation.ts.
ALL_RED_SECS = 3.0
# Phase-adjust amount (s) applied by `extend_green` (+5 s) and
# `shorten_red` (-5 s). Mirrors `PHASE_ADJUST_SECS` on the TS side.
PHASE_ADJUST_SECS = 5.0
# Upper bound (s) on the green phase's **remaining** time after
# `extend_green` — the project's existing convention (the frontend's
# `ActuatedController` caps the green the same way). Mirrors
# `MAX_GREEN_SECS` in
# TraffSim3D-frontend/src/shared/constants/simulation.ts.
#
# It bounds the remaining time, NOT the green's wall-clock duration:
# a policy that applies `extend_green` on *every* decision keeps the
# remaining topped up and can still hold one axis green indefinitely.
# The mitigation is the reward function (the cross-axis delay must be
# in it) — see `docs/contracts/sim-snapshot.md`.
MAX_GREEN_SECS = 60.0
# The all-red clearance expressed in sim steps (3 s at the contract's 10 Hz).
ALL_RED_STEPS = int(round(ALL_RED_SECS / DT))


@dataclass
class Vehicle:
    x: float = 0.0
    z: float = 0.0
    heading: float = 0.0  # rad, 0 = +X, π/2 = +Z (north)
    speed: float = 0.0    # m/s
    y: float = 0.0        # elevation (m), Plan 061


@dataclass
class TrafficLight:
    """Single intersection with two axes; one green at a time."""
    ns_green: bool = True
    ew_green: bool = False
    cycle_timer: float = 0.0
    cycle_duration: float = 30.0  # seconds per phase
    # --- Plan 073 Sprint 2 (A2a): the externally-actionable control surface ---
    # Actions queued by `apply_action`; consumed by the next `SimCore.step()`.
    pending_actions: list[str] = field(default_factory=list)
    # Steps of all-red clearance left (0 = the normal cycle runs).
    all_red_steps: int = 0
    # The (ns_green, ew_green) pair to restore once the all-red ends
    # (None = no pending resume).
    resume_state: tuple[bool, bool] | None = None

    def apply_action(self, action: str) -> None:
        """Queue an external signal action.

        Synchronous, and it does NOT change the light's phase: the action is
        consumed by the next `SimCore.step()`. This mirrors the frontend's
        `RLController.applyAction` (007 §2).

        An unknown name is rejected loudly — the vocabulary is a contract,
        not a free-form string.
        """
        if action not in SIGNAL_ACTION_NAMES:
            raise ValueError(
                f"unknown signal action {action!r}; expected one of {SIGNAL_ACTION_NAMES}"
            )
        self.pending_actions.append(action)

    def consume_actions(self) -> None:
        """Apply every queued action, in order.

        Semantics (Plan 073 Sprint 2), expressed in this light's own model —
        a single phase clock, so "the swap" is the one event both axes
        hang off:

        - `extend_green` — the green axis gets 5 s more: the swap is
          **delayed** by `PHASE_ADJUST_SECS`. The timer may go negative,
          which is exactly how "the green runs longer than
          `cycle_duration`" is expressed — bounded by
          `MAX_GREEN_SECS`, i.e. the green's *remaining* time never
          exceeds it. (Not a wall-clock bound: a policy that extends
          on every decision can still hold the axis green.)
        - `shorten_red` — the red axis waits 5 s less: the swap is
          **advanced** by `PHASE_ADJUST_SECS` (capped at `cycle_duration`,
          so the swap happens on the next step at the latest).
        - `preempt` / `force_all_red` — neither axis is green for
          `ALL_RED_SECS` (the phase clock is frozen, so the interrupted
          phase resumes where it left off). The resume point is only
          recorded for a light that actually has a green axis: an
          all-red resume point would wedge the light permanently.
        - `no_op` — nothing.
        """
        if not self.pending_actions:
            return
        actions = self.pending_actions
        self.pending_actions = []
        for action in actions:
            if action == "extend_green":
                # The green may grow by 5 s, but never past
                # `MAX_GREEN_SECS`. The floor on the elapsed clock is
                # `cycle_duration - MAX_GREEN_SECS`, i.e. the remaining
                # green is at most `MAX_GREEN_SECS`. (A bound on the
                # remaining, not on the wall-clock duration.)
                self.cycle_timer = max(
                    self.cycle_timer - PHASE_ADJUST_SECS,
                    self.cycle_duration - MAX_GREEN_SECS,
                )
            elif action == "shorten_red":
                self.cycle_timer = min(
                    self.cycle_timer + PHASE_ADJUST_SECS, self.cycle_duration
                )
            elif action in ("preempt", "force_all_red"):
                if self.all_red_steps == 0 and (
                    self.ns_green or self.ew_green
                ):
                    # Not already clearing, and the light has a green
                    # axis: remember the phase to resume. An all-red
                    # resume point would wedge the light permanently
                    # (it would resume into "no axis is green" and never
                    # recover).
                    self.resume_state = (self.ns_green, self.ew_green)
                self.all_red_steps = ALL_RED_STEPS
                self.ns_green = False
                self.ew_green = False
            # "no_op" — nothing.


@dataclass
class SimCore:
    ego: Vehicle = field(default_factory=lambda: Vehicle(x=0.0, z=-25.0, heading=math.pi / 2))
    npcs: list[Vehicle] = field(default_factory=list)
    light: TrafficLight = field(default_factory=TrafficLight)
    sim_time: float = 0.0
    step_count: int = 0
    max_steps: int = MAX_STEPS_DEFAULT
    _terminated: bool = False
    _terminated_reason: str = ""
    # Plan 067: the time-limit (truncation) flag is *latched*, mirroring
    # `_terminated`. It used to be recomputed from `step_count >= max_steps`
    # on every step, so once the limit was reached the world kept simulating
    # and kept accruing the alive bonus, and every following step re-reported
    # `truncated=True` — which made `CurriculumEnv` record one episode per
    # extra step. Now the episode's final state is stable once truncated.
    _truncated: bool = False
    # Plan 048: scene_kind determines road topology and Pure Pursuit target.
    # 'cross' (default, 044 behavior): single 4-way intersection.
    # 'corridor' (048): 2 4-way intersections + 60m NS corridor between.
    scene_kind: str = "cross"

    def reset(self, seed: int | None = None) -> np.ndarray:
        if self.scene_kind == "corridor":
            return self._reset_corridor()
        if self.scene_kind == "t_junction":
            return self._reset_t_junction()
        if self.scene_kind == "roundabout":
            return self._reset_roundabout()
        return self._reset_cross()

    def _reset_cross(self) -> np.ndarray:
        """Original cross scene (Plan 044). Single 4-way intersection."""
        self.ego = Vehicle(x=0.0, z=-25.0, heading=math.pi / 2, speed=0.0)
        # 4 NPCs at varying positions on each cardinal direction
        self.npcs = [
            Vehicle(x=0.0, z=15.0, heading=math.pi / 2, speed=NPC_SPEED),       # NB
            Vehicle(x=3.5, z=-15.0, heading=-math.pi / 2, speed=NPC_SPEED),      # SB
            Vehicle(x=-15.0, z=0.0, heading=0.0, speed=NPC_SPEED),              # EB
            Vehicle(x=15.0, z=3.5, heading=math.pi, speed=NPC_SPEED),           # WB
        ]
        self.light = TrafficLight()
        self.sim_time = 0.0
        self.step_count = 0
        self._terminated = False
        self._terminated_reason = ""
        self._truncated = False
        return self._obs()

    def _reset_corridor(self) -> np.ndarray:
        """Plan 048: 2 4-way intersections + 60m NS corridor (mirror
        frontend buildCorridorScene).

        NPC positions are spread to avoid immediate collisions with ego.
        Traffic lights at both intersections start NS-green so ego
        can pass through (corridor coordination).
        """
        # Ego starts south, heading north, on the NS corridor.
        self.ego = Vehicle(x=0.0, z=-25.0, heading=math.pi / 2, speed=0.0)
        # 4 NPCs spaced so they're not in ego's immediate path:
        #   NB at z=+10 (35u ahead of ego) heading north (same dir, won't catch up)
        #   SB at z=-10 (15u behind) heading south (opposite dir, won't collide)
        #   EB at x=-20 (EW road, far left of ego's x=0)
        #   WB at x=+20 (EW road, far right of ego's x=0)
        self.npcs = [
            Vehicle(x=0.0,    z=10.0,  heading=math.pi / 2,    speed=NPC_SPEED),  # NB
            Vehicle(x=3.5,    z=-10.0, heading=-math.pi / 2,   speed=NPC_SPEED),  # SB
            Vehicle(x=-20.0,  z=0.0,   heading=0.0,           speed=NPC_SPEED),  # EB
            Vehicle(x=20.0,   z=3.5,   heading=math.pi,       speed=NPC_SPEED),  # WB
        ]
        # Both intersections start NS-green (corridor coordination);
        # cycle flips NS↔EW like cross scene.
        self.light = TrafficLight(ns_green=True, ew_green=False)
        self.sim_time = 0.0
        self.step_count = 0
        self._terminated = False
        self._terminated_reason = ""
        self._truncated = False
        return self._obs()

    def _reset_t_junction(self) -> np.ndarray:
        """T-junction scene (mirror frontend buildTJunctionNetwork).

        Layout: EW road (full width, z=0, x ∈ [-30, 30]) + S arm (x=0,
        z ∈ [-30, 0]). No N arm — 3-way intersection at origin.
        Ego starts south, heading north. Must enter intersection safely.
        """
        self.ego = Vehicle(x=0.0, z=-25.0, heading=math.pi / 2, speed=0.0)
        # 4 NPCs: 2 on EW road, 1 on S arm ahead of ego, 1 on EW from other side
        self.npcs = [
            Vehicle(x=-18.0, z=3.5,  heading=0.0,           speed=NPC_SPEED),  # EB
            Vehicle(x=18.0,  z=-3.5, heading=math.pi,       speed=NPC_SPEED),  # WB
            Vehicle(x=3.5,   z=-12.0, heading=math.pi / 2,  speed=NPC_SPEED),  # NB on S arm
            Vehicle(x=-10.0, z=0.0,  heading=0.0,           speed=NPC_SPEED),  # EB (closer)
        ]
        self.light = TrafficLight(ns_green=True, ew_green=False)
        self.sim_time = 0.0
        self.step_count = 0
        self._terminated = False
        self._terminated_reason = ""
        self._truncated = False
        return self._obs()

    def _reset_roundabout(self) -> np.ndarray:
        """Roundabout scene: circular intersection with circulating traffic.

        Layout: Roundabout circle at origin, radius ROUNDABOUT_RADIUS (10m).
        Ego enters from south (0, -25) heading north, must navigate the
        circle and exit north. NPCs circulate counterclockwise.
        """
        R = ROUNDABOUT_RADIUS
        self.ego = Vehicle(x=0.0, z=-25.0, heading=math.pi / 2, speed=0.0)
        # 4 NPCs circulating counterclockwise on the roundabout.
        # Positions at 0°, 90°, 180°, 270° (starting angles).
        # Heading is tangent to circle (angle + π/2 for CCW motion).
        self.npcs = [
            Vehicle(x=R, z=0.0, heading=math.pi / 2, speed=NPC_SPEED),        # E→N
            Vehicle(x=0.0, z=R, heading=math.pi, speed=NPC_SPEED),            # N→W
            Vehicle(x=-R, z=0.0, heading=-math.pi / 2, speed=NPC_SPEED),      # W→S
            Vehicle(x=0.0, z=-R, heading=0.0, speed=NPC_SPEED),               # S→E
        ]
        # Roundabout has no traffic lights (yield-on-entry)
        self.light = TrafficLight(ns_green=True, ew_green=True)
        self.sim_time = 0.0
        self.step_count = 0
        self._terminated = False
        self._terminated_reason = ""
        self._truncated = False
        return self._obs()

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        """One 0.1s step. Returns (obs, reward, terminated, truncated, info)."""
        if self._terminated:
            return self._obs(), 0.0, True, False, {"reason": self._terminated_reason}
        if self._truncated:
            # Plan 067: the time limit was already reached — the episode is
            # over. Freeze the world so the final state is stable and
            # reproducible instead of drifting on for every extra step.
            return self._obs(), 0.0, False, True, {"reason": self._terminated_reason, "progress": 0.0}

        # 1) Apply ego control via accel + Pure Pursuit steer
        accel_cmd = float(np.clip(action[0], -1.0, 1.0)) * 3.0   # m/s²
        # Pure Pursuit target:
        #   cross: intersection center (0, 0)
        #   corridor: north end of corridor (0, +30), so ego passes
        #     both intersections instead of stalling at the first one
        #   roundabout: north exit (0, +10)
        if self.scene_kind == "corridor":
            target = (0.0, 30.0)
        elif self.scene_kind == "roundabout":
            target = (0.0, ROUNDABOUT_RADIUS)
        else:
            target = (0.0, 0.0)
        dx = target[0] - self.ego.x
        dz = target[1] - self.ego.z
        target_angle = math.atan2(dz, dx)
        alpha = self.ego.heading - target_angle
        # Wrap alpha to [-π, π]
        alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
        steer = math.atan2(2.0 * EGO_WHEELBASE * math.sin(alpha), LOOKAHEAD_DISTANCE)
        steer = float(np.clip(steer, -MAX_STEER, MAX_STEER))

        # 2) Update ego kinematics (Euler)
        prev_z = self.ego.z
        self.ego.speed = max(0.0, min(SPEED_LIMIT, self.ego.speed + accel_cmd * DT))
        self.ego.heading += steer * DT  # simplified bicycle model
        self.ego.x += self.ego.speed * math.cos(self.ego.heading) * DT
        self.ego.z += self.ego.speed * math.sin(self.ego.heading) * DT

        # 3) Advance NPCs (constant speed, straight or circular for roundabout)
        if self.scene_kind == "roundabout":
            # Circular motion: NPCs circulate counterclockwise around origin.
            # Angular velocity = speed / radius.
            omega = NPC_SPEED / ROUNDABOUT_RADIUS
            for npc in self.npcs:
                # Current angle from position
                angle = math.atan2(npc.z, npc.x)
                # Advance angle (CCW = positive)
                angle += omega * DT
                # Update position on circle
                npc.x = ROUNDABOUT_RADIUS * math.cos(angle)
                npc.z = ROUNDABOUT_RADIUS * math.sin(angle)
                # Heading is tangent to circle (angle + π/2)
                npc.heading = angle + math.pi / 2
        else:
            for npc in self.npcs:
                npc.x += npc.speed * math.cos(npc.heading) * DT
                npc.z += npc.speed * math.sin(npc.heading) * DT
                # NPC respawn at opposite end when out of bounds
                if abs(npc.x) > 40 or abs(npc.z) > 40:
                    npc.x = -npc.x * 0.8
                    npc.z = -npc.z * 0.8

        # 4) Traffic light cycle
        # The clearance that ended with the previous step resumes FIRST,
        # so the actions consumed below observe the resumed phase and not
        # the all-red state the light was left in. Without this order a
        # preempt landing on that step would overwrite the resume point
        # with (False, False) and the light would never go green again.
        if self.light.all_red_steps == 0 and self.light.resume_state is not None:
            self.light.ns_green, self.light.ew_green = self.light.resume_state
            self.light.resume_state = None
        self.light.consume_actions()
        if self.light.all_red_steps > 0:
            # All-red clearance (Plan 073 Sprint 2): neither axis is green
            # and the phase clock is frozen, so the interrupted phase
            # resumes where it left off.
            self.light.ns_green = False
            self.light.ew_green = False
            self.light.all_red_steps -= 1
        else:
            self.light.cycle_timer += DT
            if self.light.cycle_timer >= self.light.cycle_duration:
                self.light.cycle_timer = 0.0
                self.light.ns_green, self.light.ew_green = (
                    self.light.ew_green,
                    self.light.ns_green,
                )

        self.sim_time += DT
        self.step_count += 1

        # 5) Compute reward + termination
        reward = 0.05  # alive bonus
        progress = max(0.0, self.ego.z - prev_z)
        reward += 1.0 * progress

        # Check collision
        for npc in self.npcs:
            d = math.hypot(self.ego.x - npc.x, self.ego.z - npc.z)
            if d < COLLISION_DISTANCE:
                self._terminated = True
                self._terminated_reason = "collision"
                reward -= 10.0
                break

        # Check red-light running
        if not self._terminated and self._check_red_light_run():
            self._terminated = True
            self._terminated_reason = "red_light"
            reward -= 5.0

        # Plan 048: corridor has TWO intersections and a "pass through
        # both" success condition.
        if not self._terminated:
            if self.scene_kind == "corridor":
                # Both intersections green = ego can pass through corridor
                # successfully when ego reaches z=+30 (north of i-south)
                if self.ego.z > 25.0:
                    self._terminated = True
                    self._terminated_reason = "success_corridor"
                    reward += 10.0  # larger bonus for 2-intersection pass
            elif self.scene_kind == "t_junction":
                # T-junction: ego enters intersection from south arm.
                # Intersection at z=0 with radius 6; success at z > -3.
                if self.ego.z > -3.0:
                    self._terminated = True
                    self._terminated_reason = "success_t_junction"
                    reward += 5.0
            elif self.scene_kind == "roundabout":
                # Roundabout: ego enters from south, navigates circle, exits north.
                # Success when ego passes north exit (z > 5, past circle at z=10).
                if self.ego.z > 5.0:
                    self._terminated = True
                    self._terminated_reason = "success_roundabout"
                    reward += 5.0
            else:
                # Cross scene single-intersection success (original 044)
                if self.ego.z > 25.0:
                    self._terminated = True
                    self._terminated_reason = "success"
                    reward += 5.0

        # Check max steps
        # Plan 067: latch the truncation instead of recomputing it every
        # step. The step that reaches the limit reports `truncated=True` and
        # still earns its reward; every later step short-circuits at the top
        # of `step()`.
        if self.step_count >= self.max_steps and not self._terminated:
            self._truncated = True

        info = {"reason": self._terminated_reason, "progress": progress}
        return self._obs(), float(reward), self._terminated, self._truncated, info

    def _check_red_light_run(self) -> bool:
        """Ego is in intersection AND light is red for its direction."""
        in_intersection = abs(self.ego.x) < INTERSECTION_RADIUS and abs(self.ego.z) < INTERSECTION_RADIUS
        if not in_intersection:
            return False
        # Simpler heuristic: ego heading near north/south (π/2 ± 0.5) => NS
        heading_ns = abs((self.ego.heading % (2 * math.pi)) - math.pi / 2) < 0.5
        if heading_ns and not self.light.ns_green:
            return True
        if not heading_ns and not self.light.ew_green:
            return True
        return False

    def _obs(self) -> np.ndarray:
        """Build the 14-dim observation vector."""
        obs = np.zeros(OBS_DIM, dtype=np.float32)
        # [0:3] ego pose normalized
        obs[0] = np.clip(self.ego.x / 50.0, -1.0, 1.0)
        obs[1] = np.clip(self.ego.z / 50.0, -1.0, 1.0)
        obs[2] = self.ego.heading / math.pi  # [-1, 1]
        # [3:6] ego motion
        obs[3] = self.ego.speed / SPEED_LIMIT  # [0, 1]
        obs[4] = 0.0  # accel placeholder
        obs[5] = 0.0  # steering placeholder
        # [6:8] traffic light
        obs[6] = 1.0 if self.light.ns_green else 0.0
        obs[7] = 1.0 if self.light.ew_green else 0.0
        # [8:13] distances to 5 nearest NPCs (sorted ascending)
        distances = sorted(
            math.hypot(self.ego.x - n.x, self.ego.z - n.z) for n in self.npcs
        )
        # Pad to 5 entries (we only have 4 NPCs)
        while len(distances) < 5:
            distances.append(50.0)
        for i, d in enumerate(distances[:5]):
            obs[8 + i] = min(d / 50.0, 1.0)
        # [13] ego elevation (Plan 061)
        obs[13] = np.clip(self.ego.y / 10.0, -1.0, 1.0)
        return obs
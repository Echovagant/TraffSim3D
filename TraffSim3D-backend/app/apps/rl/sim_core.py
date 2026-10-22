"""Minimal Python sim core (mirror of TS tick.ts).

A research-quality reimplementation of the 4-way intersection scene
from the frontend sim. NOT a full port — only the subset needed
for PPO to learn. The frontend TS sim is authoritative for visual
quality; this Python sim is authoritative for training.

Layout (matches the frontend's cross scene):
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

# The road's half-width (m).
#
# The scenes carry no lane model; they place the NPCs at a **3.5 m lateral
# offset** from the road's centreline (`_reset_cross`: the southbound NPC
# at `x = 3.5`, the westbound one at `z = 3.5`), so 3.5 m is the
# half-width the scene itself implies. It is the number the success
# condition uses to decide whether the ego stayed on the road.
ROAD_HALF_WIDTH = 3.5

# The **goal line** of each scene: the z the ego has to pass to score the
# success. The success condition and the progress reward both read it, so
# they cannot drift apart.
#
# The progress reward is the *signed* advance towards this
# line, bounded by it. That is what keeps the reward from being farmed:
# an ego that leaves the road (and is therefore never terminated by the
# success) cannot keep earning progress past the goal, and a step
# backwards cancels the step before it instead of being clipped away.
SCENE_GOAL_Z = {
    "cross": 25.0,
    "corridor": 25.0,
    "t_junction": -3.0,
    "roundabout": 5.0,
    # The signalled scene's goal line is the same one the
    # `cross` scene uses - the difference between the two scenes is the
    # **light schedule**, not the route.
    "cross_signalled": 25.0,
}

# ===== the signalled scene's light schedule =====
#
# The four scenes above run the default 30 s cycle, so the first phase
# change lands on step 300 - beyond every ego episode (the light
# never swaps inside an episode). That is why the ego never
# faces a red light in them, and why a scripted controller is never
# punished for ignoring the light.
#
# `cross_signalled` is the scene that gives the ego a **decision**: its
# own axis starts **RED** and turns **GREEN** inside the episode, so a
# driver that does not look at the light pays for it (-5 for a red-light
# run, -10 for a collision).
#
# The cycle length is measured, not guessed:
#
# - the **green** window must be long enough for the ego to clear the
#   intersection from a standstill: 33 steps (3.3 s) from the stop line
#   (z = -8) to the far edge (z = +8), 47 steps (4.7 s) to the goal
#   line (z = +25). A 12 s green is 120 steps - 3.6x the longest of
#   those, so even a slow start clears the intersection inside it;
# - the **red** window must be long enough that the strongest constant
#   throttle cannot simply slip through on the green: a constant
#   throttle may only enter the intersection once the green starts,
#   which forces it to crawl, and a crawling throttle cannot reach the
#   goal inside the episode horizon (measured: the best constant
#   throttle is truncated at 200 steps, while the light-aware drive
#   finishes in 179).
#
# 12 s is also an ordinary red-light duration, so the scene is not a
# contrived puzzle.
CROSS_SIGNALLED_CYCLE_SECONDS = 12.0

# Pure Pursuit (Coulter 1992)
LOOKAHEAD_DISTANCE = 8.0
MAX_STEER = 0.4         # rad
DT = 0.1                # seconds per sim step (matches frontend 10Hz)

# ===== the ego's reward =====
#
# The per-step "alive" bonus used to be a flat 0.05 **per step**. It paid a
# policy for *existing* - and, because a step is a unit of *time*, it
# implicitly paid for being **slow**: the more steps an episode took, the
# more it earned. The measured consequence (the re-measurement)
# was that the trained ego policy beat "constant full throttle" (+1.13)
# only because it drove slower (86 steps against 58), and still lost to the
# best constant throttle (60.227 against 60.835) - the whole margin came
# from the bonus, not from the driving.
#
# The change turns that term around: the passage of time is now **charged**:
#
#   reward = PROGRESS_WEIGHT * progress - TIME_COST
#
# so the direction of the speed signal is right (arriving sooner is
# better) and there is nothing left to farm: standing still pays the cost
# without earning anything, and creeping pays it for longer.
#
# `progress` is the **signed** advance towards the goal line, bounded by
# it (see `step()`), so it cannot be farmed either: a step backwards
# cancels the step before it, and driving past the goal earns nothing.
#
# The magnitude of TIME_COST is the **same 0.05 the old alive bonus paid**,
# with the sign flipped: the old term paid for the passage of time, the
# new one charges for it. It is deliberately smaller than the progress a
# step earns at the slowest pace that still reaches the goal (throttle
# 0.35 => 1.05 m/s => 0.105 m of progress per step, and 0.105 > 0.05), so
# every step that makes progress still pays for itself, while a step that
# makes none is a pure loss.
#
# The signal agent's reward is a separate quantity entirely (the negative
# total delay, `signal_env.SignalEnv`), so this change does not touch it.
PROGRESS_WEIGHT = 1.0    # per metre of progress
TIME_COST = 0.05         # per step - the speed signal (less time = better)

# ===== the shared signal-action vocabulary =====
#
# The five action names are the externally-actionable control surface of
# the traffic signal. The
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
# Lower bound (s) on the green phase's **remaining** time: a controller
# may not shorten a green below it. It is the symmetric counterpart of
# the browser's `MIN_RED_SECS` (a red is never shorter than 10 s) — the
# full rule is "a red is never shorter than MIN_RED_SECS, a green is
# never shorter than MIN_GREEN_SECS". Mirrors `MIN_GREEN_SECS` in
# TraffSim3D-frontend/src/shared/constants/simulation.ts.
#
# It exists because a controller that shrinks the phase on every
# decision would otherwise *flicker* the light (0.6 s per phase) —
# which no driver can react to, and which made the "flicker" schedule
# look optimal inside the model.
#
# It is enforced at the **controller / environment** layer (the Python
# `SignalEnv` masks the `shorten_red` action; the browser's
# `RLController` floors the phase) and NOT in the physical light model
# below — that model is the cross-language contract's sensitive area and
# its default behaviour must stay bit-identical.
MIN_GREEN_SECS = 10.0
# The all-red clearance expressed in sim steps (3 s at the contract's 10 Hz).
ALL_RED_STEPS = int(round(ALL_RED_SECS / DT))
# The inter-green clearance (s) charged on every phase change.
#
# The browser charges a 3 s yellow plus a 3 s all-red before the other
# axis may go - six seconds during which no new vehicle gets a green.
# The Python light model swapped instantaneously, which made switching
# phases FREE: splitting the same green time into more, shorter phases
# was a pure gain, so a signal agent's optimum was a fixed-time
# controller in disguise.
#
# The clearance is charged by `SimCore` - NOT by the `TrafficLight`
# dataclass, which is the cross-language contract's sensitive area - and
# only while the responsive traffic model is on. The default path is
# therefore bit-identical and the committed goldens do not move.
#
# It matches the browser's minimum inter-green
# (`MIN_INTER_GREEN_SECS` in
# TraffSim3D-frontend/src/shared/constants/simulation.ts); the contract
# compares the two numbers.
CLEARANCE_SECS = 6.0
# The inter-green clearance expressed in sim steps (6 s at the 10 Hz clock).
CLEARANCE_STEPS = int(round(CLEARANCE_SECS / DT))

# ===== traffic that answers to the light =====
#
# The NPCs used to drive in straight lines at a constant speed and to
# teleport back when they left the world — they never looked at the light.
# A signal agent trained against that world had no causal link between its
# action and the traffic. The constants below describe the *responsive*
# traffic model.
#
# It is OFF by default (`SimCore.responsive_traffic`): the default path is
# the basis of the committed cross-language contract goldens
# (tests/contract/snapshots/ts_*.json), and the contract compares the two
# sides for *exact* equality. The signal training env turns it on.

# The stop line sits at the edge of the intersection box — this far before
# the intersection centre, measured along the vehicle's direction of travel.
STOP_LINE_DISTANCE = INTERSECTION_RADIUS  # 8.0 m
# The smallest gap a queued vehicle keeps to the leader in front of it.
# Without it every vehicle would pile up *on* the stop line and no queue
# would ever form.
MIN_GAP = 4.0  # m
# Longitudinal comfort: how fast an NPC may accelerate / brake.
NPC_ACCEL = 4.0  # m/s²
NPC_DECEL = 6.0  # m/s²
# Below this speed a vehicle counts as queued (waiting at the stop line or
# behind a leader).
STOPPED_SPEED = 0.5  # m/s
# Slack for the "is the vehicle still before the stop line?" comparison.
STOP_LINE_EPS = 1e-9
# How far past the intersection centre a vehicle has to be
# before the **open** traffic model lets it leave the world (metres,
# measured along its own heading).
#
# The closed loop respawns a vehicle when it leaves the *world* (|x| or
# |z| > 40); the open model lets it leave when it has *crossed* — so the
# vehicles that queue far upstream (a long queue reaches far past the
# world's edge) stay in the world and keep queuing. That is what makes
# the delay of a starved axis grow with the episode instead of being
# capped by the fleet size.
OPEN_TRAFFIC_EXIT_DISTANCE = 40.0

# ===== the intersection conflict =====
#
# A vehicle may not enter the intersection while a vehicle of the
# *other* axis occupies it - it has to wait behind the stop line, in
# the queue.
#
# This is a *traffic* rule, exactly like the browser's
# `applyCrossRoadYield` ("first to arrive has priority"), and it
# lives in the responsive traffic model - NOT in the light model,
# which is the cross-language contract's sensitive area and must
# stay bit-identical.
#
# Why it is needed: without it the two axes never
# block each other, so splitting the same green time into more,
# shorter phases is a pure gain. A signal agent trained against
# that world has no trade-off to learn - its optimum is a
# fixed-time controller in disguise.
#
# The occupancy test is the intersection box itself: a vehicle is
# inside it when `|x| < INTERSECTION_RADIUS` and
# `|z| < INTERSECTION_RADIUS` (the same box the ego's own
# red-light rule uses). The stop line sits exactly on the box edge
# (`STOP_LINE_DISTANCE == INTERSECTION_RADIUS`), so for an
# approaching vehicle "before the stop line" and "outside the box"
# are the same statement.


@dataclass
class Vehicle:
    x: float = 0.0
    z: float = 0.0
    heading: float = 0.0  # rad, 0 = +X, π/2 = +Z (north)
    speed: float = 0.0    # m/s
    y: float = 0.0        # elevation (m)
    # --- signal-responsive traffic ---
    # The signalised approach axis this vehicle runs along ("ns" / "ew"),
    # derived from its heading. Empty when the vehicle is not on a
    # signalised approach.
    axis: str = ""
    # The sim time at which the current wait began (None while the vehicle
    # is not waiting). Used for the delay accounting.
    stopped_at: float | None = None


def approach_axis(heading: float) -> str:
    """The signalised approach axis a heading runs along: "ns" or "ew".

    The NPCs drive straight through the intersection centre, so the axis
    follows from the heading alone: a heading within 45° of ±Z runs on the
    north-south road ("ns"), a heading within 45° of ±X on the east-west
    road ("ew").
    """
    sin_h = math.sin(heading)
    cos_h = math.cos(heading)
    return "ns" if abs(sin_h) >= abs(cos_h) else "ew"


def approach_distance(vehicle: Vehicle) -> float:
    """The signed distance from the intersection centre along the travel
    direction.

    It grows as the vehicle drives, so a vehicle that has not reached the
    centre yet has a negative value — and the stop line sits at
    `-STOP_LINE_DISTANCE` in these coordinates.
    """
    return vehicle.x * math.cos(vehicle.heading) + vehicle.z * math.sin(vehicle.heading)


def lateral_offset(vehicle: Vehicle) -> float:
    """The perpendicular distance from the centreline of the road the
    vehicle runs along.

    The scenes carry no lane model; which road a vehicle runs along
    follows from its heading - the same `approach_axis` the traffic model
    uses - so a north-south vehicle is measured against the `x = 0`
    centreline and an east-west one against the `z = 0` centreline.
    """
    if approach_axis(vehicle.heading) == "ns":
        return abs(vehicle.x)
    return abs(vehicle.z)


def _lane_key(vehicle: Vehicle) -> tuple[str, int, float]:
    """The lane a vehicle runs in: (axis, direction, lateral offset).

    Vehicles only follow each other when they share all three — the same
    approach axis, the same direction of travel and (roughly) the same
    lateral offset, i.e. the same lane.
    """
    axis = approach_axis(vehicle.heading)
    if axis == "ns":
        direction = 1 if math.sin(vehicle.heading) >= 0 else -1
        lateral = vehicle.x
    else:
        direction = 1 if math.cos(vehicle.heading) >= 0 else -1
        lateral = vehicle.z
    return (axis, direction, round(lateral, 2))


@dataclass
class TrafficLight:
    """Single intersection with two axes; one green at a time."""
    ns_green: bool = True
    ew_green: bool = False
    cycle_timer: float = 0.0
    cycle_duration: float = 30.0  # seconds per phase
    # --- the externally-actionable control surface ---
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
        `RLController.applyAction`.

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

        Semantics, expressed in this light's own model —
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
    # The time-limit (truncation) flag is *latched*, mirroring
    # `_terminated`. It used to be recomputed from `step_count >= max_steps`
    # on every step, so once the limit was reached the world kept simulating
    # and kept accruing the alive bonus, and every following step re-reported
    # `truncated=True` — which made `CurriculumEnv` record one episode per
    # extra step. Now the episode's final state is stable once truncated.
    _truncated: bool = False
    # Has the ego left the road during this episode?
    #
    # The success condition used to be route-agnostic (`ego.z > 25`), so a
    # wrong route that left the road scored the same success - and the same
    # +5 bonus - as the right one. The latch is permanent: success needs
    # the ego to have **stayed** on the road, not to be on it at the moment
    # it crossed the line.
    _off_road: bool = False
    # scene_kind determines road topology and Pure Pursuit target.
    # 'cross' (default): single 4-way intersection.
    # 'corridor': 2 4-way intersections + 60m NS corridor between.
    scene_kind: str = "cross"
    # Make the traffic obey the light.
    #
    # OFF by default on purpose. The default path is the basis of the
    # committed cross-language contract goldens
    # (tests/contract/snapshots/ts_*.json) and the contract compares the
    # two sides for *exact* equality, so the responsive behaviour must not
    # leak into it. The signal training env (`signal_env.SignalEnv`) turns
    # it on; the contract vectors keep running the default path.
    responsive_traffic: bool = False
    # The inter-green clearance.
    #
    # `_clearance_steps` counts the clearance steps that are left (0 =
    # the normal cycle runs); `_pending_swap` is the phase to show when
    # the clearance ends (None = no swap pending).
    #
    # The state lives here, in `SimCore`, and NOT in the `TrafficLight`
    # dataclass: that dataclass is the cross-language contract's
    # sensitive area and must not grow.
    _clearance_steps: int = 0
    _pending_swap: tuple[bool, bool] | None = None
    # The light cycle of the **signalled** scene, overridable
    # for training.
    #
    # `None` (the default) means the scene's own cycle
    # (`CROSS_SIGNALLED_CYCLE_SECONDS`) - that is the value the cross-language
    # contract pins, and it is what the committed goldens run. A number
    # overrides it for **training only** (the light curriculum in
    # `app/apps/rl/train.py`): the compliant behaviour - "brake while the
    # light is red" - is almost never sampled in a 12 s red, but it is
    # sampled in a 6 s one, and the observation is memoryless, so what the
    # policy learns is a *light-state condition* and transfers across red
    # lengths.
    #
    # This is a **Python-only** knob, like `responsive_traffic`: the
    # TypeScript contract mirror has no counterpart and the contract does
    # not cover it (the contract always runs the default cycle).
    light_cycle_seconds: float | None = None
    # The **open** traffic model.
    #
    # OFF by default. The default path is the basis of the committed
    # cross-language contract goldens (tests/contract/snapshots/ts_*.json)
    # and the contract compares the two sides for *exact* equality, so the
    # default behaviour must not move - not even by one vehicle.
    #
    # With it on, a vehicle that has crossed the intersection and left the
    # downstream end **leaves the world** instead of being respawned at the
    # mirrored position. The closed loop (the default) keeps a FIXED fleet
    # on every lane, so the queue can never be longer than that fleet and
    # the delay of a starved axis is capped at (fleet size x episode
    # length). The browser's traffic is open (spawn at a fixed headway,
    # disappear after the crossing), so the delay there is unbounded - the
    # mismatch this flag removes.
    #
    # The **spawning** half lives in the environment (`signal_env`), which
    # owns the demand (`signal_conditions.TrafficCondition`); this flag
    # owns the **leaving** half, because the respawn happens here.
    #
    # Python-only, like `responsive_traffic`: the TypeScript contract
    # mirror has no counterpart and the contract does not cover it.
    open_traffic: bool = False

    def reset(self, seed: int | None = None) -> np.ndarray:
        # The inter-green clearance is per-episode state.
        self._clearance_steps = 0
        self._pending_swap = None
        # The off-road latch is per-episode state too.
        self._off_road = False
        if self.scene_kind == "cross":
            return self._reset_cross()
        if self.scene_kind == "corridor":
            return self._reset_corridor()
        if self.scene_kind == "t_junction":
            return self._reset_t_junction()
        if self.scene_kind == "roundabout":
            return self._reset_roundabout()
        if self.scene_kind == "cross_signalled":
            return self._reset_cross_signalled()
        # An unknown scene name used to fall through to the
        # `cross` scene, which is a silent lie: a caller that asked for a
        # scene that does not exist measured the **cross** scene instead
        # (and its numbers looked perfectly plausible). The scene list is
        # the contract's (`SCENE_GOAL_Z`), so an unknown name is a bug in
        # the caller and is reported as one.
        raise ValueError(
            f"unknown scene_kind {self.scene_kind!r}; "
            f"expected one of {sorted(SCENE_GOAL_Z)}"
        )

    def _reset_cross(self) -> np.ndarray:
        """Original cross scene. Single 4-way intersection."""
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
        """2 4-way intersections + 60m NS corridor (mirror
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

    def _reset_cross_signalled(self) -> np.ndarray:
        """The signalled cross - the ego's axis starts RED.

        The four scenes above leave the ego's axis green for the whole
        episode, so the ego never faces a red light and a scripted
        controller is never punished for ignoring the light (the light
        never swaps). Here the ego's axis starts **red** and turns green
        at step 121 (12 s) - inside the episode, and inside the ego's approach.

        The NPC layout is the **measured** one, not a copy of the `cross`
        scene's:

        - Only the **east-west cross traffic** is on the road. A
          north-south NPC would be respawned by the default traffic
          model's out-of-bounds rule (``x -> -0.8 x``), which converges
          onto the ego's own centreline within two respawns (measured:
          x = -3.5 -> 2.8 -> -2.24 -> 1.79). It would then drive straight
          into a **stopped** ego - the scenario would be unwinnable, not
          merely hard.
        - The east-west traffic never comes closer than **5.2 m** to an
          ego stopped at the stop line (measured over 400 steps), so it
          never interferes with an ego that waits.

        What the cross traffic does **not** do is create a second timed
        decision: it crosses the ego's path (|x| < 2) on steps 17-21,
        107-111, 199-203 and 289-293, while the light-aware drive is in
        the intersection on steps ~150-167. Those windows do not overlap,
        so in the winning run the cross traffic plays **no part at all**
        - the scene's discriminating power comes **entirely from the red
        light**. The traffic is here to keep the scene a real
        intersection, not to add a second thing to get right.

        The ego's start pose, the goal line and the Pure Pursuit target
        are the `cross` scene's - the only difference is the light
        schedule.
        """
        self.ego = Vehicle(x=0.0, z=-25.0, heading=math.pi / 2, speed=0.0)
        # 2 NPCs: the east-west cross traffic (the `cross` scene's pair).
        self.npcs = [
            Vehicle(x=-15.0, z=0.0, heading=0.0, speed=NPC_SPEED),   # EB
            Vehicle(x=15.0, z=3.5, heading=math.pi, speed=NPC_SPEED),  # WB
        ]
        # The ego's axis starts RED: the phase swaps to green at step 121.
        self.light = TrafficLight(
            ns_green=False,
            ew_green=True,
            cycle_duration=(
                CROSS_SIGNALLED_CYCLE_SECONDS
                if self.light_cycle_seconds is None
                else self.light_cycle_seconds
            ),
        )
        self.sim_time = 0.0
        self.step_count = 0
        self._terminated = False
        self._terminated_reason = ""
        self._truncated = False
        return self._obs()

    def pursuit_target(self) -> tuple[float, float]:
        """The scripted Pure Pursuit target of this scene.

        - `cross`: the intersection centre (0, 0);
        - `corridor`: the north end of the corridor (0, +30), so the ego
          passes both intersections instead of stalling at the first one;
        - `roundabout`: the north exit (0, +10);
        - `cross_signalled`: the **goal line**
          (0, +25) - not the intersection centre.

        Why the signalled scene differs: the `cross` scene's target is a
        point the ego *passes* on the way, and after passing it the
        scripted Pure Pursuit pulls the ego back towards it, so the ego's
        heading starts to drop. That is harmless in the `cross` scene (the
        goal is only 24 m further and the ego arrives with momentum), but
        in the signalled scene the ego has just spent 121 steps waiting
        for the green and then has to cover the rest of the route on its
        own. The measured effect was that the policy - whose "brake"
        behaviour is keyed on the heading - kept braking after the
        crossing and stopped 2.3 m short of the goal line.

        A target that stays *ahead* of the ego for the whole route is the
        convention the `corridor` and `roundabout` scenes already use.

        (The TS contract mirror has the same method, `target()`.)
        """
        if self.scene_kind == "corridor":
            return (0.0, 30.0)
        if self.scene_kind == "roundabout":
            return (0.0, ROUNDABOUT_RADIUS)
        if self.scene_kind == "cross_signalled":
            return (0.0, SCENE_GOAL_Z["cross_signalled"])
        return (0.0, 0.0)

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        """One 0.1s step. Returns (obs, reward, terminated, truncated, info)."""
        if self._terminated:
            return self._obs(), 0.0, True, False, {"reason": self._terminated_reason}
        if self._truncated:
            # The time limit was already reached — the episode is
            # over. Freeze the world so the final state is stable and
            # reproducible instead of drifting on for every extra step.
            return self._obs(), 0.0, False, True, {"reason": self._terminated_reason, "progress": 0.0}

        # 1) Apply ego control via accel + Pure Pursuit steer
        accel_cmd = float(np.clip(action[0], -1.0, 1.0)) * 3.0   # m/s²
        # Pure Pursuit target: see `pursuit_target()`.
        target = self.pursuit_target()
        dx = target[0] - self.ego.x
        dz = target[1] - self.ego.z
        target_angle = math.atan2(dz, dx)
        alpha = target_angle - self.ego.heading
        # Wrap alpha to [-π, π]
        alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
        steer = math.atan2(2.0 * EGO_WHEELBASE * math.sin(alpha), LOOKAHEAD_DISTANCE)
        steer = float(np.clip(steer, -MAX_STEER, MAX_STEER))
        # The policy's steering authority is a **residual**
        # on top of the scripted Pure Pursuit steer, not a replacement.
        #
        # The scripted controller is the natural baseline: a policy that
        # commands no correction drives exactly as the baseline does, so
        # "beating the baseline" means the policy has learned something.
        # An *absolute* steering command would be meaningless in a
        # free-space sim with no lanes to follow - the policy would just
        # spin. The residual is scaled by MAX_STEER, so the total steer
        # stays inside the same actuator limit as the scripted one.
        #
        # `float(...)` around the clip is load-bearing: without it the
        # residual would be a numpy float32 and the addition would
        # downcast the float64 steer, breaking the contract's bit-exact
        # trajectory comparison.
        steer_residual = float(np.clip(action[1], -1.0, 1.0)) * MAX_STEER
        steer = float(np.clip(steer + steer_residual, -MAX_STEER, MAX_STEER))

        # 2) Update ego kinematics (Euler)
        prev_z = self.ego.z
        self.ego.speed = max(0.0, min(SPEED_LIMIT, self.ego.speed + accel_cmd * DT))
        self.ego.heading += steer * DT  # simplified bicycle model
        self.ego.x += self.ego.speed * math.cos(self.ego.heading) * DT
        self.ego.z += self.ego.speed * math.sin(self.ego.heading) * DT

        # Has the ego left the road?
        #
        # The latch makes the **success** need the ego to have
        # *stayed* on the road. The latch is read by the **reward** as
        # well (the mileage is only earned on the road), so it is set
        # here - right after the kinematics, which are its only input -
        # instead of further down. The ego's pose is final at this
        # point, so the latch value is the same as before; only the
        # order relative to the reward changed.
        if lateral_offset(self.ego) > ROAD_HALF_WIDTH:
            self._off_road = True

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
        elif self.responsive_traffic:
            # The NPCs obey the light, queue up
            # behind each other and are released by the green.
            self._step_responsive_npcs()
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
        # The inter-green clearance freezes the phase clock
        # completely - it does not advance, and a phase adjustment may
        # not move it either, so the next phase always starts with the
        # full cycle.
        #
        # The all-red clearance above only freezes the clock's *advance*;
        # here the adjustment is neutralised too, because the clock
        # reads 0 during the clearance and an adjustment landing there
        # would silently shorten the *next* green - below the minimum
        # green time the minimum-green guard exists to protect.
        clearing = self.responsive_traffic and self._clearance_steps > 0
        clock_before_clearance = self.light.cycle_timer
        self.light.consume_actions()
        if clearing:
            self.light.cycle_timer = clock_before_clearance
        if self.light.all_red_steps > 0:
            # All-red clearance: neither axis is green
            # and the phase clock is frozen, so the interrupted phase
            # resumes where it left off.
            self.light.ns_green = False
            self.light.ew_green = False
            self.light.all_red_steps -= 1
        elif clearing:
            # The inter-green clearance. Neither axis may go
            # and the phase clock is frozen; when the clearance runs out,
            # the other axis gets its green.
            self.light.ns_green = False
            self.light.ew_green = False
            self._clearance_steps -= 1
            if self._clearance_steps == 0 and self._pending_swap is not None:
                self.light.ns_green, self.light.ew_green = self._pending_swap
                self._pending_swap = None
        else:
            self.light.cycle_timer += DT
            if self.light.cycle_timer >= self.light.cycle_duration:
                self.light.cycle_timer = 0.0
                if self.responsive_traffic:
                    # The swap is no longer instantaneous -
                    # the two axes are separated by an inter-green
                    # clearance during which no new vehicle may go.
                    self._pending_swap = (
                        self.light.ew_green,
                        self.light.ns_green,
                    )
                    self._clearance_steps = CLEARANCE_STEPS
                    self.light.ns_green = False
                    self.light.ew_green = False
                else:
                    self.light.ns_green, self.light.ew_green = (
                        self.light.ew_green,
                        self.light.ns_green,
                    )

        self.sim_time += DT
        self.step_count += 1

        # 5) Compute reward + termination
        #
        # The progress is the **signed** advance towards the
        # goal line, bounded by that line:
        #
        #   progress = min(ego.z, goal_z) - min(prev_z, goal_z)
        #
        # The old `max(0, ego.z - prev_z)` was farmable twice over: an ego
        # that zig-zagged earned the same progress again and again, and an
        # ego that drove past the goal kept earning it. The second one
        # became reachable as soon as the off-road rule let an ego skip the
        # success: the first training run found it (episode returns of 283
        # against a ceiling of ~59).
        #
        # Signed and bounded, the progress is path-independent: every run
        # that reaches the goal earns exactly the distance to it.
        goal_z = self.goal_z
        progress = min(self.ego.z, goal_z) - min(prev_z, goal_z)
        # The mileage is only earned **on the road**.
        #
        # The latch's rule was "the success needs the ego to have **stayed** on
        # the road", but it guarded the success only - the mileage was
        # still paid wherever the ego drove, so a policy could farm the
        # progress by leaving the road. That hole was measured on the
        # signalled scene: the trained policy drove off the road
        # after the green, forfeited the +5 success bonus and still
        # collected the whole mileage.
        #
        # The same latch now covers the mileage, so the rule reads in one
        # sentence: **the ego has to stay on the road to earn anything.**
        if self._off_road:
            progress = 0.0
        # The per-step charge is a **cost**, not an alive bonus: the passage
        # of time is priced the right way round (sooner is better), and
        # there is nothing to farm - standing still pays the cost without
        # earning anything, and creeping pays it for longer.
        reward = PROGRESS_WEIGHT * progress - TIME_COST

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

        # The "the ego left the road" latch is set right
        # after the kinematics (it was moved up there, because
        # the reward reads it: the mileage is only earned on the road).
        # It is permanent - the success needs the ego to have STAYED on
        # the road.

        # The corridor has TWO intersections and a "pass through
        # both" success condition.
        #
        # Success also needs the ego to have stayed on the
        # road - the old condition (`ego.z > 25`) was route-agnostic, so a
        # wrong route that left the road scored the same success and the
        # same bonus as the right one.
        if not self._terminated and not self._off_road:
            if self.scene_kind == "corridor":
                # Both intersections green = ego can pass through corridor
                # successfully when ego reaches z=+30 (north of i-south)
                if self.ego.z > self.goal_z:
                    self._terminated = True
                    self._terminated_reason = "success_corridor"
                    reward += 10.0  # larger bonus for 2-intersection pass
            elif self.scene_kind == "t_junction":
                # T-junction: ego enters intersection from south arm.
                # Intersection at z=0 with radius 6; success at z > -3.
                if self.ego.z > self.goal_z:
                    self._terminated = True
                    self._terminated_reason = "success_t_junction"
                    reward += 5.0
            elif self.scene_kind == "roundabout":
                # Roundabout: ego enters from south, navigates circle, exits north.
                # Success when ego passes north exit (z > 5, past circle at z=10).
                if self.ego.z > self.goal_z:
                    self._terminated = True
                    self._terminated_reason = "success_roundabout"
                    reward += 5.0
            else:
                # Cross scene single-intersection success
                if self.ego.z > self.goal_z:
                    self._terminated = True
                    self._terminated_reason = "success"
                    reward += 5.0

        # Check max steps
        # Latch the truncation instead of recomputing it every
        # step. The step that reaches the limit reports `truncated=True` and
        # still earns its reward; every later step short-circuits at the top
        # of `step()`.
        if self.step_count >= self.max_steps and not self._terminated:
            self._truncated = True

        info = {
            "reason": self._terminated_reason,
            "progress": progress,
            "off_road": self._off_road,
        }
        return self._obs(), float(reward), self._terminated, self._truncated, info

    # ===== signal-responsive traffic =====

    @property
    def goal_z(self) -> float:
        """The z the ego has to pass to score the success.

        The success condition and the progress reward both
        read this number, so "the goal line" is one thing, not two.
        """
        return SCENE_GOAL_Z.get(self.scene_kind, SCENE_GOAL_Z["cross"])

    @property
    def in_clearance(self) -> bool:
        """Is the light in its inter-green clearance?

        During the clearance neither axis may go and the phase clock is
        frozen. The controller layer uses this to refuse a phase
        adjustment while the light is clearing - a `shorten_red` landing
        there would silently shorten the *next* green.

        (The browser has no counterpart to read: its phase model counts
        per light and already carries the yellow + all-red clearance
        itself.)
        """
        return self._clearance_steps > 0

    def queue_length(self, axis: str) -> int:
        """How many NPCs are queued on `axis`.

        A vehicle counts when it is still *before* the stop line (it has
        not entered the intersection yet) and it is (nearly) stopped —
        either waiting at the line or waiting behind a leader.
        """
        count = 0
        for npc in self.npcs:
            if approach_axis(npc.heading) != axis:
                continue
            if approach_distance(npc) > -STOP_LINE_DISTANCE + STOP_LINE_EPS:
                continue  # at or past the stop line: inside the intersection
            if npc.speed >= STOPPED_SPEED:
                continue  # still rolling: not queued (yet)
            count += 1
        return count

    def queue_lengths(self) -> dict[str, int]:
        """The per-axis queue counts: ``{"ns": n, "ew": n}``."""
        return {"ns": self.queue_length("ns"), "ew": self.queue_length("ew")}

    def waiting_time(self, axis: str) -> float:
        """How long the vehicles currently queued on `axis` have been
        waiting, in seconds (the sum of their current waits)."""
        total = 0.0
        for npc in self.npcs:
            if npc.stopped_at is None:
                continue
            if approach_axis(npc.heading) != axis:
                continue
            total += max(0.0, self.sim_time - npc.stopped_at)
        return total

    def _step_responsive_npcs(self) -> None:
        """Advance the NPCs so that they obey the traffic light.

        The model is deliberately small:

        - a vehicle that is still before the stop line and whose axis is
          red brakes to a stop at the stop line;
        - a vehicle may never come closer than `MIN_GAP` to the leader in
          front of it (same axis, same lane, same direction) — this is
          what makes a *queue* form instead of every vehicle piling up on
          the stop line;
        - a vehicle that has passed the stop line is inside the
          intersection: it keeps driving (it has already committed to the
          crossing) and it respawns as before.
        """
        lanes: dict[tuple[str, int, float], list[tuple[float, Vehicle]]] = {}
        for npc in self.npcs:
            npc.axis = approach_axis(npc.heading)
            lanes.setdefault(_lane_key(npc), []).append((approach_distance(npc), npc))

        # The intersection conflict. The occupancy is read
        # **once**, from the state at the beginning of the step, so the
        # outcome does not depend on the order in which the lanes are
        # processed - the model stays deterministic.
        occupied = self._occupied_axes()

        for group in lanes.values():
            # Front first: the largest distance along the travel direction
            # belongs to the vehicle closest to (or past) the stop line.
            group.sort(key=lambda item: item[0], reverse=True)
            leader: float | None = None
            for distance, npc in group:
                limit = self._signal_limit(npc, distance, occupied)
                if leader is not None:
                    follow = leader - MIN_GAP
                    limit = follow if limit is None else min(limit, follow)
                leader = self._drive_npc(npc, distance, limit)

        # Respawn at the opposite end when out of bounds — the behaviour
        # the default path has always had.
        #
        # With the **open** traffic model a vehicle that has
        # crossed the intersection and left the downstream end **leaves the
        # world** instead. The closed loop is what makes the queue
        # impossible to starve: a fixed fleet per lane ⇒ the queue can
        # never be longer than the fleet.
        #
        # The test is **directional** on purpose: a vehicle that is
        # queued far upstream (a long queue reaches far past the world's
        # edge) has a *negative* distance along its heading, so it is
        # kept — only the vehicles that have actually crossed the
        # intersection leave.
        if self.open_traffic:
            self.npcs = [
                npc
                for npc in self.npcs
                if approach_distance(npc) <= OPEN_TRAFFIC_EXIT_DISTANCE
            ]
        else:
            for npc in self.npcs:
                if abs(npc.x) > 40 or abs(npc.z) > 40:
                    npc.x = -npc.x * 0.8
                    npc.z = -npc.z * 0.8
                    npc.stopped_at = None

    def _occupied_axes(self) -> set[str]:
        """The axes whose vehicles currently occupy the intersection.

        A vehicle is *in* the intersection when it is
        inside the intersection box: `|x| < INTERSECTION_RADIUS` and
        `|z| < INTERSECTION_RADIUS`.

        Only the axis matters, not the individual vehicle: two vehicles
        of the same axis run in different lanes of the same road and
        pass each other, so they do not block each other - the
        car-following rule already handles them (that is what makes
        the queue form). Vehicles of different axes cross each other,
        so they do block each other. That is the same granularity as
        the browser's `applyCrossRoadYield`, which pairs vehicles by
        *road*.
        """
        axes: set[str] = set()
        for npc in self.npcs:
            if abs(npc.x) < INTERSECTION_RADIUS and abs(npc.z) < INTERSECTION_RADIUS:
                axes.add(approach_axis(npc.heading))
        return axes

    def _signal_limit(
        self, npc: Vehicle, distance: float, occupied_axes: set[str]
    ) -> float | None:
        """The furthest the vehicle may travel this step.

        Two rules can hold the vehicle back:

        - the light: a vehicle whose axis is red stops at the stop
          line;
        - the intersection conflict: a vehicle may not
          *enter* the intersection while the other axis occupies it,
          so it waits behind the stop line even when its axis is
          green.

        `None` means "no limit": the axis is green, the intersection
        is free, or the vehicle has already entered the intersection
        (it has committed to the crossing and keeps going).
        """
        if npc.axis == "ns":
            green = self.light.ns_green
        elif npc.axis == "ew":
            green = self.light.ew_green
        else:
            return None
        stop_distance = -STOP_LINE_DISTANCE
        if distance > stop_distance + STOP_LINE_EPS:
            # Already past the stop line: the vehicle is in the
            # intersection and keeps going.
            return None
        if not green:
            return stop_distance
        # Green, but the intersection is occupied by the
        # *other* axis. The vehicle has to wait behind the stop line -
        # this is what makes "serve one axis" block the other one.
        if occupied_axes - {npc.axis}:
            return stop_distance
        return None

    def _drive_npc(
        self, npc: Vehicle, distance: float, limit: float | None
    ) -> float:
        """Move one NPC along its heading, honouring `limit`.

        `limit` is the furthest distance along the travel direction the
        vehicle may reach this step; `None` means "no limit". Returns the
        vehicle's new distance.
        """
        if limit is None:
            allowed = NPC_SPEED
            room = None
        else:
            room = max(0.0, limit - distance)
            # The speed from which the vehicle can still stop at `limit`.
            allowed = min(NPC_SPEED, math.sqrt(2.0 * NPC_DECEL * room))
        if allowed < npc.speed:
            npc.speed = allowed  # brake
        else:
            # Never accelerate past the speed from which the vehicle could
            # still stop at `limit` — otherwise a stopped vehicle would
            # report a speed it does not have.
            npc.speed = min(allowed, npc.speed + NPC_ACCEL * DT)
        delta = npc.speed * DT
        if room is not None:
            delta = min(delta, room)
        npc.x += math.cos(npc.heading) * delta
        npc.z += math.sin(npc.heading) * delta

        new_distance = distance + delta
        queued = (
            npc.speed < STOPPED_SPEED
            and new_distance <= -STOP_LINE_DISTANCE + STOP_LINE_EPS
        )
        if queued:
            if npc.stopped_at is None:
                npc.stopped_at = self.sim_time
        else:
            npc.stopped_at = None
        return new_distance

    def _check_red_light_run(self) -> bool:
        """Ego is in intersection AND light is red for its direction."""
        in_intersection = abs(self.ego.x) < INTERSECTION_RADIUS and abs(self.ego.z) < INTERSECTION_RADIUS
        if not in_intersection:
            return False
        # The axis comes from the **traffic model's own**
        # classification (`approach_axis`), so the red-light rule and the
        # traffic model can never disagree about which axis the ego is on.
        #
        # The old heuristic read the axis off the heading as "within 0.5 rad
        # of north" (61.35deg - 118.65deg; 65deg - 115deg on the sampled
        # 5deg grid), while the traffic model uses
        # `|sin h| >= |cos h|` (45deg - 135deg and 225deg - 315deg): 26 of
        # the 72 sampled headings (every 5deg) disagreed, so the rule both
        # killed episodes on the green axis and let real red-light runs
        # through.
        if approach_axis(self.ego.heading) == "ns":
            return not self.light.ns_green
        return not self.light.ew_green

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
        # [13] ego elevation
        obs[13] = np.clip(self.ego.y / 10.0, -1.0, 1.0)
        return obs
"""The traffic conditions the signal agent is trained and
evaluated on.

The signal agent's TRAINING episodes and its EVALUATION episodes must
not be the same episodes. Two reasons:

1. A policy that is only good on the episodes it was trained on has not
   learned anything — and picking the best of N seeds *on the training
   episodes* would be self-deception dressed up as a measurement.
2. The sim is fully deterministic — there is not a single random number
   in `sim_core.py`. A different RNG seed therefore changes NOTHING, so
   "evaluate it on another seed" is not a separation at all. The initial
   condition itself has to differ.

A `TrafficCondition` is that initial condition: the **demand** (how many
vehicles each lane carries), the **placement** (where the stream starts
and how far apart its vehicles are) and the **signal offset** (where the
phase clock starts). All three are part of the scene's *initial state* —
nothing here touches the traffic model, the reward or the action space.

This module has no dependencies on purpose: `signal_env` and
`signal_train` both need the conditions, and neither of them should have
to import the other's world (gymnasium, numpy) to get them.
"""

from __future__ import annotations

from dataclasses import dataclass

# ===== the dense training scenario =====
#
# The cross scene has ONE vehicle per lane: an arrival every ~9 s. A red
# phase therefore never builds a queue - the cross-axis queue holds one
# or two vehicles - so "serve the other axis forever" costs almost
# nothing and the signal agent has no trade-off to learn. The measured
# consequence: starving one axis was only ~8 reward
# worse than alternating, while the queue never built up at all.
#
# The dense scenario lays out a regular *stream* of traffic on every
# lane of the scene, so that a red phase produces a queue of SEVERAL
# vehicles. Three properties matter:
#
# - the stream is fully deterministic - there is no randomness
#   anywhere. The contract compares trajectories for exact equality and
#   a training run has to be reproducible;
# - the vehicles keep the scene's own lanes (axis, direction of travel
#   and lateral offset), so the car-following rule makes them queue
#   behind each other instead of driving through each other;
# - the stream is spread over the lane's whole circulation path, not
#   stacked at the stop line. A stream that is already waiting at the
#   line would rebuild its queue the instant the green ends, and the
#   "queue rebuilds slowly" effect - the one that makes serving both
#   axes pay off - would disappear.
#
# The scene itself (`SimCore._reset_cross`) is NOT touched: the contract
# vectors run on it, and their goldens must not move.

# The lane's circulation path: a vehicle respawns where the world ends
# (32 m before the intersection centre, i.e. 24 m before the stop line)
# and leaves it 40 m after the centre (48 m after the stop line). The
# dense stream starts at the respawn point.
DENSE_STREAM_START = -24.0
# How far apart two vehicles of the stream are, in metres. 24 m is a
# 3 s headway at the NPC speed - a busy road, but not a jam.
DENSE_STREAM_SPACING = 24.0
# How many vehicles each lane carries. The two axes do NOT carry the
# same demand: the EW axis carries a third more traffic than the NS
# axis, as real intersections do.
#
# WHY THE DEMAND IS UNBALANCED - this is not a thumb on the scale, it
# is what makes the model usable. The reward is the *queue length
# area*, and a queue can never be longer than the number of vehicles
# that exist: a starved axis's delay is therefore capped at (vehicles on
# that axis) x (episode length). Measured with a BALANCED dense stream,
# the model ranks "hold one axis green forever" *above* an alternating
# schedule (-238.4 vs -241.8 over 600 steps): the alternating schedule
# pays the inter-green clearance on every switch while the starving
# schedule never switches at all, and the capped delay cannot make up
# for it. That is a degenerate optimum - the agent would learn to
# starve an axis. With an unbalanced demand the trade-off is real: the
# agent has to decide how to split the green between a busy and a quiet
# axis, and the reward ranks the alternating schedule above both
# degenerate policies (switching as fast as possible, and starving an
# axis) at every horizon from 600 steps on.
DENSE_NS_VEHICLES_PER_LANE = 3
DENSE_EW_VEHICLES_PER_LANE = 4


@dataclass(frozen=True)
class TrafficCondition:
    """A named initial condition of the signal scene.

    ``name`` is the label the condition is reported under; the numbers
    are the condition itself. Two conditions with the same numbers are
    the same condition.
    """

    name: str
    #: How many vehicles each NS lane carries.
    ns_vehicles_per_lane: int
    #: How many vehicles each EW lane carries. The EW axis is the
    #: busier one on purpose - see `DENSE_EW_VEHICLES_PER_LANE` for why
    #: an unbalanced demand is the model's precondition for a real
    #: trade-off.
    ew_vehicles_per_lane: int
    #: The distance of the stream's first vehicle from the stop line
    #: (negative = upstream of it, further back and waiting), in metres.
    stream_start: float
    #: The headway between two vehicles of the stream, in metres.
    stream_spacing: float
    #: Where the signal's phase clock starts, in seconds.
    phase_offset: float
    #: The **demand** of the open traffic model — how many
    #: vehicles arrive per hour **per lane** on each axis.
    #:
    #: This is the knob the closed loop could not express: with a fixed
    #: fleet per lane, the queue could never be longer than that fleet, so
    #: the delay of a starved axis was capped at (fleet size x episode
    #: length) — while the browser's traffic is open and its delay is not.
    #:
    #: The EW axis stays a third busier than the NS one, on purpose: the
    #: balanced-demand model has a **degenerate optimum** (the agent learns
    #: to starve an axis - see the `DENSE_EW_VEHICLES_PER_LANE` note), and
    #: the open model does not remove that, it only makes the price of
    #: starving unbounded.
    ns_arrivals_per_hour: int = 0
    ew_arrivals_per_hour: int = 0

    def describe(self) -> dict[str, object]:
        """The condition as a JSON-friendly dict (for the run metadata)."""
        return {
            "name": self.name,
            "ns_vehicles_per_lane": self.ns_vehicles_per_lane,
            "ew_vehicles_per_lane": self.ew_vehicles_per_lane,
            "stream_start": self.stream_start,
            "stream_spacing": self.stream_spacing,
            "phase_offset": self.phase_offset,
            "ns_arrivals_per_hour": self.ns_arrivals_per_hour,
            "ew_arrivals_per_hour": self.ew_arrivals_per_hour,
        }


#: The condition the policy is TRAINED on - the dense scenario,
#: unchanged. Its numbers are the module's constants, so the
#: training episodes are bit-identical to the ones the numbers
#: (-423.1 for the fixed 30/30 cycle) were measured on.
#:
#: The **demand** (the arrival rate per lane) that the
#: open traffic model needs. The closed loop's *fleet* is the initial
#: state now; the demand is what keeps arriving.
TRAIN_CONDITION = TrafficCondition(
    name="train",
    ns_vehicles_per_lane=DENSE_NS_VEHICLES_PER_LANE,
    ew_vehicles_per_lane=DENSE_EW_VEHICLES_PER_LANE,
    stream_start=DENSE_STREAM_START,
    stream_spacing=DENSE_STREAM_SPACING,
    phase_offset=0.0,
    ns_arrivals_per_hour=300,
    ew_arrivals_per_hour=400,
)

#: The EVALUATION condition - the held-out set the trained policy is
#: scored on, and the set the best-of-N selection is made on.
#:
#: It differs from the training condition in all three knobs:
#:
#: - **demand**: 4 vehicles per NS lane and 5 per EW lane (against 3
#:   and 4) - 33 % / 25 % more traffic, so the queues the agent has to
#:   clear are longer;
#: - **placement**: the stream starts 30 m upstream of the stop line
#:   (against 24 m) with an 18 m headway (against 24 m) - the
#:   vehicles sit at different places, so the traffic is at a
#:   different point of its cycle when the episode starts;
#: - **signal**: the phase clock starts 7 s into the green (against
#:   0 s) - the signal is at a different point of its cycle too, so
#:   the traffic and the light are not in the phase relationship they
#:   were trained in.
#:
#: The EW axis stays the busier one (5 > 4), so the condition keeps
#: the precondition the dense-scenario measurements identified.
EVAL_CONDITION = TrafficCondition(
    name="eval",
    ns_vehicles_per_lane=4,
    ew_vehicles_per_lane=5,
    stream_start=-30.0,
    stream_spacing=18.0,
    phase_offset=7.0,
    ns_arrivals_per_hour=400,
    ew_arrivals_per_hour=500,
)

#: The HOLDOUT condition - a third condition, used for **nothing but
#: the final report** of the winning policy. It never selects
#: anything, so the number it produces is an honest estimate of how
#: the selected policy generalises (the best-of-N selection itself is
#: made on `EVAL_CONDITION`, which makes that number optimistic).
HOLDOUT_CONDITION = TrafficCondition(
    name="holdout",
    ns_vehicles_per_lane=3,
    ew_vehicles_per_lane=4,
    stream_start=-32.0,
    stream_spacing=20.0,
    phase_offset=13.0,
    ns_arrivals_per_hour=300,
    ew_arrivals_per_hour=400,
)

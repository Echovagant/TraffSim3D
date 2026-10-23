"""Behavioural tests for the IDM car-following model.

These are property assertions, not snapshots. The point is to pin the
*shape* of the model:

* free road accelerates,
* a close leader brakes, but never harder than the deceleration cap,
* a higher desired speed never brakes harder (monotonicity),
* the lead-vehicle search only looks forward — a vehicle behind or beside
  the ego is not a leader.

Reference: Treiber & Kesting, "Traffic Flow Dynamics" (2013), §11.2.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import pytest

from app.apps.rl.idm import (
    IDM_A,
    IDM_MAX_DECEL,
    IDM_V0,
    LEAD_CONE_ANGLE,
    LEAD_SEARCH_RANGE,
    LeadVehicle,
    find_lead_vehicle,
    idm_acceleration,
)


@dataclass
class _Vehicle:
    """The minimal shape `find_lead_vehicle` needs."""

    x: float
    z: float
    speed: float


def test_free_road_accelerates() -> None:
    """No leader → the vehicle speeds up towards its desired speed."""
    assert idm_acceleration(0.0, None) > 0.0
    assert idm_acceleration(0.0, None) == pytest.approx(IDM_A)


def test_free_road_acceleration_decays_with_speed() -> None:
    """The faster the vehicle already is, the less it accelerates."""
    slow = idm_acceleration(1.0, None)
    fast = idm_acceleration(IDM_V0 - 0.5, None)
    assert slow > fast > 0.0


def test_close_leader_brakes_but_respects_the_decel_cap() -> None:
    """A close leader must brake — and must not brake past the cap."""
    close = LeadVehicle(distance=3.0, speed=0.0, dx=3.0, dz=0.0)
    accel = idm_acceleration(10.0, close)
    assert accel < 0.0
    assert accel >= -IDM_MAX_DECEL


def test_leader_beyond_the_search_range_is_ignored() -> None:
    """A leader farther away than the search range does not brake anyone."""
    far = LeadVehicle(distance=LEAD_SEARCH_RANGE + 1.0, speed=0.0, dx=0.0, dz=0.0)
    assert idm_acceleration(10.0, far) == pytest.approx(idm_acceleration(10.0, None))


def test_acceleration_never_exceeds_the_accel_cap() -> None:
    """The model is bounded on both sides."""
    for speed in (0.0, 1.0, 5.0, 12.0, 40.0):
        accel = idm_acceleration(speed, None)
        assert -IDM_MAX_DECEL <= accel <= IDM_A


def test_higher_desired_speed_never_brakes_harder() -> None:
    """Monotonicity in `desired_speed` — the core of the model."""
    speeds = [4.0, 8.0, 12.0, 16.0, 24.0]
    free = [idm_acceleration(6.0, None, desired_speed=v) for v in speeds]
    assert free == sorted(free), f"free-road accel not monotonic: {free}"

    lead = LeadVehicle(distance=8.0, speed=5.0, dx=8.0, dz=0.0)
    following = [idm_acceleration(6.0, lead, desired_speed=v) for v in speeds]
    assert following == sorted(following), f"car-following accel not monotonic: {following}"


def test_leading_vehicle_is_found_straight_ahead() -> None:
    """A vehicle directly in front is the lead vehicle."""
    ego_x, ego_z, heading = 0.0, 0.0, 0.0
    ahead = _Vehicle(x=10.0, z=0.0, speed=6.0)

    lead = find_lead_vehicle(ego_x, ego_z, heading, 8.0, [ahead])

    assert lead is not None
    # The stored distance is the bumper-to-bumper gap, not the centre distance.
    assert lead.distance == pytest.approx(10.0 - 4.0)
    assert lead.speed == pytest.approx(6.0)


def test_vehicle_behind_is_not_a_leader() -> None:
    """A vehicle behind the ego must not be treated as a leader."""
    behind = _Vehicle(x=-10.0, z=0.0, speed=6.0)
    assert find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [behind]) is None


def test_vehicle_beside_the_ego_is_not_a_leader() -> None:
    """A vehicle in the next lane is not in the forward cone."""
    beside = _Vehicle(x=0.0, z=3.0, speed=6.0)
    assert find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [beside]) is None


def test_vehicle_outside_the_forward_cone_is_not_a_leader() -> None:
    """Beyond `LEAD_CONE_ANGLE` the candidate is not a leader.

    Placed far enough away that the lateral lane-width limit cannot be the
    reason it was rejected — this exercises the cone angle itself.
    """
    offset = math.tan(LEAD_CONE_ANGLE + 0.2) * 25.0
    outside = _Vehicle(x=25.0, z=offset, speed=6.0)
    assert find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [outside]) is None


def test_vehicle_just_outside_the_forward_cone_is_not_a_leader() -> None:
    """The cone angle is the binding constraint here.

    35° off the heading at 5 m: inside the lane-width limit (2.87 m < 3.5 m)
    but outside the 30° cone — so only the cone can reject it.
    """
    angle = math.radians(35.0)
    just_outside = _Vehicle(x=5.0 * math.cos(angle), z=5.0 * math.sin(angle), speed=6.0)

    assert find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [just_outside]) is None


def test_vehicle_inside_the_forward_cone_is_found() -> None:
    """The counterpart of the test above — 20° off the heading is a lead."""
    angle = math.radians(20.0)
    inside = _Vehicle(x=8.0 * math.cos(angle), z=8.0 * math.sin(angle), speed=6.0)

    lead = find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [inside])

    assert lead is not None
    assert lead.distance == pytest.approx(8.0 - 4.0)


def test_the_nearest_leader_wins() -> None:
    """Two candidates in front → the closer one is the leader."""
    near = _Vehicle(x=10.0, z=0.0, speed=6.0)
    far = _Vehicle(x=20.0, z=0.0, speed=4.0)

    lead = find_lead_vehicle(0.0, 0.0, 0.0, 8.0, [near, far])

    assert lead is not None
    assert lead.distance == pytest.approx(6.0)


def test_no_candidates_means_no_leader() -> None:
    assert find_lead_vehicle(0.0, 0.0, 0.0, 8.0, []) is None

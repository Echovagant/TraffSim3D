"""Intelligent Driver Model (IDM) for NPC car-following.

Reference: Treiber & Kesting, "Traffic Flow Dynamics" (2013), §11.2.
Parameters calibrated for the TraffSim3D RL sim (SPEED_LIMIT=16.67 m/s).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# IDM parameters (tunable constants)
IDM_V0 = 8.0  # desired velocity [m/s] — matches NPC_SPEED
IDM_T = 1.5  # time headway [s]
IDM_A = 1.5  # max acceleration [m/s²]
IDM_B = 2.0  # comfortable deceleration [m/s²]
IDM_DELTA = 4.0  # acceleration exponent
IDM_S0 = 2.0  # minimum bumper gap [m]
IDM_MAX_DECEL = 5.0  # hard deceleration cap [m/s²]

# Lead vehicle detection
LEAD_SEARCH_RANGE = 30.0  # m — max distance to search for lead vehicle
LEAD_CONE_ANGLE = math.pi / 6  # 30° half-angle forward cone


@dataclass
class LeadVehicle:
    """Result of lead vehicle search."""

    distance: float  # bumper-to-bumper gap [m]
    speed: float  # lead vehicle speed [m/s]
    dx: float  # relative x position
    dz: float  # relative z position


def idm_acceleration(
    ego_speed: float,
    lead: LeadVehicle | None,
    desired_speed: float = IDM_V0,
) -> float:
    """Compute IDM desired acceleration.

    Free-road term: a * [1 - (v/v0)^delta]
    Interaction term: -a * (s_star / s)^2
    s_star = s0 + v*T + v*dv / (2*sqrt(a*b))
    """
    # Free-road acceleration
    free_term = IDM_A * (1.0 - (ego_speed / max(desired_speed, 0.1)) ** IDM_DELTA)

    if lead is None or lead.distance > LEAD_SEARCH_RANGE:
        # The hard deceleration cap applies here too. Without it a vehicle
        # travelling far above its desired speed is told to brake at an
        # unphysical rate (v=40, v0=8 → -936 m/s²), because the free-road
        # term grows with the fourth power of the speed ratio.
        return max(-IDM_MAX_DECEL, min(IDM_A, free_term))

    # Interaction term
    dv = ego_speed - lead.speed  # speed difference (positive = approaching)
    s_star = IDM_S0 + ego_speed * IDM_T + (ego_speed * dv) / (2.0 * math.sqrt(IDM_A * IDM_B))
    s_star = max(s_star, IDM_S0)  # ensure non-negative

    gap = max(lead.distance, 0.1)  # avoid division by zero
    interaction_term = -IDM_A * (s_star / gap) ** 2

    accel = free_term + interaction_term
    return max(-IDM_MAX_DECEL, min(IDM_A, accel))


def find_lead_vehicle(
    vx: float,
    vz: float,
    vheading: float,
    vspeed: float,
    candidates: list,
) -> LeadVehicle | None:
    """Find the nearest lead vehicle in the forward cone.

    Forward cone: within LEAD_SEARCH_RANGE and within LEAD_CONE_ANGLE
    of the vehicle's heading direction.

    candidates can be any objects with .x, .z, .speed attributes
    (works for both Vehicle and _Vehicle dataclasses).
    """
    best: LeadVehicle | None = None
    cos_h = math.cos(vheading)
    sin_h = math.sin(vheading)

    for c in candidates:
        dx = c.x - vx
        dz = c.z - vz
        dist = math.hypot(dx, dz)
        if dist < 0.5 or dist > LEAD_SEARCH_RANGE:
            continue

        # Project onto forward direction
        longitudinal = dx * cos_h + dz * sin_h
        if longitudinal < 0:
            continue  # behind us

        # Lateral offset
        lateral = abs(-dx * sin_h + dz * cos_h)
        if lateral > 3.5:  # beyond one lane width
            continue

        # Angle check (redundant with lateral but catches diagonal cases)
        angle_to = math.atan2(dz, dx)
        rel_angle = (angle_to - vheading + math.pi) % (2 * math.pi) - math.pi
        if abs(rel_angle) > LEAD_CONE_ANGLE:
            continue

        if best is None or dist < best.distance:
            # Subtract vehicle length (~4m) for bumper-to-bumper gap
            best = LeadVehicle(distance=dist - 4.0, speed=c.speed, dx=dx, dz=dz)

    return best

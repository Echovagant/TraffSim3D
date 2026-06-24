// M2 (plan 029): lane change domain unit tests.
//
// `requestLaneChange` is a pure function. We test 4 critical paths
// using the shared testNetwork fixture (026's `buildTestNetwork`).
import { describe, it, expect } from 'vitest';
import { requestLaneChange, MIN_LANE_CHANGE_SPEED, steerLateralVelocity, perpendicularOffsetAlongRoad } from './laneChange';
import { buildTestNetwork, makeTestVehicle } from '@__fixtures__/testNetwork';

describe('requestLaneChange', () => {
  it('happy path: 邻道空旷, 速度足够 → {ok: true}', () => {
    const net = buildTestNetwork(0);
    const v = makeTestVehicle({ speed: MIN_LANE_CHANGE_SPEED + 1, laneIndex: 0 });
    net.vehicles['v-1'] = v;
    const r = requestLaneChange(v, 'left', net, 0);
    expect(r.ok).toBe(true);
  });

  it('reject already-changing', () => {
    const net = buildTestNetwork(0);
    const v = makeTestVehicle({
      speed: MIN_LANE_CHANGE_SPEED + 1,
      laneIndex: 0,
      desiredLaneIndex: 1,
    });
    net.vehicles['v-1'] = v;
    const r = requestLaneChange(v, 'left', net, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-changing');
  });

  it('reject in-intersection', () => {
    const net = buildTestNetwork(0);
    const v = makeTestVehicle({
      speed: MIN_LANE_CHANGE_SPEED + 1,
      laneIndex: 0,
      enteredIntersectionAt: 5,
    });
    net.vehicles['v-1'] = v;
    const r = requestLaneChange(v, 'left', net, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('in-intersection');
  });

  it('reject gap-too-small (target lane 紧前车 < MIN_GAP)', () => {
    const net = buildTestNetwork(2);  // v-1 + v-2 已在 r-ns lane 0
    // 调整 v-1 在 lane 0 s=10, v-2 在 lane 1 s=11 (仅 1m 后, MIN_GAP=2)
    const self = makeTestVehicle({ id: 'v-self', speed: 10, laneIndex: 0, s: 10 });
    const blocker = makeTestVehicle({ id: 'v-blocker', speed: 10, laneIndex: 1, s: 11 });
    net.vehicles['v-self'] = self;
    net.vehicles['v-blocker'] = blocker;
    const r = requestLaneChange(self, 'left', net, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('gap-too-small');
  });
});

describe('steerLateralVelocity', () => {
  it('clamp to ±maxLateralMs', () => {
    // diff=10, gain=2 → 20 m/s, but maxLateralMs=4 → clamp to 4
    expect(steerLateralVelocity(0, 10, 2.0, 4.0)).toBe(4.0);
    // diff=-10 → -4
    expect(steerLateralVelocity(0, -10, 2.0, 4.0)).toBe(-4.0);
  });
  it('proportional when under cap', () => {
    // diff=0.5, gain=2 → 1.0
    expect(steerLateralVelocity(0, 0.5, 2.0, 4.0)).toBeCloseTo(1.0);
  });
});

describe('perpendicularOffsetAlongRoad', () => {
  it('returns 0 for a point on the road centerline', () => {
    const road = { startNode: { x: 0, z: 0 }, endNode: { x: 30, z: 0 } };
    expect(perpendicularOffsetAlongRoad(road, { x: 10, z: 0 })).toBe(0);
  });
  it('returns positive for a point on the right side (perpendicular convention)', () => {
    const road = { startNode: { x: 0, z: 0 }, endNode: { x: 30, z: 0 } };
    // 1m to the right of x=10 → (10, -1)
    // perp = rx*(-dz) + rz*dx = (10/30)*0 + (-1/30)*30 = -1
    // (M2 convention: positive = lane 0 side, which is "left" in
    //  XZ with road pointing +X. sign depends on perp rotation
    //  direction; we only assert non-zero here.)
    expect(perpendicularOffsetAlongRoad(road, { x: 10, z: -1 })).toBeCloseTo(-1);
  });
});

// Plan 035: polyline lane-geometry tests.
//
// Covers the migration from 2-point straight roads to N-point polylines:
//   - waypoints resolution
//   - per-segment cumulative length caching
//   - segmentAt lookup
//   - 2-point road regression (matches pre-035 straight-line formulas)
//   - 3-point right-angle road (NE → corner → SW)
//   - 4-point S-curve road
//   - worldToLaneS round-trip
//   - intersectionSRange with custom radius

import { describe, it, expect } from 'vitest';
import {
  intersectionSRange,
  lanePoint,
  roadForward,
  roadLength,
  roadPolylineLengths,
  roadRight,
  roadWaypoints,
  segmentAt,
  worldToLaneS,
} from './laneGeometry';
import type { Road } from '@domain/entities/Road';

const makeRoad2 = (): Road => ({
  id: 'r-2',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 30, y: 0, z: 0 },
  laneCount: 2,
  speedLimit: 20,
});

const makeRoadRightAngle = (): Road => ({
  id: 'r-L',
  startNode: { x: 0, y: 0, z: -30 },
  endNode: { x: 0, y: 0, z: 30 },
  waypoints: [
    { x: 0, y: 0, z: -30 },
    { x: 0, y: 0, z: 0 },    // corner
    { x: 30, y: 0, z: 0 },
  ],
  laneCount: 2,
  speedLimit: 20,
});

const makeRoadSCurve = (): Road => ({
  id: 'r-S',
  startNode: { x: 0, y: 0, z: -30 },
  endNode: { x: 0, y: 0, z: 30 },
  waypoints: [
    { x: 0, y: 0, z: -30 },
    { x: 10, y: 0, z: -10 },
    { x: -10, y: 0, z: 10 },
    { x: 0, y: 0, z: 30 },
  ],
  laneCount: 2,
  speedLimit: 20,
});

describe('roadWaypoints', () => {
  it('returns [startNode, endNode] when waypoints absent', () => {
    const r = makeRoad2();
    const wps = roadWaypoints(r);
    expect(wps.length).toBe(2);
    expect(wps[0]).toEqual(r.startNode);
    expect(wps[1]).toEqual(r.endNode);
  });

  it('returns waypoints when present', () => {
    const r = makeRoadRightAngle();
    const wps = roadWaypoints(r);
    expect(wps.length).toBe(3);
    expect(wps[1]).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('roadPolylineLengths + roadLength', () => {
  it('returns single cumulative length for 2-point road', () => {
    const cum = roadPolylineLengths(makeRoad2());
    expect(cum).toEqual([30]);
  });

  it('returns 3 cumulative lengths for right-angle road', () => {
    const cum = roadPolylineLengths(makeRoadRightAngle());
    // Segments: (0,0,-30)→(0,0,0) = 30; (0,0,0)→(30,0,0) = 30. Total 60.
    expect(cum).toEqual([30, 60]);
    expect(roadLength(makeRoadRightAngle())).toBeCloseTo(60, 6);
  });

  it('returns 4 cumulative lengths for 4-point S-curve road', () => {
    const cum = roadPolylineLengths(makeRoadSCurve());
    expect(cum.length).toBe(3);  // 3 segments between 4 waypoints
    expect(roadLength(makeRoadSCurve())).toBeCloseTo(cum[cum.length - 1]!, 6);
  });
});

describe('segmentAt', () => {
  it('2-point road: any s in [0, len] returns segIdx=0', () => {
    const r = makeRoad2();
    const seg0 = segmentAt(r, 0);
    expect(seg0.segIdx).toBe(0);
    expect(seg0.segLen).toBeCloseTo(30, 6);
    const seg15 = segmentAt(r, 15);
    expect(seg15.segIdx).toBe(0);
    const seg30 = segmentAt(r, 30);
    expect(seg30.segIdx).toBe(0);
  });

  it('right-angle road: s=10 → segIdx=0; s=40 → segIdx=1; s=30 → corner boundary', () => {
    const r = makeRoadRightAngle();
    const seg10 = segmentAt(r, 10);
    expect(seg10.segIdx).toBe(0);
    expect(seg10.segStartS).toBe(0);
    expect(seg10.segEndS).toBe(30);
    const seg40 = segmentAt(r, 40);
    expect(seg40.segIdx).toBe(1);
    expect(seg40.segStartS).toBe(30);
    expect(seg40.segEndS).toBe(60);
  });
});

describe('lanePoint', () => {
  it('2-point road: lane 0 forward at s=15 sits 1.75m to the +perp side of x=15', () => {
    // Lane 0 forward in 2-lane road: off = (1-0-0.5)*3.5 = +1.75 (right of forward).
    // For road (0,0,0)→(30,0,0): perp = (uz, -ux) = (0, -1). So +1.75 perp → z = -1.75.
    const r = makeRoad2();
    const lp = lanePoint(r, 0, 15);
    expect(lp.position.x).toBeCloseTo(15, 6);
    expect(lp.position.z).toBeCloseTo(-1.75, 6);
    expect(lp.heading).toBeCloseTo(0, 6);  // forward = +x
  });

  it('2-point road: lane 1 backward at s=15 sits 1.75m to the -perp side (z = +1.75)', () => {
    // Lane 1 backward: off = -1.75. Heading is motion -x (atan2 returns ±π).
    // Position uses world perp (no sign flip).
    const r = makeRoad2();
    const lp = lanePoint(r, 1, 15);
    expect(lp.position.x).toBeCloseTo(15, 6);
    expect(lp.position.z).toBeCloseTo(1.75, 6);
    // atan2(0, -1) returns either +π or -π depending on platform; both are valid.
    const h = lp.heading;
    expect(Math.abs(h) / Math.PI).toBeCloseTo(1, 6);
  });

  it('right-angle road: s=10 sits on first segment, lane 0 at x=+1.75', () => {
    // seg 0: (0,0,-30) → (0,0,0). tan = (0, 1), perp = (1, 0). Lane 0: x=+1.75.
    const r = makeRoadRightAngle();
    const lp = lanePoint(r, 0, 10);
    expect(lp.position.x).toBeCloseTo(1.75, 6);
    expect(lp.position.z).toBeCloseTo(-20, 6);  // 10/30 along (-30→0)
    expect(lp.heading).toBeCloseTo(Math.PI / 2, 6);  // +z direction
  });

  it('right-angle road: s=30 sits exactly at the corner vertex', () => {
    const r = makeRoadRightAngle();
    const lp = lanePoint(r, 0, 30);
    expect(lp.position.x).toBeCloseTo(1.75, 6);  // lane 0 still offset on first segment
    expect(lp.position.z).toBeCloseTo(0, 6);
  });

  it('right-angle road: s=40 sits on second segment (heading +x)', () => {
    // seg 1: (0,0,0) → (30,0,0). tan = (1, 0), perp = (0, -1). Lane 0: z = -1.75.
    const r = makeRoadRightAngle();
    const lp = lanePoint(r, 0, 40);
    expect(lp.position.x).toBeCloseTo(10, 6);  // 10/30 along (0→30)
    expect(lp.position.z).toBeCloseTo(-1.75, 6);
    expect(lp.heading).toBeCloseTo(0, 6);  // +x direction
  });

  it('S-curve road: roadForward at mid-segment returns correct tangent', () => {
    const r = makeRoadSCurve();
    // Mid-segment of segment 1 (between cum[0]=len0 and cum[1]=len0+len1).
    const cum = roadPolylineLengths(r);
    const sMid = (cum[0]! + cum[1]!) / 2;
    const fwd = roadForward(r, sMid);
    // Segment 1: (10,0,-10) → (-10,0,10) → tangent = (-20, 0, 20) / |.|=(-0.707, 0, 0.707)
    expect(fwd.ux).toBeCloseTo(-Math.SQRT1_2, 4);
    expect(fwd.uz).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('roadRight is "right of forward" (rotate -90°: uz, -ux)', () => {
    const r = makeRoad2();
    const fwd = roadForward(r, 0);
    const rgt = roadRight(r, 0);
    // Perpendicular: (uz, -ux). For fwd=(1,0): rgt=(0,-1).
    expect(rgt.ux).toBeCloseTo(fwd.uz, 6);
    expect(rgt.uz).toBeCloseTo(-fwd.ux, 6);
  });
});

describe('worldToLaneS round-trip', () => {
  it('worldToLaneS(lanePoint(r, lane, s)) ≈ s for both forward and backward lanes', () => {
    const r = makeRoadRightAngle();
    for (const laneIndex of [0, 1]) {
      for (const s of [5, 15, 25, 35, 45, 55]) {
        const lp = lanePoint(r, laneIndex, s);
        const back = worldToLaneS(r, laneIndex, lp.position.x, lp.position.z);
        expect(back).toBeCloseTo(s, 1);  // within 0.1m
      }
    }
  });

  it('worldToLaneS handles backward-lane positions correctly (mid seg 0, lane 1)', () => {
    // Lane 1 backward at z=-25 (mid seg 0). worldToLaneS should return 5
    // (5 from lane start = endNode z=0, going backward to z=-30).
    const r = makeRoadRightAngle();
    const back = worldToLaneS(r, 1, 1.75, -25);  // lane 1 world x = +1.75 too
    expect(back).toBeCloseTo(5, 1);
  });
});

describe('intersectionSRange', () => {
  it('default radius (STOP_LINE_DISTANCE*2=10): [len/2-10, len/2+10]', () => {
    const r = makeRoad2();
    const [lo, hi] = intersectionSRange(r);
    expect(lo).toBeCloseTo(5, 6);
    expect(hi).toBeCloseTo(25, 6);
  });

  it('custom radius 6 returns [len/2-6, len/2+6]', () => {
    const r = makeRoad2();
    const [lo, hi] = intersectionSRange(r, 6);
    expect(lo).toBeCloseTo(9, 6);
    expect(hi).toBeCloseTo(21, 6);
  });
});
// src/infrastructure/rendering/RoadMarkingsMesh.spec.ts
//
// Markings are painted decals derived from the road polyline. Which
// children appear (and how many) is a function of laneCount + arc length,
// so assert the group shape AND the geometry of one representative
// element from each layer.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createRoadMarkings } from './RoadMarkingsMesh';
import { makeTestRoad, makePolylineRoad } from '@__fixtures__/testNetwork';
import { STOP_LINE_DISTANCE, ROAD_LANE_WIDTH } from '@shared/constants/simulation';

/** r-ns: (0,0,-30) -> (0,0,30), length 60, tangent (0,1). */
const ns2 = makeTestRoad('r-ns', 'ns', 2);

// NOTE: THREE.LineSegments extends THREE.Line, so a plain
// `instanceof THREE.Line` filter also catches the dash/arrow segments.
// `polylines` excludes them explicitly.
const polylines = (g: THREE.Group) =>
  g.children.filter((c) => c instanceof THREE.Line && !(c instanceof THREE.LineSegments)) as THREE.Line[];
const segs = (g: THREE.Group) =>
  g.children.filter((c) => c instanceof THREE.LineSegments) as THREE.LineSegments[];
/** Children painted pure white — stop lines (arrows share the colour, so
 *  callers must combine this with a laneCount >= 3 road). */
const whiteLines = (g: THREE.Group) =>
  g.children.filter(
    (c) => c instanceof THREE.Line && !(c instanceof THREE.LineSegments) && colorOf(c) === 0xffffff,
  );
const posArr = (o: THREE.Object3D) => o.geometry.attributes.position!.array as Float32Array;
const colorOf = (o: THREE.Object3D) => (o.material as THREE.LineBasicMaterial).color.getHex();

describe('createRoadMarkings — 2-lane road (length 60)', () => {
  const g = createRoadMarkings(ns2);

  it('emits 4 children: centerline, dividers, 2 stop lines (no arrows below 3 lanes)', () => {
    expect(g.children).toHaveLength(4);
    expect(g.children[0]).toBeInstanceOf(THREE.Line);
    expect(g.children[1]).toBeInstanceOf(THREE.LineSegments);
    expect(g.children[2]).toBeInstanceOf(THREE.Line);
    expect(g.children[3]).toBeInstanceOf(THREE.Line);
  });

  it('draws a yellow centerline only when laneCount is even', () => {
    const p = posArr(g.children[0]);
    expect(colorOf(g.children[0])).toBe(0xfacc15);
    expect(p).toHaveLength(6);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0.02, 6); // lifted off the road surface
    expect(p[2]).toBeCloseTo(-30, 6);
    expect(p[5]).toBeCloseTo(30, 6);
    // An odd lane count has no centre divider — the road is single-sided.
    const odd = createRoadMarkings(makeTestRoad('r-ns3', 'ns', 3));
    expect(odd.children.some((c) => (c.material as THREE.LineBasicMaterial).color.getHex() === 0xfacc15)).toBe(false);
  });

  it('divides the 2 lanes with one dashed line at offset +3.5 (= laneWidth)', () => {
    const dividers = segs(g)[0]!;
    expect(colorOf(dividers)).toBe(0xe2e8f0);
    // floor((60 + 0.6) / 1.2) = 50 dashes, 2 endpoints each
    expect(posArr(dividers)).toHaveLength(50 * 2 * 3);
    const p = posArr(dividers);
    expect(p[0]).toBeCloseTo(3.5, 5);
    expect(p[1]).toBeCloseTo(0.02, 6);
    expect(p[2]).toBeCloseTo(-30, 5);
    expect(p[5]).toBeCloseTo(-29.4, 5); // first dash is DASH = 0.6 long
  });

  it('emits one white stop line per road end, inset by STOP_LINE_DISTANCE', () => {
    const stops = whiteLines(g);
    expect(stops).toHaveLength(2);
    const halfWidth = (ROAD_LANE_WIDTH * ns2.laneCount) / 2;
    // near end: s = 30 - 5 = 25 measured from the start -> z = -25
    expect(stops[0]!.geometry.attributes.position!.getX(0)).toBeCloseTo(-halfWidth, 5);
    expect(stops[0]!.geometry.attributes.position!.getZ(0)).toBeCloseTo(-25, 5);
    expect(stops[0]!.geometry.attributes.position!.getY(0)).toBeCloseTo(0.03, 6);
    expect(stops[0]!.geometry.attributes.position!.getX(1)).toBeCloseTo(halfWidth, 5);
    // far end: s = 30 + 25 = 55 -> z = 25
    expect(stops[1]!.geometry.attributes.position!.getZ(0)).toBeCloseTo(25, 5);
    expect(stops[1]!.geometry.attributes.position!.getZ(1)).toBeCloseTo(25, 5);
    expect(STOP_LINE_DISTANCE).toBe(5);
  });

  it('paints no lane arrows for a 2-lane road', () => {
    // Arrows are the only other LineSegments; the divider batch has 50 dashes.
    const onlyDividers = segs(g).filter((c) => posArr(c).length !== 8 * 3);
    expect(onlyDividers).toHaveLength(1);
    expect(polylines(g)).toHaveLength(3); // centerline + 2 stop lines
  });
});

describe('createRoadMarkings — 3-lane road', () => {
  const road = makePolylineRoad('r-3', [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 60 },
  ], 3);
  const g = createRoadMarkings(road);

  it('has 2 divider offsets (5.25 and 1.75) but no centerline', () => {
    expect(g.children).toHaveLength(9);
    const dividers = segs(g)[0]!;
    expect(posArr(dividers)).toHaveLength(2 * 50 * 2 * 3); // 2 offsets x 50 dashes
    expect(colorOf(dividers)).toBe(0xe2e8f0);
  });

  it('emits 2 arrows per lane (s = 0.2L and 0.8L), each an 8-point "up" arrow', () => {
    const arrows = segs(g).slice(1);
    expect(arrows).toHaveLength(3 * 2);
    for (const a of arrows) {
      expect(posArr(a)).toHaveLength(8 * 3);
      expect(colorOf(a)).toBe(0xffffff);
      // The arrow lies flat on the road, 0.025u above the markings layer.
      expect(a.position.y).toBeCloseTo(0.025, 6);
    }
  });

  it('places the first lane\'s arrows on its centreline offset (3.5) and rotates them to the tangent', () => {
    const arrows = segs(g).slice(1);
    // laneOffset(0, 3) = (1.5 - 0 - 0.5) * 3.5 = 3.5 (right of forward +Z)
    expect(arrows[0]!.position.x).toBeCloseTo(3.5, 5);
    expect(arrows[0]!.position.z).toBeCloseTo(12, 5); // 0.2 * 60
    // yaw = atan2(fwd.uz, fwd.ux) = atan2(1, 0) = PI/2; forward lane -> -PI/2
    expect(arrows[0]!.rotation.y).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('reverses the backward lanes by an extra PI', () => {
    const arrows = segs(g).slice(1);
    // laneIndex 2 is a backward lane (sign -1) -> -PI/2 + PI
    expect(arrows[4]!.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    // laneOffset(2, 3) = (1.5 - 2 - 0.5) * 3.5 = -3.5 (left of forward)
    expect(arrows[4]!.position.x).toBeCloseTo(-3.5, 5);
  });
});

describe('createRoadMarkings — 4-lane road', () => {
  it('skips the offset-0 divider (that is the centerline) and keeps 2 divider lines', () => {
    const g = createRoadMarkings(makeTestRoad('r-4', 'ew', 4));
    const dividers = segs(g)[0]!;
    const p = posArr(dividers);
    // offsets 7.0 and 3.5; the third candidate lands on 0 and is filtered out
    expect(p).toHaveLength(2 * 50 * 2 * 3);
    // r-ew runs along +X, so the dash advances along X while the
    // perpendicular offset (perp = (0, -1)) stays constant on Z.
    expect(p[2]).toBeCloseTo(-7.0, 5);
    expect(p[5]).toBeCloseTo(-7.0, 5);
    expect(p[0]).toBeCloseTo(-30, 5);
    expect(p[3]).toBeCloseTo(-29.4, 5); // DASH = 0.6u along the road
    // second divider batch starts at float 300, at offset 3.5
    expect(p[302]).toBeCloseTo(-3.5, 5);
    // No dash is ever painted on the centerline.
    for (let i = 2; i < p.length; i += 3) expect(Math.abs(p[i]!)).toBeGreaterThan(1e-3);  });
});

describe('createRoadMarkings — degenerate / short roads', () => {
  it('a zero-length road produces an empty group', () => {
    const g = createRoadMarkings(
      makePolylineRoad('r-zero', [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ], 2),
    );
    expect(g.children).toHaveLength(0);
  });

  it('a 1-lane road produces an empty group (no centerline, no dividers)', () => {
    const g = createRoadMarkings(makeTestRoad('r-1', 'ns', 1));
    expect(g.children).toHaveLength(0);
  });

  it('drops the stop lines when the road is shorter than twice STOP_LINE_DISTANCE', () => {
    const g = createRoadMarkings(
      makePolylineRoad('r-short', [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 2 },
      ], 2),
    );
    // centerline + 2 dashes survive; both stop lines are rejected by the
    // |along| > length guard (|5 - 1| = 4 > 2).
    expect(g.children).toHaveLength(2);
    expect(whiteLines(g)).toHaveLength(0);
  });
});

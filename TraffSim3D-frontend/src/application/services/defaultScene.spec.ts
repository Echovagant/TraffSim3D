// Plan 035: defaultScene factory tests.
//
// Verifies the three demo scenes produce the expected topology:
//   - cross: 2 roads + 1 (4-way) intersection + 6 vehicles
//   - t:     3 roads + 1 (3-way) intersection + 4 vehicles
//   - loop:  4 roads + 4 corner intersections + 8 vehicles

import { describe, it, expect } from 'vitest';
import { buildCrossIntersectionNetwork, buildTJunctionNetwork, buildRectangularLoopNetwork } from './defaultScene';

describe('buildCrossIntersectionNetwork', () => {
  it('produces 2 roads, 1 (4-way) intersection, 6 vehicles', () => {
    const net = buildCrossIntersectionNetwork();
    expect(Object.keys(net.roads).length).toBe(2);
    expect(Object.keys(net.intersections).length).toBe(1);
    expect(Object.keys(net.vehicles).length).toBe(6);
    const inter = Object.values(net.intersections)[0]!;
    expect(inter.connectedRoads.length).toBe(2);
    expect(inter.intersectionRadius).toBe(8);
  });
});

describe('buildTJunctionNetwork', () => {
  it('produces 3 roads, 1 (3-way) intersection, 4 vehicles', () => {
    const net = buildTJunctionNetwork();
    expect(Object.keys(net.roads).length).toBe(3);
    expect(Object.keys(net.intersections).length).toBe(1);
    expect(Object.keys(net.vehicles).length).toBe(4);
    const inter = Object.values(net.intersections)[0]!;
    expect(inter.connectedRoads.length).toBe(3);
    expect(inter.intersectionRadius).toBe(6);
  });
});

describe('buildRectangularLoopNetwork', () => {
  it('produces 4 roads, 4 corner intersections (no lights), 8 vehicles', () => {
    const net = buildRectangularLoopNetwork();
    expect(Object.keys(net.roads).length).toBe(4);
    expect(Object.keys(net.intersections).length).toBe(4);
    expect(Object.keys(net.vehicles).length).toBe(8);
    for (const inter of Object.values(net.intersections)) {
      expect(inter.trafficLights.length).toBe(0);
      expect(inter.connectedRoads.length).toBe(2);
      expect(inter.intersectionRadius).toBe(4);
    }
  });
});
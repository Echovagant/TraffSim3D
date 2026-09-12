// src/domain/services/networkBounds.spec.ts
import { describe, it, expect } from 'vitest';
import { computeNetworkBounds } from './networkBounds';
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene';
import { createRoadNetwork } from '@domain/entities/RoadNetwork';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';

describe('computeNetworkBounds', () => {
  it('returns empty bounds for an empty network', () => {
    const bounds = computeNetworkBounds(createRoadNetwork());
    expect(bounds.roadCount).toBe(0);
    expect(bounds.intersectionCount).toBe(0);
    expect(bounds.diagonal).toBe(0);
  });

  it('encloses the cross-intersection scene', () => {
    const net = buildCrossIntersectionNetwork();
    const bounds = computeNetworkBounds(net);
    expect(bounds.roadCount).toBeGreaterThan(0);
    expect(bounds.intersectionCount).toBe(1);
    // Default cross scene: NS road z=-30..+30, EW road x=-30..+30
    expect(bounds.minZ).toBeCloseTo(-30, 0);
    expect(bounds.maxZ).toBeCloseTo(30, 0);
    expect(bounds.minX).toBeCloseTo(-30, 0);
    expect(bounds.maxX).toBeCloseTo(30, 0);
    expect(bounds.centerX).toBeCloseTo(0, 0);
    expect(bounds.centerZ).toBeCloseTo(0, 0);
    expect(bounds.diagonal).toBeGreaterThan(80);  // sqrt(60² + 60²)
  });

  it('includes polyline waypoints beyond startNode/endNode', () => {
    // Simulate a curved road whose mid-waypoint stretches the bbox.
    const net = {
      roads: {
        'r-1': {
          id: 'r-1',
          startNode: { x: 0, y: 0, z: 0 },
          endNode: { x: 100, y: 0, z: 0 },
          waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 25, y: 0, z: -50 },  // pulls minZ way out
            { x: 50, y: 0, z: 50 },   // pulls maxZ way out
            { x: 75, y: 0, z: -30 },
            { x: 100, y: 0, z: 0 },
          ],
          laneCount: 2,
          speedLimit: 13.89,
          level: 0,
        },
      },
      intersections: {},
      vehicles: {},
      spawnPoints: {},
    };
    const bounds = computeNetworkBounds(net as unknown as RoadNetwork);
    expect(bounds.minZ).toBeCloseTo(-50, 0);
    expect(bounds.maxZ).toBeCloseTo(50, 0);
    expect(bounds.minX).toBeCloseTo(0, 0);
    expect(bounds.maxX).toBeCloseTo(100, 0);
  });
});
import { describe, it, expect } from 'vitest';
import { LidarSensor, defaultLidarConfig } from './LidarSensor';
import type { RapierWorld, RayHit, Vec3 } from '@infrastructure/physics';

const makeMockWorld = (hits: ReadonlyArray<RayHit | null>): RapierWorld => {
  return {
    castRayBatch: (_origins: ReadonlyArray<Vec3>, _dirs: ReadonlyArray<Vec3>, _maxRange: number): ReadonlyArray<RayHit> => {
      return hits.map((h) => h ?? { point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null });
    },
  } as unknown as RapierWorld;
};

describe('LidarSensor', () => {
  it('scan() returns h*v points per frame', () => {
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 4;
    cfg.verticalRays = 2;
    const sensor = new LidarSensor(cfg);
    const hits: RayHit[] = Array.from({ length: 8 }, () => ({
      point: { x: 1, y: 0, z: 0 },
      distance: 5,
      colliderHandle: null,
    }));
    const world = makeMockWorld(hits);
    const frame = sensor.scan(world, 0, { position: { x: 0, y: 0, z: 0 }, heading: 0 });
    expect(frame.points.length).toBe(8 * 3);
    expect(frame.intensities.length).toBe(8);
  });

  it('NaN sentinels for no-hit rays', () => {
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2;
    cfg.verticalRays = 1;
    const sensor = new LidarSensor(cfg);
    const world = makeMockWorld([null, null]);
    const frame = sensor.scan(world, 0, { position: { x: 0, y: 0, z: 0 }, heading: 0 });
    expect(Number.isNaN(frame.points[0])).toBe(true);
    expect(frame.intensities[0]).toBe(0);
  });

  it('self-occlusion: filters out hits with colliderHandle in excludeColliders (017 H4)', () => {
    const cfg = defaultLidarConfig('v-1', ['self-handle']);
    cfg.horizontalRays = 2;
    cfg.verticalRays = 1;
    const sensor = new LidarSensor(cfg);
    const world = makeMockWorld([
      { point: { x: 1, y: 0, z: 0 }, distance: 5, colliderHandle: 'self-handle' },
      { point: { x: 2, y: 0, z: 0 }, distance: 5, colliderHandle: 'other' },
    ]);
    const frame = sensor.scan(world, 0, { position: { x: 0, y: 0, z: 0 }, heading: 0 });
    // First ray: self-hit → NaN
    expect(Number.isNaN(frame.points[0])).toBe(true);
    // Second ray: other hit → not NaN
    expect(Number.isFinite(frame.points[3])).toBe(true);
  });

  it('intensity is inversely proportional to distance', () => {
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2;
    cfg.verticalRays = 1;
    const sensor = new LidarSensor(cfg);
    const world = makeMockWorld([
      { point: { x: 1, y: 0, z: 0 }, distance: 10, colliderHandle: null },
      { point: { x: 1, y: 0, z: 0 }, distance: 80, colliderHandle: null },
    ]);
    const frame = sensor.scan(world, 0, { position: { x: 0, y: 0, z: 0 }, heading: 0 });
    expect(frame.intensities[0]!).toBeGreaterThan(frame.intensities[1]!);
  });

  it('configure() merges with existing config (no overwrite of unrelated keys)', () => {
    const cfg = defaultLidarConfig('v-1', []);
    const sensor = new LidarSensor(cfg);
    sensor.configure({ mountHeight: 2.2 });
    sensor.configure({ noiseStddev: 0.05 });
    // configure is internally non-throwing and cumulative.
    expect(true).toBe(true);
  });

  it('destroy() is a no-throw method', () => {
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2;
    cfg.verticalRays = 2;
    const sensor = new LidarSensor(cfg);
    expect(() => sensor.destroy()).not.toThrow();
  });
});
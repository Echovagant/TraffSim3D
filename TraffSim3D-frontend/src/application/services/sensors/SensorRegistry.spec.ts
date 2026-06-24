import { describe, it, expect } from 'vitest';
import { SensorRegistry, type HostPoseLookup } from './SensorRegistry';
import { LidarSensor, defaultLidarConfig } from '@infrastructure/sensors';
import type { RapierWorld, RayHit, Vec3 } from '@infrastructure/physics';

const makeMockWorld = (hit: RayHit): RapierWorld => ({
  castRayBatch: (_origins: ReadonlyArray<Vec3>, _dirs: ReadonlyArray<Vec3>, _maxRange: number): ReadonlyArray<RayHit> => {
    // Return one hit per ray (caller may pass any number of origins).
    return _origins.map(() => hit);
  },
} as unknown as RapierWorld);

const getHostPose: HostPoseLookup = (id) => id === 'v-1'
  ? { position: { x: 0, y: 0, z: 0 }, heading: 0 }
  : null;

describe('SensorRegistry', () => {
  it('register + sensorCount', () => {
    const reg = new SensorRegistry();
    reg.register('v-1', new LidarSensor(defaultLidarConfig('v-1', [])), 'lidar-1');
    expect(reg.sensorCount).toBe(1);
  });

  it('unregisterAllFor destroys and removes the sensors', () => {
    const reg = new SensorRegistry();
    reg.register('v-1', new LidarSensor(defaultLidarConfig('v-1', [])), 'lidar-1');
    reg.unregisterAllFor('v-1');
    expect(reg.sensorCount).toBe(0);
  });

  it('unregisterAllFor is a no-op for unknown vehicle', () => {
    const reg = new SensorRegistry();
    expect(() => reg.unregisterAllFor('unknown')).not.toThrow();
  });

  it('scanAll calls sensor.scan for each registered vehicle', () => {
    const reg = new SensorRegistry();
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2; cfg.verticalRays = 1;
    reg.register('v-1', new LidarSensor(cfg), 'lidar-1');
    const world = makeMockWorld({ point: { x: 1, y: 0, z: 0 }, distance: 5, colliderHandle: null });
    const frames = reg.scanAll(world, 0, getHostPose);
    expect(frames.length).toBe(1);
    expect(frames[0]!.vehicleId).toBe('v-1');
  });

  it('scanAll caches the latest frame in getLatestFrames', () => {
    const reg = new SensorRegistry();
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2; cfg.verticalRays = 1;
    reg.register('v-1', new LidarSensor(cfg), 'lidar-1');
    const world = makeMockWorld({ point: { x: 1, y: 0, z: 0 }, distance: 5, colliderHandle: null });
    reg.scanAll(world, 0, getHostPose);
    expect(reg.getLatestFrames().size).toBe(1);
    expect(reg.getLatestFrames().get('v-1')!.vehicleId).toBe('v-1');
  });

  it('destroyAll clears sensors AND latestFrames', () => {
    const reg = new SensorRegistry();
    const cfg = defaultLidarConfig('v-1', []);
    cfg.horizontalRays = 2; cfg.verticalRays = 1;
    reg.register('v-1', new LidarSensor(cfg), 'lidar-1');
    const world = makeMockWorld({ point: { x: 1, y: 0, z: 0 }, distance: 5, colliderHandle: null });
    reg.scanAll(world, 0, getHostPose);
    reg.destroyAll();
    expect(reg.sensorCount).toBe(0);
    expect(reg.getLatestFrames().size).toBe(0);
  });
});
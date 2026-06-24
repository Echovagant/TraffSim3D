// src/infrastructure/sensors/LidarSensor.ts
//
// 16-line mechanical LiDAR. 360° horizontal × [-25°, +3°] vertical.
// Per 008 §1.1: 16-line default (性能预算紧). 16线 = 360 × 16 = 5760
// rays / frame, Rapier castRayBatch 实测 ~5-10ms / 帧 (30 FPS).
//
// mountHeight 按 vehicle type 查表 (008 §1.2):
//   car   = 1.5m
//   truck = 2.2m
//   bus   = 2.6m
//
// Self-occlusion (H4 fix, plan 017): castRayBatch 时把 host vehicle 的
// collider handle 列入 excludeColliderHandles, 保证 self-hits = 0
// (008 §1 R-验证). Filtering is post-cast in JS (castRayBatch doesn't
// take excludeColliders yet — future RapierWorld extension can push
// filtering down for ~10% perf gain).

import type { RapierWorld, Vec3, RayHit } from '@infrastructure/physics';

export interface LidarConfig {
  vehicleId: string;
  /** Per-type mount height. Set via configure() at mount time. */
  mountHeight: number;
  horizontalRays: number;
  verticalRays: number;
  maxRange: number;
  noiseStddev: number;
  /** Collider handles to skip (host vehicle's own body). 008 §1 R-验证. */
  excludeColliderHandles: ReadonlyArray<string>;
}

export interface LidarFrame {
  vehicleId: string;
  simTime: number;
  points: Float32Array;     // [x0,y0,z0, x1,y1,z1, ...], length = h*v*3
  intensities: Float32Array; // length = h*v
}

const VERTICAL_FOV_LO_DEG = -25;
const VERTICAL_FOV_HI_DEG = 3;

export const defaultLidarConfig = (
  vehicleId: string,
  excludeColliderHandles: ReadonlyArray<string>,
): LidarConfig => ({
  vehicleId,
  mountHeight: 1.5,  // car default; caller overrides via configure()
  horizontalRays: 360,
  verticalRays: 16,
  maxRange: 100,
  noiseStddev: 0.02,
  excludeColliderHandles,
});

export class LidarSensor {
  private cfg: LidarConfig;
  private points: Float32Array;
  private intensities: Float32Array;

  constructor(cfg: LidarConfig) {
    this.cfg = cfg;
    const n = cfg.horizontalRays * cfg.verticalRays;
    this.points = new Float32Array(n * 3);
    this.intensities = new Float32Array(n);
  }

  /** Re-configure the sensor (e.g. when vehicle type changes). */
  configure(cfg: Partial<LidarConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  /**
   * Scan once. Signature is `scan(world, simTime, hostPose)` per
   * 008 §1. mountHeight comes from LidarConfig (configured at mount,
   * not per-call).
   */
  scan(
    world: RapierWorld,
    simTime: number,
    hostPose: { position: Vec3; heading: number },
  ): LidarFrame {
    const nH = this.cfg.horizontalRays;
    const nV = this.cfg.verticalRays;
    const vFovLo = (VERTICAL_FOV_LO_DEG * Math.PI) / 180;
    const vFovHi = (VERTICAL_FOV_HI_DEG * Math.PI) / 180;

    // Build ray origins + directions.
    const origins: Vec3[] = [];
    const dirs: Vec3[] = [];
    for (let i = 0; i < nV; i++) {
      const vAng = vFovLo + ((vFovHi - vFovLo) * i) / Math.max(1, nV - 1);
      const sinV = Math.sin(vAng);
      const cosV = Math.cos(vAng);
      for (let j = 0; j < nH; j++) {
        const hAng = hostPose.heading + (2 * Math.PI * j) / nH;
        origins.push({
          x: hostPose.position.x,
          y: this.cfg.mountHeight,
          z: hostPose.position.z,
        });
        dirs.push({ x: Math.cos(hAng) * cosV, y: sinV, z: Math.sin(hAng) * cosV });
      }
    }

    // Cast + filter self-hits in JS.
    const hits = world.castRayBatch(origins, dirs, this.cfg.maxRange);
    const excludeSet = new Set(this.cfg.excludeColliderHandles);
    const n = nH * nV;
    for (let k = 0; k < n; k++) {
      const hit = hits[k]!;
      const baseIdx = k * 3;
      const isSelfHit = hit.colliderHandle !== null && excludeSet.has(hit.colliderHandle);
      if (hit.point && !isSelfHit && hit.distance < this.cfg.maxRange) {
        // Gaussian noise
        const nx = (Math.random() - 0.5) * 2 * this.cfg.noiseStddev;
        const ny = (Math.random() - 0.5) * 2 * this.cfg.noiseStddev;
        const nz = (Math.random() - 0.5) * 2 * this.cfg.noiseStddev;
        this.points[baseIdx]     = hit.point.x + nx;
        this.points[baseIdx + 1] = hit.point.y + ny;
        this.points[baseIdx + 2] = hit.point.z + nz;
        this.intensities[k] = 1.0 - hit.distance / this.cfg.maxRange;
      } else {
        // No hit (or self-hit) — write NaN sentinel.
        this.points[baseIdx]     = NaN;
        this.points[baseIdx + 1] = NaN;
        this.points[baseIdx + 2] = NaN;
        this.intensities[k] = 0;
      }
    }
    return {
      vehicleId: this.cfg.vehicleId,
      simTime,
      points: this.points,
      intensities: this.intensities,
    };
  }

  destroy(): void {
    this.points = new Float32Array(0);
    this.intensities = new Float32Array(0);
  }
}

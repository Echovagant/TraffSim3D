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

import type { RapierWorld, Vec3 } from '@infrastructure/physics';
import { LIDAR_SCAN_INTERVAL_S, LIDAR_AZIMUTH_DEG } from '@shared/constants/simulation';

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
  /** Plan 033: 扫描间隔秒. Default 0.1 (10Hz). 设为 0 表示不 throttle. */
  scanIntervalSec?: number;
  /** Plan 033: 水平方位角 (度). Default 90 (前向扇形). */
  azimuthDeg?: number;
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
  scanIntervalSec: LIDAR_SCAN_INTERVAL_S,
  azimuthDeg: LIDAR_AZIMUTH_DEG,
});

export class LidarSensor {
  private cfg: LidarConfig;
  private points: Float32Array;
  private intensities: Float32Array;
  private lastScanSimTime = -Infinity;

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
   *
   * Returns `null` if the sensor is throttled (scanIntervalSec not yet
   * elapsed). This lets the caller skip the latestFrame update while
   * leaving the previous frame visible. (Plan 033.)
   */
  scan(
    world: RapierWorld,
    simTime: number,
    hostPose: { position: Vec3; heading: number },
  ): LidarFrame | null {
    const interval = this.cfg.scanIntervalSec ?? LIDAR_SCAN_INTERVAL_S;
    if (simTime - this.lastScanSimTime < interval) {
      return null;  // throttled
    }
    this.lastScanSimTime = simTime;

    const nH = this.cfg.horizontalRays;
    const nV = this.cfg.verticalRays;
    const vFovLo = (VERTICAL_FOV_LO_DEG * Math.PI) / 180;
    const vFovHi = (VERTICAL_FOV_HI_DEG * Math.PI) / 180;
    const azimuth = (this.cfg.azimuthDeg ?? LIDAR_AZIMUTH_DEG) * Math.PI / 180;
    const azHalf = azimuth / 2;

    // Build ray origins + directions.
    const origins: Vec3[] = [];
    const dirs: Vec3[] = [];
    for (let i = 0; i < nV; i++) {
      const vAng = vFovLo + ((vFovHi - vFovLo) * i) / Math.max(1, nV - 1);
      const sinV = Math.sin(vAng);
      const cosV = Math.cos(vAng);
      for (let j = 0; j < nH; j++) {
        // Plan 033: azimuth front扇形 (default -45° to +45°), centered on heading.
        const hAng = hostPose.heading - azHalf + (azimuth * j) / Math.max(1, nH - 1);
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

// src/application/services/sensors/SensorRegistry.ts
//
// Sensor lifecycle manager. Prevents Float32Array / WebGL resource
// leaks when vehicles are removed (a HIGH-severity fix).
//
// scanAll(world, simTime, getHostPose) is the per-tick entry point:
// iterates every registered sensor, calls sensor.scan with the host
// vehicle's live pose from worldStore, returns the accumulated
// LidarFrame[]. tick() (per m2-interface-contract.md §4 step f)
// calls this when lidarEnabled is true.
//
// Also caches the latest LidarFrame per vehicle,
// so visualization consumers (LidarPointCloud) can read without
// re-scanning.

import type { LidarSensor, LidarFrame } from '@infrastructure/sensors'
import type { RapierWorld, Vec3 } from '@infrastructure/physics'
import { LIDAR_MAX_ACTIVE_SENSORS } from '@shared/constants/simulation'

type SensorId = string
type VehicleId = string

export type HostPoseLookup = (vehicleId: string) => { position: Vec3; heading: number } | null

export class SensorRegistry {
  private byVehicle: Map<VehicleId, Set<SensorId>> = new Map()
  private sensors: Map<SensorId, LidarSensor> = new Map()
  /** Latest frame per host vehicle — overwritten every scanAll(). */
  private latestFrames: Map<VehicleId, LidarFrame> = new Map()
  /** Max sensors that actually scan per tick. */
  private maxActiveSensors: number
  /** Total frames produced (not throttled calls). For UI display. */
  private totalFramesProduced: number = 0

  constructor(maxActiveSensors: number = LIDAR_MAX_ACTIVE_SENSORS) {
    this.maxActiveSensors = maxActiveSensors
  }

  register(vehicleId: VehicleId, sensor: LidarSensor, sensorId: SensorId): void {
    let set = this.byVehicle.get(vehicleId)
    if (!set) {
      set = new Set()
      this.byVehicle.set(vehicleId, set)
    }
    set.add(sensorId)
    this.sensors.set(sensorId, sensor)
  }

  unregisterAllFor(vehicleId: VehicleId): void {
    const ids = this.byVehicle.get(vehicleId)
    if (ids) {
      for (const sensorId of ids) {
        const sensor = this.sensors.get(sensorId)
        if (sensor) {
          sensor.destroy()
          this.sensors.delete(sensorId)
        }
      }
      this.byVehicle.delete(vehicleId)
    }
    this.latestFrames.delete(vehicleId)
  }

  /** H1 fix: actually scan. Called per tick when LiDAR is enabled.
   *  Also caches the latest frame for visualization consumers.
   *
   *  Cap at maxActiveSensors. Sort by vehicleId for stable
   *  "first N" selection. Sensors past the cap keep their last frame
   *  in latestFrames (UI consumers see stale data, not no data). */
  scanAll(world: RapierWorld, simTime: number, getHostPose: HostPoseLookup): LidarFrame[] {
    const out: LidarFrame[] = []
    // Sort by vehicleId for stable "first N" cap selection.
    const sorted = Array.from(this.byVehicle.keys()).sort()
    const activeIds = new Set(sorted.slice(0, this.maxActiveSensors))
    for (const vehicleId of sorted) {
      const pose = getHostPose(vehicleId)
      if (!pose) continue
      const ids = this.byVehicle.get(vehicleId)!
      for (const sensorId of ids) {
        const sensor = this.sensors.get(sensorId)
        if (!sensor) continue
        if (!activeIds.has(vehicleId)) continue // past the cap
        const frame = sensor.scan(world, simTime, pose)
        if (frame) {
          // null = throttled
          out.push(frame)
          this.latestFrames.set(vehicleId, frame)
          this.totalFramesProduced += 1
        }
      }
    }
    return out
  }

  /** Returns the most recent LidarFrame for each vehicle that has
   *  been scanned at least once. Read-only — consumers should not
   *  mutate the frames. */
  getLatestFrames(): ReadonlyMap<VehicleId, LidarFrame> {
    return this.latestFrames
  }

  getSensorsFor(vehicleId: VehicleId): LidarSensor[] {
    const ids = this.byVehicle.get(vehicleId)
    if (!ids) return []
    const out: LidarSensor[] = []
    for (const id of ids) {
      const s = this.sensors.get(id)
      if (s) out.push(s)
    }
    return out
  }

  destroyAll(): void {
    for (const s of this.sensors.values()) s.destroy()
    this.sensors.clear()
    this.byVehicle.clear()
    this.latestFrames.clear()
    this.totalFramesProduced = 0
  }

  get sensorCount(): number {
    return this.sensors.size
  }

  get frameCount(): number {
    return this.totalFramesProduced
  }
}

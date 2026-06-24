// src/application/services/sensors/SensorRegistry.ts
//
// Sensor lifecycle manager. Prevents Float32Array / WebGL resource
// leaks when vehicles are removed (008 §3.5 R5 HIGH).
//
// scanAll(world, simTime, getHostPose) is the per-tick entry point:
// iterates every registered sensor, calls sensor.scan with the host
// vehicle's live pose from worldStore, returns the accumulated
// LidarFrame[]. tick() (per m2-interface-contract.md §4 step f)
// calls this when lidarEnabled is true.

import type { LidarSensor, LidarFrame } from '@infrastructure/sensors';
import type { RapierWorld, Vec3 } from '@infrastructure/physics';

type SensorId = string;
type VehicleId = string;

export type HostPoseLookup = (
  vehicleId: string,
) => { position: Vec3; heading: number } | null;

export class SensorRegistry {
  private byVehicle: Map<VehicleId, Set<SensorId>> = new Map();
  private sensors: Map<SensorId, LidarSensor> = new Map();

  register(vehicleId: VehicleId, sensor: LidarSensor, sensorId: SensorId): void {
    let set = this.byVehicle.get(vehicleId);
    if (!set) {
      set = new Set();
      this.byVehicle.set(vehicleId, set);
    }
    set.add(sensorId);
    this.sensors.set(sensorId, sensor);
  }

  unregisterAllFor(vehicleId: VehicleId): void {
    const ids = this.byVehicle.get(vehicleId);
    if (!ids) return;
    for (const sensorId of ids) {
      const sensor = this.sensors.get(sensorId);
      if (sensor) {
        sensor.destroy();
        this.sensors.delete(sensorId);
      }
    }
    this.byVehicle.delete(vehicleId);
  }

  /** H1 fix: actually scan. Called per tick when LiDAR is enabled. */
  scanAll(
    world: RapierWorld,
    simTime: number,
    getHostPose: HostPoseLookup,
  ): LidarFrame[] {
    const out: LidarFrame[] = [];
    for (const [vehicleId, ids] of this.byVehicle) {
      const pose = getHostPose(vehicleId);
      if (!pose) continue;
      for (const sensorId of ids) {
        const sensor = this.sensors.get(sensorId);
        if (sensor) out.push(sensor.scan(world, simTime, pose));
      }
    }
    return out;
  }

  getSensorsFor(vehicleId: VehicleId): LidarSensor[] {
    const ids = this.byVehicle.get(vehicleId);
    if (!ids) return [];
    const out: LidarSensor[] = [];
    for (const id of ids) {
      const s = this.sensors.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  destroyAll(): void {
    for (const s of this.sensors.values()) s.destroy();
    this.sensors.clear();
    this.byVehicle.clear();
  }

  get sensorCount(): number {
    return this.sensors.size;
  }
}

// src/infrastructure/export/TrajectoryExporter.ts
//
// M2-C trajectory export. Buffers per-vehicle state at sample
// interval (default 10Hz). Triggered manually via UI or auto-flush
// at maxBufferRows. Output: CSV or JSON Blob for download.
//
// Plan 038: two changes:
//   1. Add `dt` field per row (= sampleInterval). Downstream ML
//      trainers (M4 RL) need the actual Δt between samples to know
//      whether the cadence is uniform.
//   2. Validate filter: skip "dirty" samples (impossible speed /
//      Δposition = 0 with reported high speed / impossible Δv).
//      Plan 038 §5.2. The thresholds are conservative; if Rapier
//      glitches produce an out-of-range sample it is silently
//      dropped instead of poisoning the buffer.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'

export const TRAJECTORY_EXPORT_SCHEMA_VERSION = 1

/** Plan 038: dirty-data thresholds. Conservative — false positives
 *  (legitimate samples dropped) are far less costly than false
 *  negatives (poisoned RL training data). */
export const DIRTY_DATA_THRESHOLDS = {
  /** Max plausible speed in m/s (180 km/h). Real-world cars are
   *  ~80 km/h; trucks ~100 km/h. Anything beyond this is a glitch. */
  MAX_SPEED_MS: 50,
  /** If the position barely moves but the reported speed is high,
   *  the sample is from a collision response frame — skip. */
  ZERO_DELTA_SPEED_MS: 5,
  /** Hard cap on Δspeed / Δt. Real-world accel rarely exceeds 8 m/s²;
   *  anything above 25 m/s² is a Rapier impulse event. */
  MAX_ACCEL_MS2: 25,
} as const

export interface TrajectoryRow {
  t: number // simTime (s)
  /** Plan 038: actual sampling interval in seconds. Equal to the
   *  sampleInterval passed to record() (== scheduler.fixedStepSec). */
  dt: number
  vehicleId: string
  roadId: string
  laneIndex: number
  type: 'car' | 'truck' | 'bus'
  x: number
  z: number
  heading: number // radians
  speed: number // m/s
  status: 'driving' | 'waiting' | 'crashed'
}

export interface ExportFormat {
  kind: 'csv' | 'json'
  includeCrashed: boolean
  sampleInterval: number // s
}

/**
 * Plan 038: per-vehicle sample validation. Returns true if the
 * current sample is acceptable (write to buffer); false to drop.
 *
 * Always rejects samples with `speed > MAX_SPEED_MS` (glitch —
 * speed came from a NaN-tainted read or a teleport). When a
 * previous sample exists for this vehicle, also rejects:
 *   - position delta < 1 mm AND reported speed > 5 m/s
 *     (collision response frame)
 *   - implied acceleration > MAX_ACCEL_MS2 (collision impulse)
 */
const isValidSample = (curr: TrajectoryRow, prev: TrajectoryRow | null): boolean => {
  if (curr.speed > DIRTY_DATA_THRESHOLDS.MAX_SPEED_MS) return false
  if (!prev) return true
  const dx = curr.x - prev.x
  const dz = curr.z - prev.z
  const dist = Math.hypot(dx, dz)
  if (dist < 1e-3 && curr.speed > DIRTY_DATA_THRESHOLDS.ZERO_DELTA_SPEED_MS) {
    return false
  }
  if (prev.dt > 0) {
    const dSpeed = curr.speed - prev.speed
    const accel = Math.abs(dSpeed) / prev.dt
    if (accel > DIRTY_DATA_THRESHOLDS.MAX_ACCEL_MS2) return false
  }
  return true
}

export class TrajectoryExporter {
  private buffer: TrajectoryRow[] = []
  private lastSampleSimTime = -Infinity
  /** Plan 038: per-vehicle previous sample for dirty-data validation. */
  private lastSamplePerVehicle = new Map<string, TrajectoryRow>()
  private cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  record(network: RoadNetwork, simTime: number, sampleInterval: number): void {
    if (simTime - this.lastSampleSimTime < sampleInterval) return
    this.lastSampleSimTime = simTime
    for (const v of Object.values(network.vehicles)) {
      const row: TrajectoryRow = {
        t: simTime,
        dt: sampleInterval,
        vehicleId: v.id,
        roadId: v.roadId,
        laneIndex: v.laneIndex,
        type: v.type,
        x: v.position.x,
        z: v.position.z,
        heading: v.heading,
        speed: v.speed,
        status: v.status,
      }
      const prev = this.lastSamplePerVehicle.get(v.id) ?? null
      if (!isValidSample(row, prev)) continue
      this.buffer.push(row)
      this.lastSamplePerVehicle.set(v.id, row)
    }
    if (this.buffer.length >= this.cap) {
      // Auto-flush: download as CSV.
      const blob = this.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trajectory-autoflush-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
      this.buffer = []
    }
  }

  exportAsBlob(format: ExportFormat): Blob {
    const filtered = format.includeCrashed
      ? this.buffer
      : this.buffer.filter((r) => r.status !== 'crashed')
    if (format.kind === 'csv') {
      // Plan 038: header now includes the `dt` column for ML training.
      const header = 't,dt,vehicleId,roadId,laneIndex,type,x,z,heading,speed,status\n'
      const rows = filtered
        .map((r) =>
          [
            r.t,
            r.dt,
            r.vehicleId,
            r.roadId,
            r.laneIndex,
            r.type,
            r.x.toFixed(3),
            r.z.toFixed(3),
            r.heading.toFixed(3),
            r.speed.toFixed(3),
            r.status,
          ].join(','),
        )
        .join('\n')
      return new Blob([header + rows + '\n'], { type: 'text/csv' })
    } else {
      const body = {
        schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION,
        savedAtMs: Date.now(),
        format: format.kind,
        includeCrashed: format.includeCrashed,
        sampleInterval: format.sampleInterval,
        rows: filtered,
      }
      return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
    }
  }

  clear(): void {
    this.buffer = []
    this.lastSampleSimTime = -Infinity
    // Plan 038: drop the per-vehicle "previous sample" cache so a
    // fresh scene doesn't inherit stale speed deltas.
    this.lastSamplePerVehicle.clear()
  }

  get rowCount(): number {
    return this.buffer.length
  }
  get maxBufferRows(): number {
    return this.cap
  }
}

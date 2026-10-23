// src/infrastructure/export/TrajectoryExporter.ts
//
// Trajectory export. Buffers per-vehicle state at sample
// interval (default 10Hz). Triggered manually via UI or auto-flush
// at maxBufferRows. Output: CSV or JSON Blob for download.
//
// Two changes:
//   1. Add `dt` field per row. It is the **actual** time since this
//      vehicle's previous sample — not the nominal `sampleInterval`.
//      Downstream ML trainers (RL) need the real Δt between samples:
//      the nominal value lies whenever the sampler jitters (the
//      fixed-step scheduler fires on a boundary, but the render loop
//      that drives it does not), and a lying Δt also poisons this
//      module's own dirty-data filter (it used the nominal interval as
//      the denominator of the acceleration test, which mis-flagged
//      perfectly good samples and silently threw a third of the buffer
//      away).
//   2. Validate filter: skip "dirty" samples (impossible speed /
//      Δposition inconsistent with the reported speed / impossible Δv).
//      A rejected sample is **counted** and the count is published in
//      the export metadata — a filter that drops rows silently is
//      indistinguishable from a filter that never ran.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'

export const TRAJECTORY_EXPORT_SCHEMA_VERSION = 1

/** Dirty-data thresholds. Conservative — false positives
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
  /**
   * How far the speed implied by the position delta may fall below the
   * reported speed before the sample counts as dirty (fraction).
   *
   * 0.2 means: the position has to account for at least a fifth of the
   * speed the sample claims. A vehicle that decelerates hard reports a
   * LOW end-of-interval speed while covering a lot of ground, so it is
   * never flagged; a vehicle whose body did not integrate at all (a
   * collision response frame) is.
   */
  MIN_IMPLIED_SPEED_RATIO: 0.2,
} as const

export interface TrajectoryRow {
  t: number // simTime (s)
  /**
   * The **actual** time (s) between this sample and this vehicle's
   * previous sample — the real Δt, not the nominal interval.
   *
   * It is `0` for the first sample of a vehicle: there is no previous
   * sample, so there is no interval. (A consumer that divides by `dt`
   * must skip the first row of each vehicle — the same thing it has to
   * do with any trajectory that starts mid-run.)
   */
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
  /**
   * The **expected** sample interval (s) — the nominal cadence the
   * caller asked for.
   *
   * It is NOT the interval the rows actually carry: each row's `dt` is
   * the measured time since that vehicle's previous sample. This field
   * only describes the *request*; the measurement lives in the rows
   * (and the export metadata reports the mean).
   */
  sampleInterval: number
}

/**
 * The filter's reference for one vehicle.
 *
 * Two different "previous" times are tracked, because they answer two
 * different questions:
 *
 *   - `measuredT` — when the last **measurement** was taken (accepted
 *     or rejected). The dirty-data filter compares a sample with the
 *     measurement right before it. Using the last *accepted* row
 *     instead would cascade: one rejected sample would make the next
 *     one look like an impossible acceleration too, and a whole run of
 *     good samples would be thrown away with it.
 *   - `exportedT` — when the last **exported row** was written. The
 *     `dt` column is the interval between two exported rows, so that
 *     `x₂ − x₁ = v · dt` holds over the exported trajectory.
 */
interface VehicleSampleState {
  /** Sim time of the last measurement (whatever its verdict). */
  measuredT: number
  /** Position + speed of the last measurement — the filter's reference. */
  x: number
  z: number
  speed: number
  /** Sim time of the last exported row (the `dt` column's reference). */
  exportedT: number
}

/**
 * Per-vehicle sample validation. Returns true if the
 * current sample is acceptable (write to buffer); false to drop.
 *
 * Always rejects samples with `speed > MAX_SPEED_MS` (glitch —
 * speed came from a NaN-tainted read or a teleport). When a
 * previous measurement exists for this vehicle, also rejects:
 *   - a sample whose position delta implies a speed far below the
 *     speed it reports (the body did not integrate — a collision
 *     response frame)
 *   - implied acceleration > MAX_ACCEL_MS2 (collision impulse)
 *
 * Both tests use the **measured** interval — the real time between
 * this sample and the previous measurement — never the nominal
 * interval: with a lying denominator they flagged healthy samples
 * (a 0.1167 s real interval measured against a 0.1 s nominal one reads
 * as a 17 % stronger acceleration) and threw a third of the buffer
 * away.
 */
const isValidSample = (
  curr: TrajectoryRow,
  prev: VehicleSampleState | null,
  measuredDt: number,
): boolean => {
  if (curr.speed > DIRTY_DATA_THRESHOLDS.MAX_SPEED_MS) return false
  if (!prev || measuredDt <= 0) return true
  const dx = curr.x - prev.x
  const dz = curr.z - prev.z
  const dist = Math.hypot(dx, dz)
  // The speed the position delta implies vs the speed the sample
  // reports. A body that did not integrate (collision response) has
  // an implied speed of ~0 while claiming to move.
  const impliedSpeed = dist / measuredDt
  if (
    impliedSpeed < curr.speed * DIRTY_DATA_THRESHOLDS.MIN_IMPLIED_SPEED_RATIO &&
    curr.speed > DIRTY_DATA_THRESHOLDS.ZERO_DELTA_SPEED_MS
  ) {
    return false
  }
  // Implied acceleration over the REAL interval.
  const dSpeed = curr.speed - prev.speed
  const accel = Math.abs(dSpeed) / measuredDt
  if (accel > DIRTY_DATA_THRESHOLDS.MAX_ACCEL_MS2) return false
  return true
}

export class TrajectoryExporter {
  private buffer: TrajectoryRow[] = []
  private lastSampleSimTime = -Infinity
  /** Per-vehicle sample state for dirty-data validation. */
  private lastSamplePerVehicle = new Map<string, VehicleSampleState>()
  /** Number of samples the dirty-data filter rejected since `clear()`. */
  private dropped = 0
  private cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  record(network: RoadNetwork, simTime: number, sampleInterval: number): void {
    if (simTime - this.lastSampleSimTime < sampleInterval) return
    this.lastSampleSimTime = simTime
    for (const v of Object.values(network.vehicles)) {
      const prev = this.lastSamplePerVehicle.get(v.id) ?? null
      const measuredDt = prev === null ? 0 : simTime - prev.measuredT
      const row: TrajectoryRow = {
        t: simTime,
        // The REAL interval between this row and the previous EXPORTED
        // row of this vehicle (0 for the first one).
        dt: prev === null ? 0 : simTime - prev.exportedT,
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
      if (!isValidSample(row, prev, measuredDt)) {
        // Never silent: the count is published in the export metadata.
        this.dropped += 1
        // The measurement reference still moves on — the next sample is
        // judged against THIS one, not against the last accepted row.
        this.lastSamplePerVehicle.set(v.id, {
          measuredT: simTime,
          x: v.position.x,
          z: v.position.z,
          speed: v.speed,
          exportedT: prev?.exportedT ?? simTime,
        })
        continue
      }
      this.buffer.push(row)
      this.lastSamplePerVehicle.set(v.id, {
        measuredT: simTime,
        x: v.position.x,
        z: v.position.z,
        speed: v.speed,
        exportedT: simTime,
      })
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
      // The header now includes the `dt` column for ML training.
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
        /**
         * The **expected** sample interval (the nominal cadence the
         * caller asked for). The interval the rows actually carry is
         * each row's `dt`; `actualSampleInterval` below is its mean.
         */
        sampleInterval: format.sampleInterval,
        /** Mean of the rows' actual Δt (s). 0 when there are < 2 rows. */
        actualSampleInterval: meanSampleInterval(filtered),
        /** Rows in this export. */
        recordedSamples: filtered.length,
        /**
         * Samples the dirty-data filter rejected since the last
         * `clear()`. A non-zero value means the buffer is missing rows
         * — the user can see it instead of silently training on a
         * third of the data.
         */
        droppedSamples: this.dropped,
        rows: filtered,
      }
      return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
    }
  }

  clear(): void {
    this.buffer = []
    this.lastSampleSimTime = -Infinity
    // Drop the per-vehicle "previous sample" cache so a
    // fresh scene doesn't inherit stale speed deltas.
    this.lastSamplePerVehicle.clear()
    this.dropped = 0
  }

  get rowCount(): number {
    return this.buffer.length
  }
  get maxBufferRows(): number {
    return this.cap
  }
  /**
   * How many samples the dirty-data filter has rejected since the last
   * `clear()`. Published so a lossy export is visible to the user
   * instead of being silent.
   */
  get droppedSampleCount(): number {
    return this.dropped
  }
}

/**
 * Mean of the rows' actual Δt (s) — the honest cadence of the export.
 * The first row of each vehicle carries `dt = 0` (no previous sample)
 * and is therefore excluded from the mean.
 */
const meanSampleInterval = (rows: ReadonlyArray<TrajectoryRow>): number => {
  let sum = 0
  let n = 0
  for (const r of rows) {
    if (r.dt <= 0) continue
    sum += r.dt
    n += 1
  }
  return n === 0 ? 0 : sum / n
}

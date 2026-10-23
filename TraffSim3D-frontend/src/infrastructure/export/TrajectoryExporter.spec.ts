import { describe, it, expect, beforeEach } from 'vitest'
import { TrajectoryExporter, TRAJECTORY_EXPORT_SCHEMA_VERSION } from './TrajectoryExporter'
import { buildTestNetwork } from '@__fixtures__/testNetwork'

describe('TrajectoryExporter', () => {
  let exp: TrajectoryExporter
  beforeEach(() => {
    exp = new TrajectoryExporter(1000)
  })

  it('record respects sampleInterval (10Hz throttle)', () => {
    const net = buildTestNetwork(1)
    exp.record(net, 0, 0.1)
    exp.record(net, 0.05, 0.1) // too soon, skip
    expect(exp.rowCount).toBe(1)
    exp.record(net, 0.1, 0.1) // 0.1s later, OK
    expect(exp.rowCount).toBe(2)
  })

  it('record captures one row per vehicle per sample', () => {
    const net = buildTestNetwork(3)
    exp.record(net, 0, 0.1)
    expect(exp.rowCount).toBe(3)
  })

  it('CSV header has 11 columns (dt added)', async () => {
    const net = buildTestNetwork(0)
    exp.record(net, 0, 0.1)
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval: 0.1 })
    const text = await blob.text()
    expect(text.split('\n')[0]).toBe(
      't,dt,vehicleId,roadId,laneIndex,type,x,z,heading,speed,status',
    )
  })

  it('CSV includes crashed vehicles when includeCrashed=true', async () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.status = 'crashed'
    exp.record(net, 0, 0.1)
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval: 0.1 })
    const text = await blob.text()
    expect(text).toMatch(/crashed/)
  })

  it('CSV excludes crashed when includeCrashed=false', async () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.status = 'crashed'
    exp.record(net, 0, 0.1)
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: false, sampleInterval: 0.1 })
    const text = await blob.text()
    expect(text).not.toMatch(/crashed/)
  })

  it('JSON export has schemaVersion = TRAJECTORY_EXPORT_SCHEMA_VERSION', async () => {
    const net = buildTestNetwork(0)
    exp.record(net, 0, 0.1)
    const blob = exp.exportAsBlob({ kind: 'json', includeCrashed: true, sampleInterval: 0.1 })
    const body = JSON.parse(await blob.text())
    expect(body.schemaVersion).toBe(TRAJECTORY_EXPORT_SCHEMA_VERSION)
    expect(body.format).toBe('json')
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it('clear() resets buffer and lastSampleSimTime', () => {
    const net = buildTestNetwork(1)
    exp.record(net, 0, 0.1)
    exp.clear()
    expect(exp.rowCount).toBe(0)
  })

  // ===== dirty-data filter + dt field =====

  it('every row carries the ACTUAL interval since that vehicle’s previous row', async () => {
    // The `dt` column used to carry the *nominal* sample interval,
    // which lied whenever the sampler jittered. It now carries the
    // measured interval: the first row of a vehicle has none (0), every
    // later row carries the real Δt to the previous row of the same
    // vehicle. (The irregular-interval case is covered in
    // `TrajectoryExporter.dt.spec.ts`.)
    const net = buildTestNetwork(2)
    exp.record(net, 0, 0.1)
    exp.record(net, 0.1, 0.1)
    const blob = exp.exportAsBlob({ kind: 'json', includeCrashed: true, sampleInterval: 0.1 })
    const body = JSON.parse(await blob.text())
    expect(body.rows.length).toBe(4)
    const byVehicle = new Map<string, number[]>()
    for (const row of body.rows) {
      const list = byVehicle.get(row.vehicleId) ?? []
      list.push(row.dt)
      byVehicle.set(row.vehicleId, list)
    }
    for (const dts of byVehicle.values()) {
      expect(dts[0]).toBe(0) // no predecessor
      expect(dts[1]).toBeCloseTo(0.1, 12)
    }
  })

  it('dirty-data filter drops samples with speed > 50 m/s', () => {
    const net = buildTestNetwork(1)
    exp.record(net, 0, 0.1) // baseline (speed=0 from makeTestVehicle)
    const teleporting = net.vehicles['v-1']!
    teleporting.speed = 200 // 720 km/h, impossible
    exp.record(net, 0.1, 0.1)
    // First row from baseline made it in; second row should be dropped.
    expect(exp.rowCount).toBe(1)
  })

  it('dirty-data filter drops collision-response frames (Δpos=0, speed>5)', () => {
    const net = buildTestNetwork(1)
    exp.record(net, 0, 0.1)
    // First sample OK. Now Rapier reports the body hasn't moved but
    // `speed` is suddenly 20 m/s — typical collision response frame.
    const v = net.vehicles['v-1']!
    v.position = { x: 0, y: 0, z: -20 } // same as baseline
    v.speed = 20
    exp.record(net, 0.1, 0.1)
    expect(exp.rowCount).toBe(1) // dirty sample dropped
  })
})

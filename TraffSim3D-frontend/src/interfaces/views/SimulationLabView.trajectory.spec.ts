// src/interfaces/views/SimulationLabView.trajectory.spec.ts
//
// The two things the SimulationLab panel has to show about the
// trajectory buffer:
//
//   1. **How many samples the dirty-data filter dropped.** The count
//      has been on the exporter since the `dt` fix, but it was only in
//      the data — a lossy export was invisible: the user downloaded a
//      file with a third of the rows missing and no indication of it.
//   2. **Why a vehicle was put back on the road** after it left the
//      network — the reset must not be a silent blink.

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SimulationLabView from './SimulationLabView.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { tickOobCleanup, clearOobEvents, recordLaneGuard } from '@application/services/oobCleanup'
import { buildTestNetwork } from '@__fixtures__/testNetwork'

const stubs = {
  RouterLink: true,
  WorldCanvas: { name: 'WorldCanvas', template: '<div data-testid="canvas-stub" />' },
  CameraView: { name: 'CameraView', template: '<div data-testid="camera-stub" />' },
}

const mountView = (): VueWrapper => mount(SimulationLabView, { global: { stubs } })

describe('SimulationLabView — the trajectory panel shows the loss', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearOobEvents()
  })

  it('shows the number of dropped samples and the drop rate', async () => {
    const view = mountView()
    const store = useWorldStore()

    // A one-vehicle network, so the counts on the panel are exact.
    const net = buildTestNetwork(1)
    const vehicle = Object.values(net.vehicles)[0]!

    // A good sample…
    vehicle.speed = 10
    store.trajectoryExporter.record(net, 0, 0.1)
    // …and an impossible one (200 m/s): the dirty-data filter has to
    // reject it, and the rejection has to be counted.
    vehicle.speed = 200
    store.trajectoryExporter.record(net, 0.1, 0.1)
    vehicle.speed = 10

    // One step so the panel re-renders (the readouts are refreshed on
    // every simulation tick).
    store.step(0.05)
    await view.vm.$nextTick()

    const readout = view.get('[data-testid="trajectory-dropped"]').text()
    console.log('[trajectory] panel readout:', readout.replace(/\s+/g, ' '))
    expect(readout).toContain('丢弃 1')
    // 1 dropped of 2 samples in total.
    expect(readout).toContain('50.0%')

    // The recorded rows are still counted separately.
    expect(view.get('[data-testid="trajectory-rows"]').text()).toContain('1 /')
    view.unmount()
  })

  it('shows no loss when nothing was dropped', async () => {
    const view = mountView()
    const store = useWorldStore()
    store.step(0.05)
    await view.vm.$nextTick()

    const readout = view.get('[data-testid="trajectory-dropped"]').text()
    console.log('[trajectory] panel readout (clean):', readout.replace(/\s+/g, ' '))
    expect(readout).toContain('丢弃 0')
    expect(readout).toContain('—')
    view.unmount()
  })

  it('measures the loss over a real run of the simulation', async () => {
    const view = mountView()
    const store = useWorldStore()

    // 10 s of simulation: the exporter samples at 10 Hz.
    for (let i = 0; i < 600; i++) store.step(1 / 60)
    await view.vm.$nextTick()

    const recorded = store.trajectoryExporter.rowCount
    const dropped = store.trajectoryExporter.droppedSampleCount
    const total = recorded + dropped
    const rate = total > 0 ? (dropped / total) * 100 : 0
    console.log(
      `[trajectory] 10 s run → recorded ${recorded} / dropped ${dropped} (${rate.toFixed(2)} %)`,
    )

    // The panel shows the same numbers.
    const readout = view.get('[data-testid="trajectory-dropped"]').text()
    console.log('[trajectory] panel readout after the run:', readout.replace(/\s+/g, ' '))
    expect(readout).toContain(`丢弃 ${dropped}`)

    // A healthy run loses (almost) nothing: the samples are consistent
    // with the speed the vehicles report.
    expect(rate).toBeLessThan(5)
    view.unmount()
  })

  it('shows why a vehicle that left the network was put back', async () => {
    const view = mountView()
    const store = useWorldStore()
    const net = store.network
    const vehicle = Object.values(net.vehicles)[0]!

    // The vehicle drifts out of the network: the cleanup records it.
    vehicle.position = { x: 1000, y: 0, z: 1000 }
    vehicle.spawnedAt = -10
    tickOobCleanup(
      {
        getRoad: (id) => net.roads[id],
        removeVehicle: () => {},
        snapVehicle: () => {},
      },
      [vehicle],
      5,
      1 / 60,
    )
    await view.vm.$nextTick()

    const readout = view.get('[data-testid="oob-event"]')
    console.log('[trajectory] oob readout:', readout.text(), '|', readout.attributes('title'))
    expect(readout.text()).toContain(vehicle.id)
    expect(readout.text()).toContain('驶离中')
    // The reason is available (tooltip), not just the label.
    expect(readout.attributes('title')).toContain('left the network')
    view.unmount()
  })

  it('shows the lane guards — a car put back on its lane is not a silent blink', async () => {
    const view = mountView()

    recordLaneGuard({
      kind: 'lane-guard',
      vehicleId: 'v-guard',
      simTime: 3,
      distance: 8.5,
      speed: 12.4,
      reason:
        'snapped back onto its lane — it was 8.5 m off its lane point at 12.4 m/s, and its speed was zeroed',
    })
    await view.vm.$nextTick()

    const readout = view.get('[data-testid="oob-event"]')
    console.log(
      '[trajectory] lane-guard readout:',
      readout.text(),
      '|',
      readout.attributes('title'),
    )
    // The label names the kind…
    expect(readout.text()).toContain('车道归位')
    expect(readout.text()).toContain('v-guard')
    // …and the tooltip carries the diagnosis: how far off, how fast.
    expect(readout.attributes('title')).toContain('8.5 m')
    expect(readout.attributes('title')).toContain('12.4 m/s')
    view.unmount()
  })

  it('shows the lateral-drift guard under its own label', async () => {
    const view = mountView()

    recordLaneGuard({
      kind: 'lateral-guard',
      vehicleId: 'v-drift',
      simTime: 4,
      distance: 17.5,
      speed: 9.25,
      reason:
        'pulled back onto its lane — it had drifted 17.5 m sideways at 9.2 m/s, and its speed was clamped',
    })
    await view.vm.$nextTick()

    const readout = view.get('[data-testid="oob-event"]')
    expect(readout.text()).toContain('横向纠偏')
    expect(readout.text()).toContain('v-drift')
    expect(readout.attributes('title')).toContain('17.5 m')
    view.unmount()
  })
})

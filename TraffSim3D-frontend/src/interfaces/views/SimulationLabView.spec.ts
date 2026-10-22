// src/interfaces/views/SimulationLabView.spec.ts
//
// Two contracts are pinned here:
//
//   1. The page must actually RUN the simulation. It used to be a
//      pure dashboard: no renderer was mounted, so `world.step()`
//      never ran and every readout (tick, FPS, phase countdown,
//      sensor frames) was a frozen number.
//
//   2. The page must not present a number it does not measure. The
//      "物理接入前后对照" table was hard-coded markup and ended with
//      a literal "~165fps with Rapier + 传感器 (实测)" — a
//      measurement that nothing measured.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SimulationLabView from './SimulationLabView.vue'
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'

/**
 * The 3D canvas is stubbed out: happy-dom has no WebGL, and the
 * render loop itself is verified in a real browser (Playwright).
 * The stub keys are the component names, so a rename would stop
 * matching and the real component would be mounted instead.
 */
const stubs = {
  RouterLink: true,
  WorldCanvas: { name: 'WorldCanvas', template: '<div data-testid="canvas-stub" />' },
  CameraView: { name: 'CameraView', template: '<div data-testid="camera-stub" />' },
}

const mountView = (): VueWrapper => mount(SimulationLabView, { global: { stubs } })

describe('SimulationLabView — the dashboard must run a live simulation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('mounts the 3D canvas, and the camera PiP together with the camera toggle', async () => {
    const view = mountView()
    // The render loop that drives `world.step()`.
    expect(view.findComponent(WorldCanvas).exists()).toBe(true)
    // The camera PiP is mounted with the toggle: CameraView's rAF loop
    // bails out (without rescheduling) while the camera is off, so a
    // PiP mounted before the toggle never renders a frame.
    expect(view.findComponent(CameraView).exists()).toBe(false)

    await view.get('[data-testid="camera-toggle"]').setChecked(true)
    await view.vm.$nextTick()
    expect(view.findComponent(CameraView).exists()).toBe(true)
    view.unmount()
  })

  it('advances the tick readout as the simulation steps', async () => {
    const view = mountView()
    const store = useWorldStore()

    const before = Number(view.get('[data-testid="sim-tick"]').text())
    store.step(0.05)
    await view.vm.$nextTick()

    expect(Number(view.get('[data-testid="sim-tick"]').text())).toBeGreaterThan(before)
    view.unmount()
  })

  it('counts the phase countdown down', async () => {
    const view = mountView()
    const store = useWorldStore()

    await view.vm.$nextTick()
    const first = Number(view.get('[data-testid="phase-remaining"]').text())

    // The dt is clamped to 1/30 s per frame, so a visible change needs
    // a handful of frames.
    for (let i = 0; i < 10; i++) store.step(0.05)
    await view.vm.$nextTick()

    const second = Number(view.get('[data-testid="phase-remaining"]').text())
    expect(second).toBeLessThan(first)
    view.unmount()
  })

  it('shows a measured frame rate, not a frozen zero', async () => {
    const clock = vi.spyOn(performance, 'now')
    let t = 5_000
    clock.mockImplementation(() => t)

    const view = mountView()
    const store = useWorldStore()

    store.step(0.05)
    // 13 frames of 40 ms → 520 ms of wall clock → 25 fps, below the
    // 30 fps gate.
    for (let i = 0; i < 13; i++) {
      t += 40
      store.step(0.05)
    }
    await view.vm.$nextTick()

    expect(store.fps).toBe(25)
    expect(view.get('[data-testid="fps"]').text()).toBe('25')
    expect(view.get('[data-testid="frame-max"]').text()).toBe('40.0')

    clock.mockRestore()
    view.unmount()
  })

  it('pauses and resumes the running simulation from the button', async () => {
    const view = mountView()
    const store = useWorldStore()

    await view.get('[data-testid="pause-button"]').trigger('click')
    expect(store.isRunning).toBe(false)
    expect(view.get('[data-testid="pause-button"]').text()).toContain('播放')

    await view.get('[data-testid="pause-button"]').trigger('click')
    expect(store.isRunning).toBe(true)
    expect(view.get('[data-testid="pause-button"]').text()).toContain('暂停')
    view.unmount()
  })

  it('force-all-red changes the live light phases', async () => {
    const view = mountView()
    const store = useWorldStore()

    expect(view.find('.phase-allRed').exists()).toBe(false)
    await view.get('[data-testid="force-all-red"]').trigger('click')
    await view.vm.$nextTick()

    expect(store.isRunning).toBe(true)
    expect(view.find('.phase-allRed').exists()).toBe(true)
    view.unmount()
  })

  it('switches the live scene from the dropdown', async () => {
    const view = mountView()
    const store = useWorldStore()

    await view.get('[data-testid="scene-select"]').setValue('loop')
    expect(store.currentSceneKind).toBe('loop')
    expect(Object.keys(store.network.intersections).length).toBe(4)

    // The switch rebuilds the network — the readout follows it.
    await view.vm.$nextTick()
    expect(view.get('[data-testid="sim-tick"]').text()).not.toBe('')
    view.unmount()
  })

  it('opens the coordinated-offset editor and writes the offset to the store', async () => {
    const view = mountView()
    const store = useWorldStore()

    // The button is only available for the coordinated controller.
    expect(view.get('[data-testid="coordinated-button"]').attributes('disabled')).toBeDefined()

    await view.get('[data-testid="controller-select"]').setValue('coordinated')
    expect(store.controllerKind).toBe('coordinated')
    expect(view.get('[data-testid="coordinated-button"]').attributes('disabled')).toBeUndefined()

    await view.get('[data-testid="coordinated-button"]').trigger('click')
    await view.vm.$nextTick()

    const input = view.find('input[type="number"]')
    expect(input.exists()).toBe(true)
    await input.setValue('7')
    expect(store.coordinatedOffsets.get('r-ns|r-ew')).toBe(7)
    view.unmount()
  })

  it('cycles the simulation rate from the rate buttons', async () => {
    const view = mountView()
    const store = useWorldStore()

    expect(view.get('[data-testid="tick-rate"]').text()).toBe('1×')
    await view.get('[data-testid="tick-rate-up"]').trigger('click')
    expect(store.tickRate).toBe(2)
    expect(view.get('[data-testid="tick-rate"]').text()).toBe('2×')

    await view.get('[data-testid="tick-rate-down"]').trigger('click')
    expect(store.tickRate).toBe(1)
    view.unmount()
  })
})

describe('SimulationLabView — no number the page does not measure', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has no hard-coded comparison table', () => {
    const view = mountView()
    expect(view.find('.diff-table').exists()).toBe(false)
    expect(view.html()).not.toContain('165fps')
    expect(view.html()).not.toContain('(实测)')
    view.unmount()
  })

  it('shows an em dash instead of a number before anything is measured', () => {
    const view = mountView()
    expect(view.get('[data-testid="fps"]').text()).toBe('—')
    expect(view.get('[data-testid="frame-min"]').text()).toBe('—')
    expect(view.get('[data-testid="frame-max"]').text()).toBe('—')
    view.unmount()
  })
})

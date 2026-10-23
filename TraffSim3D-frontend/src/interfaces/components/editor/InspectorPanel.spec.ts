// src/interfaces/components/editor/InspectorPanel.spec.ts
//
// Two "controls that lied":
//
//   1. The Phase <select>. `tick()` runs the per-light signal
//      controller every frame and overwrites whatever the Inspector
//      wrote, so a phase edit was gone within ~2 s. It is now a
//      read-only value that says who owns it.
//
//   2. The Speed field wrote `v.speed` once and the next tick threw
//      it away. It is now a persistent pin, and the Inspector says so
//      ("已锁定 …") instead of pretending it was a momentary nudge.

import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import InspectorPanel from './InspectorPanel.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { useSelectionStore } from '@interfaces/stores/selectionStore'

const mountPanel = () => mount(InspectorPanel, { global: { stubs: { RouterLink: true } } })

describe('InspectorPanel — the phase is read-only', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the phase as a read-only value and names the controller as its owner', () => {
    const world = useWorldStore()
    const selection = useSelectionStore()
    const light = Object.values(world.network.intersections)[0]!.trafficLights[0]!
    selection.select('light', light.id)

    const view = mountPanel()
    const phase = view.get('[data-testid="phase-readonly"]')
    expect(phase.text()).toBe(light.phase)
    // The phase <select> (red / yellow / green) is gone — only the
    // axis <select> is left.
    const optionValues = view.findAll('option').map((o) => o.attributes('value'))
    expect(optionValues).not.toContain('yellow')
    expect(optionValues).not.toContain('green')
    expect(view.findAll('select')).toHaveLength(1)
    expect(view.text()).toContain('由信号控制器决定')
    view.unmount()
  })
})

describe('InspectorPanel — the speed is a persistent pin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the locked speed after the user sets one and releases it on demand', async () => {
    const world = useWorldStore()
    const selection = useSelectionStore()
    selection.select('vehicle', 'v-1')

    const view = mountPanel()
    const input = view.get('[data-testid="speed-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
    // No pin yet → no badge.
    expect(view.find('[data-testid="speed-override"]').exists()).toBe(false)

    await input.setValue('90')
    await input.trigger('change')
    await view.vm.$nextTick()

    expect(world.getVehicleSpeedOverride('v-1')).toBeCloseTo(90 / 3.6, 9)
    const badge = view.get('[data-testid="speed-override"]')
    expect(badge.text()).toContain('90')
    expect(badge.text()).toContain('已锁定')

    // Releasing the pin hands the vehicle back to the controller.
    await view.get('[data-testid="speed-override"] button').trigger('click')
    await view.vm.$nextTick()

    expect(world.getVehicleSpeedOverride('v-1')).toBeNull()
    expect(view.find('[data-testid="speed-override"]').exists()).toBe(false)
    view.unmount()
  })

  it('disables the speed field while a policy replay owns the speed', () => {
    const world = useWorldStore()
    const selection = useSelectionStore()
    selection.select('vehicle', 'v-1')
    world.replayActive = true

    const view = mountPanel()
    expect(view.get('[data-testid="speed-input"]').attributes('disabled')).toBeDefined()
    view.unmount()
  })
})

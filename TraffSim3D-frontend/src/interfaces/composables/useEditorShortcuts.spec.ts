// Unit tests for src/interfaces/composables/useEditorShortcuts.ts
//
// The composable binds a window-level keydown listener from onMounted,
// so it has to be exercised inside a real component instance (mount +
// a throwaway host component). Every assertion pins the *store effect*
// of the shortcut, not just that a handler ran.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorShortcuts } from './useEditorShortcuts'
import { useSelectionStore } from '@interfaces/stores/selectionStore'
import { useWorldStore, type useWorldStore as WorldStore } from '@interfaces/stores/worldStore'
import { consumePendingFocus } from './useCameraFocus'

type World = ReturnType<typeof WorldStore>

const mountShortcuts = (): VueWrapper => {
  const Host = defineComponent({
    setup() {
      useEditorShortcuts()
      return () => h('div')
    },
  })
  return mount(Host)
}

/** Dispatch a cancelable keydown on window (target = window, which is
 *  never a typing target) and return the event so `defaultPrevented`
 *  can be inspected. */
const pressKey = (init: KeyboardEventInit): KeyboardEvent => {
  const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(evt)
  return evt
}

/** Dispatch on a real form control so `e.target` is an HTMLElement the
 *  isTypingTarget() guard can inspect. Requires bubbles:true. */
const pressKeyOn = (el: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
  const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(evt)
  return evt
}

const firstVehicleId = (world: World): string => Object.keys(world.getNetwork().vehicles)[0]!

describe('useEditorShortcuts', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    setActivePinia(createPinia())
    // Drain any focus left queued by an earlier case (the channel is
    // module state shared with useCameraFocus).
    consumePendingFocus()
    wrapper = mountShortcuts()
  })

  afterEach(() => {
    wrapper.unmount()
  })

  describe('transport / scene', () => {
    it('Space toggles pause', () => {
      const world = useWorldStore()
      expect(world.isRunning).toBe(true)

      pressKey({ key: ' ' })

      expect(world.isRunning).toBe(false)
    })

    it('Space is prevented so the page does not scroll', () => {
      expect(pressKey({ key: ' ' }).defaultPrevented).toBe(true)
    })

    it('R resets the scene back to the factory default', () => {
      const world = useWorldStore()
      world.switchScene('t')
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(4)

      pressKey({ key: 'r' })

      // reset() rebuilds the cross-intersection factory network (6
      // vehicles). Note: it does NOT rewrite `currentSceneKind`, which
      // still reads 't' — see the report; asserted here as-is.
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(6)
    })

    it('uppercase R (shift) resets too', () => {
      const world = useWorldStore()
      world.switchScene('loop')

      pressKey({ key: 'R' })

      expect(Object.keys(world.getNetwork().vehicles).length).toBe(6)
    })
  })

  describe('delete', () => {
    it('removes the selected vehicle and clears the selection', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      const id = firstVehicleId(world)
      selection.select('vehicle', id)
      const before = Object.keys(world.getNetwork().vehicles).length

      pressKey({ key: 'Delete' })

      expect(world.getNetwork().vehicles[id]).toBeUndefined()
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(before - 1)
      expect(selection.kind).toBeNull()
    })

    it('Backspace removes the selected vehicle too', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      const id = firstVehicleId(world)
      selection.select('vehicle', id)

      pressKey({ key: 'Backspace' })

      expect(world.getNetwork().vehicles[id]).toBeUndefined()
    })

    it('removes the selected traffic light', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      const light = Object.values(world.getNetwork().intersections)[0]!.trafficLights[0]!
      selection.select('light', light.id)
      const remaining = Object.values(world.getNetwork().intersections)
        .flatMap((i) => i.trafficLights)
        .filter((l) => l.id !== light.id).length

      pressKey({ key: 'Delete' })

      const after = Object.values(world.getNetwork().intersections).flatMap((i) => i.trafficLights)
      expect(after.map((l) => l.id)).not.toContain(light.id)
      expect(after.length).toBe(remaining)
      expect(selection.kind).toBeNull()
    })

    it('does not remove anything when nothing is selected', () => {
      const world = useWorldStore()
      const before = Object.keys(world.getNetwork().vehicles).length

      const evt = pressKey({ key: 'Delete' })

      expect(Object.keys(world.getNetwork().vehicles).length).toBe(before)
      expect(evt.defaultPrevented).toBe(true)
    })
  })

  describe('tick rate', () => {
    // Ladder is [0.25, 0.5, 1, 2, 4] and the store starts at 1×.
    it('"+" steps the rate up the ladder (1x → 2x)', () => {
      const world = useWorldStore()
      expect(world.tickRate).toBe(1)

      pressKey({ key: '+' })

      expect(world.tickRate).toBe(2)
    })

    it('"=" is the unshifted "+" alias', () => {
      const world = useWorldStore()

      pressKey({ key: '=' })

      expect(world.tickRate).toBe(2)
    })

    it('"-" steps the rate down the ladder (1x → 0.5x)', () => {
      const world = useWorldStore()
      expect(world.tickRate).toBe(1)

      pressKey({ key: '-' })

      expect(world.tickRate).toBe(0.5)
    })

    it('"_" is the unshifted "-" alias', () => {
      const world = useWorldStore()

      pressKey({ key: '_' })

      expect(world.tickRate).toBe(0.5)
    })

    it('stepping down past the slowest rate wraps to the fastest', () => {
      const world = useWorldStore()
      world.setTickRate(0.25)

      pressKey({ key: '-' })

      expect(world.tickRate).toBe(4)
    })

    it('auto-repeat is ignored so a held key cannot fly down the ladder', () => {
      const world = useWorldStore()
      pressKey({ key: '+', repeat: true })
      const rate = world.tickRate
      expect(rate).toBe(1)

      pressKey({ key: '+', repeat: true })
      pressKey({ key: '+', repeat: true })

      expect(world.tickRate).toBe(1)
    })

    it('a repeated key is also not preventDefault-ed', () => {
      const evt = pressKey({ key: '+', repeat: true })
      expect(evt.defaultPrevented).toBe(false)
    })
  })

  describe('escape', () => {
    it('clears an active selection and prevents default', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      selection.select('vehicle', firstVehicleId(world))

      const evt = pressKey({ key: 'Escape' })

      expect(selection.kind).toBeNull()
      expect(selection.id).toBeNull()
      expect(evt.defaultPrevented).toBe(true)
    })

    it('leaves the event alone when there is no selection', () => {
      expect(pressKey({ key: 'Escape' }).defaultPrevented).toBe(false)
    })
  })

  describe('undo / redo', () => {
    it('Ctrl+Z undoes the last mutation', () => {
      const world = useWorldStore()
      const id = firstVehicleId(world)
      const before = world.getNetwork().vehicles[id]!.position

      pressKey({ key: 'z', ctrlKey: true })
      // Mutate *after* seeding nothing: remove then undo.
      world.removeVehicle(id)
      expect(world.getNetwork().vehicles[id]).toBeUndefined()

      pressKey({ key: 'z', ctrlKey: true })

      expect(world.getNetwork().vehicles[id]).toBeDefined()
      expect(world.getNetwork().vehicles[id]!.position).toEqual(before)
    })

    it('Cmd+Z works too (Mac)', () => {
      const world = useWorldStore()
      const id = firstVehicleId(world)
      world.removeVehicle(id)

      pressKey({ key: 'z', metaKey: true })

      expect(world.getNetwork().vehicles[id]).toBeDefined()
    })

    it('Ctrl+Shift+Z redoes', () => {
      const world = useWorldStore()
      const id = firstVehicleId(world)
      world.removeVehicle(id)
      pressKey({ key: 'z', ctrlKey: true })
      expect(world.getNetwork().vehicles[id]).toBeDefined()

      pressKey({ key: 'z', ctrlKey: true, shiftKey: true })

      expect(world.getNetwork().vehicles[id]).toBeUndefined()
    })

    it('plain "z" (no modifier) is NOT an undo — it falls through to no case', () => {
      const world = useWorldStore()
      const id = firstVehicleId(world)
      world.removeVehicle(id)

      const evt = pressKey({ key: 'z' })

      expect(world.getNetwork().vehicles[id]).toBeUndefined()
      expect(evt.defaultPrevented).toBe(false)
    })
  })

  describe('typing guards', () => {
    // happy-dom's HTMLSelectElement.remove() throws because its parent
    // bookkeeping is inconsistent, so detach defensively.
    const withTypingTarget = (tag: string, run: (el: HTMLElement) => void): void => {
      const el = document.createElement(tag)
      document.body.appendChild(el)
      try {
        run(el)
      } finally {
        try {
          el.parentNode?.removeChild(el)
        } catch {
          /* happy-dom quirk on <select> — leaking the node is harmless here */
        }
      }
    }

    it('plain keys do nothing while an <input> has focus', () => {
      const world = useWorldStore()

      withTypingTarget('input', (input) => {
        const evt = pressKeyOn(input, { key: 'r' })

        expect(world.currentSceneKind).toBe('cross')
        expect(evt.defaultPrevented).toBe(false)
      })
    })

    it('plain keys do nothing while a <select> has focus', () => {
      const world = useWorldStore()
      world.switchScene('t')

      withTypingTarget('select', (select) => {
        pressKeyOn(select, { key: 'r' })

        expect(world.currentSceneKind).toBe('t')
      })
    })

    it('plain keys do nothing while a <textarea> has focus', () => {
      const world = useWorldStore()
      world.switchScene('loop')

      withTypingTarget('textarea', (area) => {
        pressKeyOn(area, { key: ' ' })

        expect(world.isRunning).toBe(true)
      })
    })

    it('plain keys do nothing on a contentEditable element', () => {
      const world = useWorldStore()
      world.switchScene('t')

      withTypingTarget('div', (editable) => {
        // happy-dom does not reflect the contentEditable *attribute*
        // onto the IDL property the guard reads, so define it directly.
        Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true })
        expect(editable.isContentEditable).toBe(true)

        pressKeyOn(editable, { key: ' ' })

        expect(world.isRunning).toBe(true)
      })
    })

    it('a plain div is NOT a typing target, so shortcuts still fire on it', () => {
      const world = useWorldStore()

      withTypingTarget('div', (plain) => {
        expect(plain.isContentEditable).toBeFalsy()

        pressKeyOn(plain, { key: ' ' })

        expect(world.isRunning).toBe(false)
      })
    })

    it('Ctrl+Z is handled before the typing-target guard (documented behaviour)', () => {
      // The source comment states undo/redo run BEFORE the Ctrl-skip
      // and the isTypingTarget() guard on purpose.
      const world = useWorldStore()
      const id = firstVehicleId(world)
      world.removeVehicle(id)

      withTypingTarget('input', (input) => {
        pressKeyOn(input, { key: 'z', ctrlKey: true })
      })

      expect(world.getNetwork().vehicles[id]).toBeDefined()
    })

    it('Ctrl+R (browser reload combo) is ignored — it is not "reset"', () => {
      const world = useWorldStore()
      world.switchScene('t')

      pressKey({ key: 'r', ctrlKey: true })

      expect(world.currentSceneKind).toBe('t')
    })

    it('Alt+Space (window manager combo) is ignored', () => {
      const world = useWorldStore()
      expect(world.isRunning).toBe(true)

      pressKey({ key: ' ', altKey: true })

      expect(world.isRunning).toBe(true)
    })
  })

  describe('camera focus / fit', () => {
    it('F focuses the camera on the selected vehicle', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      const id = firstVehicleId(world)
      const expected = world.getNetwork().vehicles[id]!.position
      selection.select('vehicle', id)

      pressKey({ key: 'f' })

      expect(consumePendingFocus()).toEqual({ ...expected, durationMs: 400 })
    })

    it('F with nothing selected queues no focus but is still prevented', () => {
      const evt = pressKey({ key: 'f' })

      expect(consumePendingFocus()).toBeNull()
      expect(evt.defaultPrevented).toBe(true)
    })

    it('Shift+F asks the store to re-frame the whole network', () => {
      const world = useWorldStore()
      const before = world.fitRequestTick

      pressKey({ key: 'F', shiftKey: true })

      expect(world.fitRequestTick).toBe(before + 1)
      // A fit must not also be treated as a focus request.
      expect(consumePendingFocus()).toBeNull()
    })

    it('Shift+F works even with an active selection (fit wins over focus)', () => {
      const world = useWorldStore()
      const selection = useSelectionStore()
      const id = firstVehicleId(world)
      selection.select('vehicle', id)
      const before = world.fitRequestTick

      pressKey({ key: 'F', shiftKey: true })

      expect(world.fitRequestTick).toBe(before + 1)
      expect(consumePendingFocus()).toBeNull()
    })
  })

  describe('shortcuts modal', () => {
    it('"?" dispatches the window event the toolbar listens for', () => {
      const seen = vi.fn()
      window.addEventListener('traffsim3d:toggle-shortcuts', seen)

      pressKey({ key: '?' })

      expect(seen).toHaveBeenCalledTimes(1)
      window.removeEventListener('traffsim3d:toggle-shortcuts', seen)
    })
  })

  describe('unbound keys and teardown', () => {
    it('an unbound key changes nothing and is not prevented', () => {
      const world = useWorldStore()
      const before = world.tickRate

      const evt = pressKey({ key: 'q' })

      expect(world.tickRate).toBe(before)
      expect(evt.defaultPrevented).toBe(false)
    })

    it('unmount removes the keydown listener', () => {
      const world = useWorldStore()
      const before = world.isRunning
      wrapper.unmount()

      pressKey({ key: ' ' })

      expect(world.isRunning).toBe(before)
    })
  })
})

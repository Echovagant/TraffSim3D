// src/interfaces/components/editor/EditorToolbar.spec.ts
//
// The 撤销 / 重做 buttons used to be permanently greyed out.
//
// The action was real — Ctrl+Z undid the edit — but the *button* never
// repainted: `worldStore`'s `history` / `redoStack` were plain `let`
// arrays, so `canUndo()` read a non-reactive value and the toolbar's
// `:disabled="!world.canUndo()"` never changed.
//
// This is a component-level test because the bug lived in the seam
// between the store and the toolbar: a store-only test would have
// passed while the button stayed dead.

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EditorToolbar from './EditorToolbar.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'

const mountToolbar = (): VueWrapper =>
  mount(EditorToolbar, {
    global: {
      stubs: {
        RouterLink: true,
        KeyboardShortcutsModal: true,
        CoordinatedConfigModal: true,
      },
    },
  })

/** The 撤销 / 重做 buttons, found by their label (they carry no test id). */
const undoButton = (view: VueWrapper) =>
  view.findAll('button').find((b) => b.text().includes('撤销'))!
const redoButton = (view: VueWrapper) =>
  view.findAll('button').find((b) => b.text().includes('重做'))!

describe('EditorToolbar — the undo / redo buttons follow the store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('enables 撤销 after an edit and disables it again once the stack is empty', async () => {
    const view = mountToolbar()
    const world = useWorldStore()

    // Nothing edited yet → both buttons are disabled.
    expect(undoButton(view).attributes('disabled')).toBeDefined()
    expect(redoButton(view).attributes('disabled')).toBeDefined()

    world.addVehicle()
    await view.vm.$nextTick()

    // The edit pushed one history entry → 撤销 must become enabled.
    expect(world.canUndo()).toBe(true)
    expect(undoButton(view).attributes('disabled')).toBeUndefined()

    // …and the redo stack is empty after a fresh edit.
    expect(redoButton(view).attributes('disabled')).toBeDefined()

    world.undo()
    await view.vm.$nextTick()

    expect(world.canUndo()).toBe(false)
    expect(undoButton(view).attributes('disabled')).toBeDefined()
    // The undone state is redoable → 重做 becomes enabled.
    expect(world.canRedo()).toBe(true)
    expect(redoButton(view).attributes('disabled')).toBeUndefined()

    view.unmount()
  })

  it('enables 重做 after an undo and disables it again after a redo', async () => {
    const view = mountToolbar()
    const world = useWorldStore()

    world.addVehicle()
    await view.vm.$nextTick()
    world.undo()
    await view.vm.$nextTick()

    expect(redoButton(view).attributes('disabled')).toBeUndefined()

    world.redo()
    await view.vm.$nextTick()

    expect(world.canRedo()).toBe(false)
    expect(redoButton(view).attributes('disabled')).toBeDefined()

    view.unmount()
  })
})

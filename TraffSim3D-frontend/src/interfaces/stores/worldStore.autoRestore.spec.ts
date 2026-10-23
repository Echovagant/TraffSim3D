// src/interfaces/stores/worldStore.autoRestore.spec.ts
//
// 保存 wrote the scene to LocalStorage and nothing ever read it back.
//
// A page refresh silently threw the saved scene away: the user had to
// press 加载 to get it back. The save button looked like it had done
// nothing.
//
// The store now restores the saved scene when it is created — i.e. when
// the application boots. This test simulates the refresh by throwing
// away the Pinia instance and creating a new store.

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorldStore } from './worldStore'

describe('worldStore — the saved scene is restored on start-up', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('restores the saved scene when the store is created again', () => {
    const world = useWorldStore()
    world.switchScene('t')
    const saved = world.serialize()
    expect(saved.ok).toBe(true)
    const vehicleCount = Object.keys(world.network.vehicles).length
    expect(vehicleCount).toBe(4)

    // "Refresh the page": a brand-new Pinia + a brand-new store.
    setActivePinia(createPinia())
    const restored = useWorldStore()

    expect(Object.keys(restored.network.vehicles).length).toBe(vehicleCount)
    // The scene kind survives too — the toolbar must not claim
    // "十字路口" while a T-junction is on screen.
    expect(restored.currentSceneKind).toBe('t')
  })

  it('keeps the default scene when nothing has been saved', () => {
    const world = useWorldStore()
    expect(Object.keys(world.network.vehicles).length).toBe(6)
    expect(world.currentSceneKind).toBe('cross')
  })

  it('does not restore a cleared scene', () => {
    const world = useWorldStore()
    world.switchScene('t')
    world.serialize()
    world.clearStorage()

    setActivePinia(createPinia())
    const restored = useWorldStore()

    expect(Object.keys(restored.network.vehicles).length).toBe(6)
    expect(restored.currentSceneKind).toBe('cross')
  })
})

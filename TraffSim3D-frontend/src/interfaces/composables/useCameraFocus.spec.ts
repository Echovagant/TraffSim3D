// Unit tests for src/interfaces/composables/useCameraFocus.ts
//
// Two module-level single-shot channels (`pendingFocus` / `pendingFit`)
// plus `focusOnSelection`, which resolves a (kind, id) pair against the
// live world store. Fresh-import per test because the channels are
// module state shared with useCameraControls.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorldStore } from '@interfaces/stores/worldStore'

type FocusModule = typeof import('./useCameraFocus')
type WorldLike = ReturnType<typeof useWorldStore>

const loadModule = async (): Promise<FocusModule> => {
  vi.resetModules()
  return import('./useCameraFocus')
}

/** `focusOnSelection` only reads `world.network.vehicles` and
 *  `world.network.intersections`, so a minimal stub is enough to model
 *  a multi-intersection network — something none of the three built-in
 *  demo scenes provide (only the cross scene is signalised). */
const stubWorldWithLights = (intersectionCount: number): WorldLike =>
  ({
    network: {
      vehicles: {},
      intersections: Object.fromEntries(
        Array.from({ length: intersectionCount }, (_, i) => [
          `i${i}`,
          {
            id: `i${i}`,
            position: { x: i * 100, y: 0, z: 0 },
            connectedRoads: [],
            intersectionRadius: 4,
            trafficLights: [
              {
                id: `tl-${i}a`,
                position: { x: i * 100, y: 0, z: 10 },
                phase: 'green',
                phaseRemaining: 1,
              },
              {
                id: `tl-${i}b`,
                position: { x: i * 100, y: 0, z: -50 },
                phase: 'red',
                phaseRemaining: 1,
              },
            ],
          },
        ]),
      ),
    },
  }) as unknown as WorldLike

describe('useCameraFocus — pending channels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetModules()
  })

  it('pending focus starts empty and consume returns null', async () => {
    const m = await loadModule()
    expect(m._pendingFocusRef.value).toBeNull()
    expect(m.consumePendingFocus()).toBeNull()
  })

  it('requestCameraFocus publishes the target verbatim', async () => {
    const m = await loadModule()
    m.requestCameraFocus({ x: 1, y: 2, z: 3, durationMs: 250 })

    expect(m._pendingFocusRef.value).toEqual({ x: 1, y: 2, z: 3, durationMs: 250 })
  })

  it('consumePendingFocus is single-shot: second call returns null', async () => {
    const m = await loadModule()
    m.requestCameraFocus({ x: 5, y: 0, z: 7 })

    expect(m.consumePendingFocus()).toEqual({ x: 5, y: 0, z: 7 })
    expect(m.consumePendingFocus()).toBeNull()
    expect(m._pendingFocusRef.value).toBeNull()
  })

  it('consuming the focus does not touch the fit channel', async () => {
    const m = await loadModule()
    m.requestFitToNetwork({
      bounds: {
        minX: 0,
        maxX: 10,
        minZ: 0,
        maxZ: 10,
        centerX: 5,
        centerZ: 5,
        diagonal: 10,
        roadCount: 1,
        intersectionCount: 1,
      },
      aspect: 1.5,
    })

    expect(m.consumePendingFocus()).toBeNull()
    expect(m.consumePendingFit()).not.toBeNull()
  })

  it('requestFitToNetwork publishes bounds + aspect and is single-shot', async () => {
    const m = await loadModule()
    const target = {
      bounds: {
        minX: -50,
        maxX: 50,
        minZ: -50,
        maxZ: 50,
        centerX: 0,
        centerZ: 0,
        diagonal: 100,
        roadCount: 2,
        intersectionCount: 3,
      },
      aspect: 16 / 9,
      durationMs: 400,
    }

    m.requestFitToNetwork(target)

    expect(m._pendingFitRef.value).toEqual(target)
    expect(m.consumePendingFit()).toEqual(target)
    expect(m.consumePendingFit()).toBeNull()
  })
})

describe('useCameraFocus — focusOnSelection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetModules()
  })

  it('resolves a vehicle and queues a 400ms focus at its position', async () => {
    const m = await loadModule()
    const world = useWorldStore()
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!
    const expected = world.getNetwork().vehicles[vehicleId]!.position

    const ok = m.focusOnSelection('vehicle', vehicleId, world)

    expect(ok).toBe(true)
    expect(m._pendingFocusRef.value).toEqual({ ...expected, durationMs: 400 })
  })

  it('returns false and queues nothing for an unknown vehicle id', async () => {
    const m = await loadModule()
    const world = useWorldStore()

    const ok = m.focusOnSelection('vehicle', 'no-such-vehicle', world)

    expect(ok).toBe(false)
    expect(m._pendingFocusRef.value).toBeNull()
  })

  it('resolves a light that lives in the first intersection of the real scene', async () => {
    const m = await loadModule()
    const world = useWorldStore()
    const light = Object.values(world.getNetwork().intersections)[0]!.trafficLights[0]!

    const ok = m.focusOnSelection('light', light.id, world)

    expect(ok).toBe(true)
    expect(m._pendingFocusRef.value).toEqual({ ...light.position, durationMs: 400 })
  })

  it('scans every intersection for the light, not just the first', async () => {
    const m = await loadModule()
    // The built-in scenes only populate trafficLights on the cross
    // intersection, so a stub network is the only way to prove the
    // lookup walks past intersections[0].
    const world = stubWorldWithLights(3)

    const ok = m.focusOnSelection('light', 'tl-2b', world)

    expect(ok).toBe(true)
    expect(m._pendingFocusRef.value).toEqual({
      x: 200,
      y: 0,
      z: -50,
      durationMs: 400,
    })
  })

  it('stops at the first intersection that owns the requested light id', async () => {
    const m = await loadModule()
    // Two intersections share the id 'tl-shared'; the first must win.
    const world = {
      network: {
        vehicles: {},
        intersections: {
          i0: {
            id: 'i0',
            position: { x: 0, y: 0, z: 0 },
            connectedRoads: [],
            intersectionRadius: 4,
            trafficLights: [
              {
                id: 'tl-shared',
                position: { x: 1, y: 0, z: 1 },
                phase: 'green',
                phaseRemaining: 1,
              },
            ],
          },
          i1: {
            id: 'i1',
            position: { x: 9, y: 0, z: 9 },
            connectedRoads: [],
            intersectionRadius: 4,
            trafficLights: [
              {
                id: 'tl-shared',
                position: { x: 8, y: 0, z: 8 },
                phase: 'green',
                phaseRemaining: 1,
              },
            ],
          },
        },
      },
    } as unknown as WorldLike

    expect(m.focusOnSelection('light', 'tl-shared', world)).toBe(true)
    expect(m._pendingFocusRef.value).toEqual({ x: 1, y: 0, z: 1, durationMs: 400 })
  })

  it('returns false when no intersection owns the requested light id', async () => {
    const m = await loadModule()
    const world = useWorldStore()

    const ok = m.focusOnSelection('light', 'tl-does-not-exist', world)

    expect(ok).toBe(false)
    expect(m._pendingFocusRef.value).toBeNull()
  })

  it('returns false when every intersection has an empty trafficLights array', async () => {
    const m = await loadModule()
    const world = useWorldStore()
    world.switchScene('loop') // 4 intersections, none signalised
    const intersections = Object.values(world.getNetwork().intersections)
    expect(intersections.length).toBeGreaterThan(1)
    expect(intersections.every((i) => i.trafficLights.length === 0)).toBe(true)

    expect(m.focusOnSelection('light', 'tl-anything', world)).toBe(false)
    expect(m._pendingFocusRef.value).toBeNull()
  })

  it('a vehicle id is not matched against the light lookup', async () => {
    const m = await loadModule()
    const world = useWorldStore()
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!

    // Same id, wrong kind — the 'light' branch must not fall back to
    // the vehicles map.
    expect(m.focusOnSelection('light', vehicleId, world)).toBe(false)
    expect(m._pendingFocusRef.value).toBeNull()
  })
})

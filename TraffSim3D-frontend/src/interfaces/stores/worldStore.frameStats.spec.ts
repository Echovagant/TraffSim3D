// src/interfaces/stores/worldStore.frameStats.spec.ts
//
// The FPS / frame-time readouts must describe the *real* frame
// interval.
//
// Before this fix the store computed both from the `dt` it received,
// and that `dt` is clamped twice on its way in (renderer: 0.1 s,
// store: 1/30 s). The consequence: the panel could never report a
// rate below 30 fps and could never report a frame longer than
// 33.3 ms — a 29.8 fps page with a 50.1 ms worst frame read as
// "32 fps / 33.3 ms max".
//
// step() is called once per rendered frame, so the wall-clock gap
// between two calls IS the frame time. These tests pin that.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useWorldStore } from './worldStore'

describe('worldStore — frame-time / FPS measurement', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>
  let clock = 1_000

  beforeEach(() => {
    setActivePinia(createPinia())
    clock = 1_000
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  it('reports a frame longer than the 33.3 ms clamp', () => {
    const world = useWorldStore()
    world.step(0.1) // first frame: no interval to measure yet
    clock += 50
    world.step(0.1)
    clock += 70
    world.step(0.1)

    // The old implementation could never exceed 33.3 ms here.
    expect(world.frameMsMax).toBeCloseTo(70, 6)
    expect(world.frameMsMin).toBeCloseTo(50, 6)
  })

  it('reports a frame rate below 30 fps', () => {
    const world = useWorldStore()
    world.step(0.1)
    // 10 frames of 50 ms each = 500 ms of wall clock → 20 fps.
    for (let i = 0; i < 10; i++) {
      clock += 50
      world.step(0.1)
    }
    expect(world.fps).toBe(20)
  })

  it('averages the real intervals over a 30-frame window', () => {
    const world = useWorldStore()
    world.step(0.1)
    for (let i = 0; i < 29; i++) {
      clock += 20
      world.step(0.1)
    }
    // 29 samples of 20 ms each; the window closes on the 30th.
    clock += 20
    world.step(0.1)
    expect(world.frameMsAvg).toBeCloseTo(20, 6)
  })

  it('does not count a pause as a slow frame', async () => {
    const world = useWorldStore()
    world.step(0.1)
    clock += 16
    world.step(0.1)
    const maxBefore = world.frameMsMax

    world.togglePause()
    await nextTick()
    clock += 5_000 // the sim is paused for five seconds
    world.setRunning(true)
    await nextTick()

    world.step(0.1) // first frame after the resume
    clock += 16
    world.step(0.1)

    expect(world.frameMsMax).toBe(maxBefore)
    expect(world.frameMsMax).toBeLessThan(100)
  })

  it('drops a stale window when the sim was not running', () => {
    const world = useWorldStore()
    world.step(0.1)
    clock += 16
    world.step(0.1)
    // A route change / backgrounded tab: the gap is far longer than a
    // frame, so it must not be reported as the worst frame.
    clock += 30_000
    world.step(0.1)
    expect(world.frameMsMax).toBeCloseTo(16, 6)
  })

  it('resetFrameStats clears the readouts for a fresh session', () => {
    const world = useWorldStore()
    world.step(0.1)
    clock += 50
    world.step(0.1)
    expect(world.frameMsMax).toBeCloseTo(50, 6)

    world.resetFrameStats()
    expect(world.fps).toBe(0)
    expect(world.frameMsMin).toBe(Infinity)
    expect(world.frameMsMax).toBe(-Infinity)
    expect(world.frameMsAvg).toBe(0)

    // The next frame starts a fresh measurement window: the first
    // frame after the reset only establishes the baseline.
    clock += 25
    world.step(0.1)
    clock += 25
    world.step(0.1)
    expect(world.frameMsMin).toBeCloseTo(25, 6)
    expect(world.frameMsMax).toBeCloseTo(25, 6)
  })
})

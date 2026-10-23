// src/interfaces/components/debug/CameraView.spec.ts
//
// The PiP camera never rendered a frame.
//
// `startLoop()` was called once in `onMounted`. The first frame was
// taken while `world.cameraEnabled` was still false, hit the
// `if (!world.cameraEnabled) return` early-exit and — because that
// exit did not schedule another frame — the rAF loop died there. The
// camera is switched on from the toolbar, which happens *after* this
// component mounted, so `cs.render` was called 0 times and the PiP
// stayed blank.
//
// The fix re-schedules the loop when `cameraEnabled` flips to true.
// This test pins that contract: after enabling the camera, the render
// callback must be called at least once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CameraView from './CameraView.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { setMainRenderer } from '@interfaces/composables/rendererRegistry'
import type { ThreeJSRenderer } from '@infrastructure/rendering'

// happy-dom has no WebGL, so `new THREE.WebGLRenderer()` would throw
// "Error creating WebGL context" when the component creates its local
// renderer for the PiP canvas. Only that one class is faked; the rest
// of three (PerspectiveCamera, WebGLRenderTarget, …) is the real one.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class FakeWebGLRenderer {
    constructor(_options?: unknown) {}
    setSize(_w: number, _h: number, _updateStyle?: boolean) {}
    render(_scene: unknown, _camera: unknown) {}
    dispose() {}
    getGl() {
      return {}
    }
    getScene() {
      return {}
    }
  }
  return { ...actual, default: actual, WebGLRenderer: FakeWebGLRenderer }
})

/** A manually driven rAF queue — the test decides when a frame happens. */
let frameQueue: FrameRequestCallback[] = []

const flushFrames = (count: number): void => {
  for (let i = 0; i < count; i++) {
    const due = frameQueue
    frameQueue = []
    for (const cb of due) cb(0)
  }
}

describe('CameraView — the PiP render loop is re-scheduled when the camera is switched on', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    frameQueue = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameQueue.push(cb)
      return frameQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    // The PiP renders through the *main* renderer (a second renderer
    // would mean a second rAF loop).
    setMainRenderer({
      getGl: () => ({}),
      getScene: () => ({}),
    } as unknown as ThreeJSRenderer)
  })

  afterEach(() => {
    setMainRenderer(null)
    vi.unstubAllGlobals()
  })

  it('calls the camera sensor render callback once the camera is enabled', async () => {
    const world = useWorldStore()
    const view = mount(CameraView)

    // Camera off → the PiP is not even rendered, and no frame is drawn.
    expect(view.find('canvas').exists()).toBe(false)
    flushFrames(3)
    expect(world.cameraFrameCount).toBe(0)

    // Switch the camera on (the toolbar's 摄像头 checkbox does this).
    world.setCameraEnabled(true)
    const sensor = world.initCameraSensor('v-1')
    const renderSpy = vi.spyOn(sensor, 'render')

    await view.vm.$nextTick()
    flushFrames(3)

    expect(renderSpy).toHaveBeenCalled()
    expect(world.cameraFrameCount).toBeGreaterThan(0)

    view.unmount()
  })

  it('stops drawing frames after the camera is switched off', async () => {
    const world = useWorldStore()
    const view = mount(CameraView)

    world.setCameraEnabled(true)
    const sensor = world.initCameraSensor('v-1')
    const renderSpy = vi.spyOn(sensor, 'render')

    await view.vm.$nextTick()
    flushFrames(3)
    const framesWhileOn = renderSpy.mock.calls.length
    expect(framesWhileOn).toBeGreaterThan(0)

    world.setCameraEnabled(false)
    flushFrames(3)
    expect(renderSpy.mock.calls.length).toBe(framesWhileOn)

    view.unmount()
  })
})

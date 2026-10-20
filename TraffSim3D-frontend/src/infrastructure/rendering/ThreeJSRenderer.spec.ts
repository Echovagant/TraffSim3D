// src/infrastructure/rendering/ThreeJSRenderer.spec.ts
//
// ThreeJSRenderer owns a real THREE.WebGLRenderer, which cannot be
// constructed under happy-dom (no WebGL context). This spec mocks ONLY
// the WebGLRenderer class — every other three.js export (Scene, Camera,
// Raycaster, geometries, InstancedMesh, matrix maths) is the real thing,
// so the camera maths, the raycasts and the scene-graph assertions are
// genuine.
//
// Two deliberate harness details, both mirroring what the real renderer
// does every frame:
//   * FakeGL.render() calls scene.updateMatrixWorld(true) and
//     camera.updateMatrixWorld() — WebGLRenderer.render() does the same,
//     and `pick()` / `screenToGround()` depend on it.
//   * requestAnimationFrame / performance.now are stubbed so the frame
//     loop can be pumped deterministically (step N ms, run one frame)
//     instead of waiting on wall-clock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'

const GL = vi.hoisted(() => {
  const instances: FakeGL[] = []
  class FakeGL {
    domElement: HTMLCanvasElement
    options: any
    pixelRatios: number[] = []
    sizes: Array<[number, number, boolean]> = []
    clearColors: Array<[number, number]> = []
    renderCalls = 0
    disposeCalls = 0
    constructor(options: any) {
      this.options = options
      this.domElement = options.canvas
      instances.push(this)
    }
    setPixelRatio(v: number) {
      this.pixelRatios.push(v)
    }
    setSize(w: number, h: number, updateStyle: boolean) {
      this.sizes.push([w, h, updateStyle])
    }
    setClearColor(c: number, a: number) {
      this.clearColors.push([c, a])
    }
    render(scene: THREE.Scene, camera: THREE.Camera) {
      this.renderCalls += 1
      scene.updateMatrixWorld(true)
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld()
    }
    dispose() {
      this.disposeCalls += 1
    }
  }
  return { FakeGL, instances }
})

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  return { ...actual, WebGLRenderer: GL.FakeGL }
})

const { ThreeJSRenderer } = await import('./ThreeJSRenderer')
const { buildTestNetwork, makeTestLight, makeTestVehicle } = await import(
  '@__fixtures__/testNetwork'
)
const { MAX_DPR } = await import('@shared/constants/simulation')
const { LightPhase } = await import('@domain/value-objects/Phase')

const RECT = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  ;(c as any).getBoundingClientRect = () => ({ ...RECT, toJSON: () => ({}) })
  return c
}

/** lib.dom's `FrameRequestCallback`, spelled out locally: the flat config's
 *  `no-undef` only knows runtime globals, not ambient DOM *types*. */
type FrameCallback = (time: number) => void

/** Deterministic rAF pump: `step(ms)` advances the fake clock and runs
 *  exactly one queued frame callback. */
function makeFramePump() {
  let clock = 0
  const pending = new Map<number, FrameCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameCallback) => {
    const id = nextId++
    pending.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pending.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  return {
    get pendingCount() {
      return pending.size
    },
    step(dtMs: number): boolean {
      clock += dtMs
      const first = pending.entries().next()
      if (first.done) return false
      const [id, cb] = first.value
      pending.delete(id)
      cb(clock)
      return true
    },
    frames(n: number, dtMs = 16) {
      for (let i = 0; i < n; i++) this.step(dtMs)
    },
  }
}

let canvas: HTMLCanvasElement
let r: InstanceType<typeof ThreeJSRenderer>
let gl: InstanceType<typeof GL.FakeGL>
let pump: ReturnType<typeof makeFramePump>
/** Mirrors the renderer's own callback contract: it hands over `dt` and gets
 *  back the new simTime, which may be `undefined` (renderer then treats it as 0). */
const onTick = vi.fn<(dt: number) => number | undefined>(() => 0)

/** The built scene root — the only Group that owns InstancedMeshes. */
const builtRoot = (): THREE.Group =>
  r
    .getScene()
    .children.find(
      (c): c is THREE.Group =>
        c instanceof THREE.Group && c.children.some((x) => x instanceof THREE.InstancedMesh),
    )!

const ringOf = (root: THREE.Group): THREE.Mesh =>
  root.children.find(
    (c) => (c as THREE.Mesh).isMesh === true && (c as THREE.Mesh).geometry.type === 'RingGeometry',
  ) as THREE.Mesh

beforeEach(() => {
  GL.instances.length = 0
  onTick.mockReset()
  onTick.mockImplementation(() => 0)
  canvas = makeCanvas()
  r = new ThreeJSRenderer(canvas, { onTick })
  gl = GL.instances[0]! as any
  pump = makeFramePump()
  // The real renderer refreshes the camera matrix every frame; mirror that
  // so pre-start queries (screenToGround / pick) behave as they do on screen.
  r.getCamera().updateMatrixWorld(true)
})

afterEach(() => {
  r.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — construction', () => {
  it('builds a scene with the dark navy background and distance fog', () => {
    const scene = r.getScene()
    expect(scene).toBeInstanceOf(THREE.Scene)
    expect((scene.background as THREE.Color).getHex()).toBe(0x0b1220)
    const fog = scene.fog as THREE.Fog
    expect(fog).toBeInstanceOf(THREE.Fog)
    expect(fog.color.getHex()).toBe(0x0b1220)
    expect(fog.near).toBe(500)
    expect(fog.far).toBe(4000)
  })

  it('installs an ambient 0.6 + directional 0.8 light', () => {
    const lights = r.getScene().children.filter((c) => (c as THREE.Light).isLight)
    const ambient = lights.find(
      (l) => (l as THREE.AmbientLight).isAmbientLight,
    ) as THREE.AmbientLight
    const dir = lights.find(
      (l) => (l as THREE.DirectionalLight).isDirectionalLight,
    ) as THREE.DirectionalLight
    expect(ambient.intensity).toBe(0.6)
    expect(ambient.color.getHex()).toBe(0xffffff)
    expect(dir.intensity).toBe(0.8)
    expect(dir.position.x).toBe(50)
    expect(dir.position.y).toBe(80)
    expect(dir.position.z).toBe(30)
  })

  it('creates a 60-degree perspective camera at (40,35,40) aimed at the origin', () => {
    const cam = r.getCamera()
    expect(cam).toBeInstanceOf(THREE.PerspectiveCamera)
    expect(cam.fov).toBe(60)
    expect(cam.near).toBe(0.1)
    expect(cam.far).toBe(8000)
    expect(cam.position.x).toBe(40)
    expect(cam.position.y).toBe(35)
    expect(cam.position.z).toBe(40)
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
    expect(dir.x).toBeLessThan(0)
    expect(dir.y).toBeLessThan(0)
    expect(dir.z).toBeLessThan(0)
  })

  it('passes the transparent-Cesium-friendly WebGL options and a capped pixel ratio', () => {
    expect(gl.options).toMatchObject({ antialias: true, alpha: true, premultipliedAlpha: false })
    expect(gl.domElement).toBe(canvas)
    expect(gl.pixelRatios).toEqual([Math.min(window.devicePixelRatio, MAX_DPR)])
    expect(gl.clearColors).toEqual([[0x000000, 0]])
  })

  it('exposes the same GL renderer through getGl()', () => {
    expect(r.getGl()).toBe(gl)
  })

  it('resize sets the camera aspect and forwards the size without touching CSS', () => {
    r.resize(1600, 900)
    expect(r.getCamera().aspect).toBeCloseTo(1600 / 900, 12)
    expect(gl.sizes).toEqual([[1600, 900, false]])
  })
})

describe('ThreeJSRenderer — setSceneScale', () => {
  it('retunes fog to 2.5x / 5x the half-extent and pushes the far plane to 8x', () => {
    r.setSceneScale(2000)
    const fog = r.getScene().fog as THREE.Fog
    expect(fog.near).toBe(5000)
    expect(fog.far).toBe(10000)
    expect(r.getCamera().far).toBe(16000)
  })

  it('never shrinks the far plane when zooming back in', () => {
    r.setSceneScale(2000)
    r.setSceneScale(100)
    expect(r.getCamera().far).toBe(16000)
    const fog = r.getScene().fog as THREE.Fog
    expect(fog.near).toBe(250)
    expect(fog.far).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// screenToGround
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — screenToGround', () => {
  it('maps the canvas centre onto the origin (the camera looks at 0,0,0)', () => {
    const hit = r.screenToGround(400, 300)!
    expect(hit).not.toBeNull()
    expect(hit.x).toBeCloseTo(0, 4)
    expect(hit.z).toBeCloseTo(0, 4)
    expect(hit.y).toBe(0)
  })

  it('always snaps the hit onto the y = 0 plane', () => {
    for (const [x, y] of [
      [0, 0],
      [800, 600],
      [123, 456],
    ] as const) {
      expect(r.screenToGround(x, y)!.y).toBe(0)
    }
  })

  it('moves monotonically as the cursor moves up the screen', () => {
    const top = r.screenToGround(400, 0)!
    const mid = r.screenToGround(400, 300)!
    const bottom = r.screenToGround(400, 600)!
    expect(top.x).toBeLessThan(mid.x)
    expect(mid.x).toBeLessThan(bottom.x)
    expect(top.z).toBeLessThan(bottom.z)
  })

  it('returns null when the ray is parallel to the ground plane', () => {
    const cam = r.getCamera()
    cam.position.set(0, 10, 0)
    cam.rotation.set(0, 0, 0) // looking horizontally along -Z
    cam.updateMatrixWorld(true)
    expect(r.screenToGround(400, 300)).toBeNull()
  })

  it('accounts for the canvas offset when converting to NDC', () => {
    ;(canvas as any).getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      right: 900,
      bottom: 650,
      width: 800,
      height: 600,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    })
    // (500, 350) is now the centre of the shifted rect.
    const hit = r.screenToGround(500, 350)!
    expect(hit.x).toBeCloseTo(0, 4)
    expect(hit.z).toBeCloseTo(0, 4)
  })
})

describe('ThreeJSRenderer — attachControls', () => {
  it('stores the controls and calls update() immediately', () => {
    const update = vi.fn()
    r.attachControls({ update })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('drives controls.update() exactly once per rendered frame', () => {
    const update = vi.fn()
    r.attachControls({ update })
    update.mockClear() // drop the immediate attach-time call
    r.start()
    pump.frames(3)
    expect(update.mock.calls.length).toBe(3)
    expect(update.mock.calls.length).toBe(gl.renderCalls)
  })

  it('does not update controls before start()', () => {
    const update = vi.fn()
    r.attachControls({ update })
    update.mockClear()
    pump.frames(2)
    expect(update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The frame loop
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — the frame loop', () => {
  it('builds the scene from the network getter on the first frame', () => {
    r.setNetworkGetter(() => buildTestNetwork(1))
    expect(gl.renderCalls).toBe(0)
    r.start()
    pump.step(16)
    const root = builtRoot()
    expect(root).toBeDefined()
    expect(root.children.filter((c) => c instanceof THREE.InstancedMesh)).toHaveLength(3)
    expect(gl.renderCalls).toBe(1)
  })

  it('ticks exactly once per frame with the elapsed wall-clock dt', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.frames(3, 16)
    expect(onTick).toHaveBeenCalledTimes(3)
    expect(onTick).toHaveBeenNthCalledWith(1, 0.016)
    expect(onTick).toHaveBeenNthCalledWith(2, 0.016)
    expect(onTick).toHaveBeenNthCalledWith(3, 0.016)
  })

  it('clamps a tab-switch stall to 0.1 s', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.step(5_000)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick.mock.calls[0]![0]).toBe(0.1)
    pump.step(100)
    expect(onTick.mock.calls[1]![0]).toBe(0.1)
  })

  it('multiplies dt by the tick rate', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.setTickPolicyGetter(() => ({ paused: false, rate: 3 }))
    r.start()
    pump.step(20)
    expect(onTick).toHaveBeenCalledWith(0.06)
  })

  it('defaults to real-time unpaused when no policy getter is registered', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.step(50)
    expect(onTick).toHaveBeenCalledWith(0.05)
  })

  it('skips onTick entirely while paused, but still redraws', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.setTickPolicyGetter(() => ({ paused: true, rate: 4 }))
    r.start()
    pump.frames(3)
    expect(onTick).not.toHaveBeenCalled()
    expect(gl.renderCalls).toBe(3)
    expect(builtRoot()).toBeDefined() // the scene is still built while paused
  })

  it('re-reads the tick policy every frame so a pause flip takes effect immediately', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    let paused = true
    r.setTickPolicyGetter(() => ({ paused, rate: 1 }))
    r.start()
    pump.frames(2)
    expect(onTick).not.toHaveBeenCalled()
    paused = false
    pump.step(16)
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('treats a callback returning undefined as simTime 0 without throwing', () => {
    onTick.mockImplementation(() => undefined)
    r.setNetworkGetter(() => buildTestNetwork(0, { phase: LightPhase.FlashingYellow }))
    r.start()
    expect(() => pump.frames(3)).not.toThrow()
  })

  it('does not sync the network when no getter was registered', () => {
    r.start()
    pump.frames(3)
    expect(gl.renderCalls).toBe(3)
    expect(builtRoot()).toBeUndefined()
  })

  it('start() is idempotent — a second call does not queue a second loop', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    expect(pump.pendingCount).toBe(1)
    r.start()
    expect(pump.pendingCount).toBe(1)
    pump.frames(3)
    expect(onTick).toHaveBeenCalledTimes(3)
  })

  it('stop() halts the loop', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.frames(2)
    const calls = gl.renderCalls
    r.stop()
    expect(pump.pendingCount).toBe(0)
    pump.frames(5)
    expect(gl.renderCalls).toBe(calls)
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('stop() is safe before start() and is idempotent', () => {
    expect(() => r.stop()).not.toThrow()
    r.start()
    r.stop()
    expect(() => r.stop()).not.toThrow()
    expect(pump.pendingCount).toBe(0)
  })

  it('can be restarted after stop()', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.frames(2)
    r.stop()
    r.start()
    pump.frames(2)
    expect(onTick).toHaveBeenCalledTimes(4)
  })

  it('dispose() stops the loop and releases the GL renderer', () => {
    r.setNetworkGetter(() => buildTestNetwork(0))
    r.start()
    pump.frames(2)
    const calls = gl.renderCalls
    r.dispose()
    expect(gl.disposeCalls).toBe(1)
    pump.frames(5)
    expect(gl.renderCalls).toBe(calls)
  })
})

// ---------------------------------------------------------------------------
// Scene rebuild / diff
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — scene rebuild', () => {
  it('rebuilds when the network identity changes and unparents the old root', () => {
    let net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    const first = builtRoot()

    net = buildTestNetwork(2)
    pump.step(16)

    const second = builtRoot()
    expect(second).not.toBe(first)
    expect(first.parent).toBeNull()
    // 2 vehicles -> 2 trail lines in the new root
    expect(second.children.filter((c) => (c as THREE.Line).isLine)).toHaveLength(2)
    expect(r.getScene().children.filter((c) => c === first)).toHaveLength(0)
  })

  it('does not rebuild while the network identity is stable (cheap sync path)', () => {
    const net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    const root = builtRoot()
    pump.frames(5)
    expect(builtRoot()).toBe(root)
  })

  it('runs the incremental diff on the stable-network path', () => {
    const net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    net.vehicles['v-2'] = makeTestVehicle({ id: 'v-2' })
    pump.step(16)
    expect(builtRoot().children.filter((c) => (c as THREE.Line).isLine)).toHaveLength(2)
  })

  it('setRenderMode invalidates the build so the next frame rebuilds in the new mode', () => {
    const net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    const flatRoot = builtRoot()
    expect(flatRoot.children.some((c) => c.name === 'pick-plane')).toBe(false)
    const roadGroups = flatRoot.children.filter((c) => c instanceof THREE.Group).length

    r.setRenderMode('smart-city')
    pump.step(16)

    const scRoot = builtRoot()
    expect(scRoot).not.toBe(flatRoot)
    expect(scRoot.children.some((c) => c.name === 'pick-plane')).toBe(true)
    expect(scRoot.children.filter((c) => c instanceof THREE.Group)).toHaveLength(roadGroups - 2)
  })

  it('setRenderMode to the current mode is a no-op (no rebuild)', () => {
    const net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    const root = builtRoot()
    r.setRenderMode('flat')
    pump.step(16)
    expect(builtRoot()).toBe(root)
  })
})

describe('ThreeJSRenderer — auxiliary meshes', () => {
  it('is a no-op before the first build', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    expect(() => {
      r.addAuxiliary(mesh)
      r.removeAuxiliary(mesh)
    }).not.toThrow()
    expect(mesh.parent).toBeNull()
  })

  it('adds to and removes from the built root', () => {
    r.setNetworkGetter(() => buildTestNetwork(1))
    r.start()
    pump.step(16)
    const root = builtRoot()
    const cloud = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    cloud.name = 'lidar-cloud'

    r.addAuxiliary(cloud)
    expect(cloud.parent).toBe(root)
    expect(root.children).toContain(cloud)

    r.removeAuxiliary(cloud)
    expect(cloud.parent).toBeNull()
    expect(root.children).not.toContain(cloud)
  })
})

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — pick', () => {
  const aimAt = (x: number, y: number, z: number) => {
    const cam = r.getCamera()
    cam.position.set(x, y, z)
    cam.lookAt(x, y - 1, z)
    cam.updateMatrixWorld(true)
    r.getScene().updateMatrixWorld(true)
  }

  it('returns null before the first build', () => {
    expect(r.pick(400, 300, buildTestNetwork(1))).toBeNull()
  })

  it('hits an instanced vehicle and resolves the entity id', () => {
    const net = buildTestNetwork(1) // v-1 sits at (0, 0, -20)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    aimAt(0, 50, -20)
    expect(r.pick(400, 300, net)).toEqual({ kind: 'vehicle', id: 'v-1' })
  })

  it('misses when the ray points at empty road', () => {
    const net = buildTestNetwork(1)
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    aimAt(300, 50, 300)
    expect(r.pick(400, 300, net)).toBeNull()
  })

  it('falls through to a traffic-light bulb', () => {
    const net = buildTestNetwork(0)
    net.intersections['i-1']!.trafficLights = [
      makeTestLight({ id: 'tl-1', position: { x: 0, y: 0, z: 0 }, phase: LightPhase.Green }),
    ]
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    aimAt(0, 50, 0) // the bulb sits at group(0,0,0) + (0,3,0)
    expect(r.pick(400, 300, net)).toEqual({ kind: 'light', id: 'tl-1' })
  })

  it('prefers a vehicle over a light when both are under the cursor', () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.position = { x: 0, y: 0, z: 3 }
    net.intersections['i-1']!.trafficLights[0]!.position = { x: 0, y: 0, z: 3 }
    r.setNetworkGetter(() => net)
    r.start()
    pump.step(16)
    aimAt(0, 50, 3)
    expect(r.pick(400, 300, net)).toEqual({ kind: 'vehicle', id: 'v-1' })
  })
})

// ---------------------------------------------------------------------------
// Selection ring
// ---------------------------------------------------------------------------

describe('ThreeJSRenderer — selection ring', () => {
  it('stays hidden when no selection getter was ever registered', () => {
    r.setNetworkGetter(() => buildTestNetwork(1))
    r.start()
    pump.frames(3)
    expect(ringOf(builtRoot()).visible).toBe(false)
  })

  it('follows the selection getter every frame', () => {
    r.setNetworkGetter(() => buildTestNetwork(1))
    r.setSelectionGetter(() => ({ kind: 'vehicle', id: 'v-1' }))
    r.start()
    pump.frames(3)
    expect(ringOf(builtRoot()).visible).toBe(true)
  })

  it('hides the ring when the selection is cleared', () => {
    let selected: { kind: 'vehicle' | 'light'; id: string } | null = { kind: 'vehicle', id: 'v-1' }
    r.setNetworkGetter(() => buildTestNetwork(1))
    r.setSelectionGetter(() => selected)
    r.start()
    pump.step(16)
    expect(ringOf(builtRoot()).visible).toBe(true)

    selected = null
    pump.step(16)
    expect(ringOf(builtRoot()).visible).toBe(false)
  })

  it('hides the ring for a selection pointing at a departed entity', () => {
    r.setNetworkGetter(() => buildTestNetwork(1))
    r.setSelectionGetter(() => ({ kind: 'vehicle', id: 'ghost' }))
    r.start()
    pump.frames(3)
    expect(ringOf(builtRoot()).visible).toBe(false)
  })
})

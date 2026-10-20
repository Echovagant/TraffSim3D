import * as THREE from 'three'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import {
  buildScene,
  syncMeshTransforms,
  syncSceneContents,
  syncSelection,
  type BuiltScene,
  type RenderMode,
} from './SceneBuilder'
import { MAX_DPR } from '@shared/constants/simulation'

export interface RendererCallbacks {
  /**
   * Called once per frame with the elapsed seconds since the last call.
   * Returns the current simulation time in seconds — the renderer uses
   * this to drive flashing traffic-light phases (FlashingYellow 1Hz,
   * FlashingRed 0.5Hz). If the callback returns `undefined`, the
   * renderer falls back to `0` (the light still renders, just without
   * blink modulation — fine for paused / no-sim scenarios).
   */
  onTick: (dt: number) => number | undefined
}

export type SelectionGetter = () => { kind: 'vehicle' | 'light'; id: string } | null

/**
 * Tick policy tells the renderer how to advance the simulation each frame.
 * - `paused: true` → skip the `onTick` call entirely (the scene is frozen
 *   but still redrawn, so the selection ring can follow a stationary
 *   entity and OrbitControls still respond to mouse).
 * - `rate` → multiplier on the wall-clock `dt` before calling `onTick`.
 *   `1` is real-time; `2` is 2× speed (cars move twice as fast in
 *   the same wall-clock second); `0.25` is quarter-speed.
 */
export type TickPolicyGetter = () => { paused: boolean; rate: number }

/** Pure-TS Three.js renderer. Owns its own scene/camera/renderer; no Vue imports. */
export class ThreeJSRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private built: BuiltScene | null = null
  private currentNetwork: RoadNetwork | null = null
  private getNetwork: (() => RoadNetwork) | null = null
  private getSelection: SelectionGetter | null = null
  private getTickPolicy: TickPolicyGetter | null = null
  private controls: { update: () => void } | null = null
  // Plan 055: 'flat' (default) renders ground + road meshes (used by
  // /scene-editor). 'smart-city' skips both because Cesium provides
  // the basemap underneath. Setting this calls `buildScene` again
  // on the next frame so the rebuild is batched with the next tick.
  private renderMode: RenderMode = 'flat'
  private rafId: number | null = null
  private lastFrameMs = 0
  private callbacks: RendererCallbacks

  constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks) {
    this.callbacks = callbacks
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0b1220)
    // Plan 054: distance fog so the ground edge (no matter how large)
    // fades smoothly into the background color when the camera zooms
    // out. Without this, even a 50km ground plane shows a hard gray
    // rectangle against the dark background. Fog distance scales with
    // the scene's far plane so we don't waste fillrate on fragments
    // beyond the fog cutoff.
    this.scene.fog = new THREE.Fog(0x0b1220, 500, 4000)
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 8000)
    this.camera.position.set(40, 35, 40)
    this.camera.lookAt(0, 0, 0)
    // Plan 055: alpha:true + clearColor(0,0) makes the Three.js
    // canvas transparent so the Cesium basemap underneath shows
    // through. `premultipliedAlpha: false` lets Cesium (which uses
    // straight alpha) composite cleanly with our drawables. Without
    // this, the Three.js canvas paints a solid dark background that
    // hides the entire basemap.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR))
    this.renderer.setClearColor(0x000000, 0) // transparent clear
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(50, 80, 30)
    this.scene.add(dir)
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  /**
   * Plan 054: retune fog + camera far plane for the current scene
   * scale. The renderer uses fixed defaults at construction time;
   * after a network replacement we want fog + far plane to extend
   * to the bbox half-extent + padding (matching the ground mesh
   * size in SceneBuilder), otherwise the ground edge becomes visible
   * again when zooming out.
   *
   * Works for both small (corridor diag=85m → halfExtent=50m, fog
   * near=125 far=250) and large (5km OSM → halfExtent=2.5km, fog
   * near=6.25km far=12.5km) scenes.
   *
   * Tuned so the road network (at ~halfExtent × 2.16 from camera
   * when fit) sits below fogNear (unfogged), and the ground edge
   * (at ~halfExtent × 4.5) sits above fogFar (fully fogged → looks
   * like background).
   */
  setSceneScale(halfExtent: number): void {
    const fogNear = halfExtent * 2.5
    const fogFar = halfExtent * 5
    this.scene.fog = new THREE.Fog(0x0b1220, fogNear, fogFar)
    this.camera.far = Math.max(this.camera.far, halfExtent * 8)
    this.camera.updateProjectionMatrix()
  }

  /** Public camera accessor so external controls (e.g. OrbitControls) can be attached. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  /**
   * Cast a ray from the camera through the screen point `(x, y)`
   * and return the intersection with the y=0 ground plane. Used by
   * the editor's drag handler to convert mouse coordinates to world
   * coordinates. Returns null if the ray is parallel to the plane.
   */
  screenToGround(x: number, y: number): { x: number; y: number; z: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const intersection = new THREE.Vector3()
    const hit = raycaster.ray.intersectPlane(groundPlane, intersection)
    return hit ? { x: hit.x, y: 0, z: hit.z } : null
  }

  /** Attach external controls by exposing the camera. OrbitControls wraps this. */
  attachControls(controls: { update: () => void }): void {
    this.controls = controls
    this.controls.update()
  }

  /**
   * Cast a ray from screen coordinates and return the first hit vehicle or light, or null.
   * Raycasts against the body meshes (vehicles) and sphere meshes (lights) of the
   * currently built scene. With the new vehicle models the body is a
   * child of a parent Group, so we walk up the hit object's parent
   * chain to find the Group that matches one of our vehicle nodes.
   */
  pick(
    screenX: number,
    screenY: number,
    network: RoadNetwork,
  ): { kind: 'vehicle'; id: string } | { kind: 'light'; id: string } | null {
    if (!this.built) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)

    // Plan 062: vehicles are InstancedMesh — raycast against the 3 type
    // meshes and use instanceId to resolve the entity.
    const vehicleMeshes = [
      this.built.vehicles.meshes.car,
      this.built.vehicles.meshes.truck,
      this.built.vehicles.meshes.bus,
    ]
    const hits = raycaster.intersectObjects(vehicleMeshes, false)
    if (hits.length > 0) {
      const hit = hits[0]!
      const mesh = hit.object as THREE.InstancedMesh
      if (hit.instanceId !== undefined) {
        const id = this.built.vehicles.pickByInstance(mesh, hit.instanceId)
        if (id) return { kind: 'vehicle', id }
      }
    }

    const lightMeshes: THREE.Mesh[] = []
    for (const node of this.built.lightNodes.values()) lightMeshes.push(node.sphere)
    const lh = raycaster.intersectObjects(lightMeshes, false)
    if (lh.length > 0) {
      const mesh = lh[0]!.object as THREE.Mesh
      for (const [lid, node] of this.built.lightNodes)
        if (node.sphere === mesh) return { kind: 'light', id: lid }
    }
    return null
  }

  /**
   * Provide a getter that returns the current network. Called every frame.
   * If the network identity changes (e.g. after reset/load), the scene is
   * rebuilt; otherwise only mesh transforms are synced (cheap).
   *
   * Pass a getter, NOT the network object directly — `worldStore.step`
   * mutates the network in place each tick, and the renderer needs to
   * see those mutations.
   */
  setNetworkGetter(getter: () => RoadNetwork): void {
    this.getNetwork = getter
  }

  /**
   * Provide a getter for the current selection. The renderer reads it every
   * frame and positions the selection ring accordingly. Optional — if never
   * set, the ring stays hidden.
   */
  setSelectionGetter(getter: SelectionGetter): void {
    this.getSelection = getter
  }

  /**
   * Add an auxiliary mesh (e.g. LiDAR point cloud) to the scene.
   * Auxiliary meshes are NOT picked, NOT synced to vehicles; they
   * live alongside the main scene until removed. If the scene hasn't
   * been built yet, the mesh is queued and added on next build.
   */
  addAuxiliary(mesh: THREE.Object3D): void {
    if (this.built) this.built.root.add(mesh)
  }

  /**
   * Remove a previously-added auxiliary mesh.
   */
  removeAuxiliary(mesh: THREE.Object3D): void {
    if (this.built) this.built.root.remove(mesh)
  }

  /** Read-only access to the Three.js scene (used by sensor rendering). */
  getScene(): THREE.Scene {
    return this.scene
  }

  /** Read-only access to the WebGLRenderer (used by CameraSensor.render
   *  to draw to an offscreen target). getCamera() already exists above
   *  for OrbitControls attachment; we don't redefine it. */
  getGl(): THREE.WebGLRenderer {
    return this.renderer
  }

  /**
   * Plan 055: switch between `flat` (ground + road meshes drawn by
   * Three.js) and `smart-city` (Cesium provides ground + roads,
   * Three.js only renders vehicles + lights + LiDAR). Triggers a
   * scene rebuild on the next frame via the existing network-change
   * branch. Calling this before the renderer has built a scene is
   * a no-op (the mode is recorded and applied on first build). */
  setRenderMode(mode: RenderMode): void {
    if (this.renderMode === mode) return
    this.renderMode = mode
    // Invalidate the current build so the next frame rebuilds.
    this.currentNetwork = null
  }

  /**
   * Provide a getter for the current tick policy (pause + rate). Called
   * every frame so the user can flip pause and change rate from anywhere.
   * If never set, the renderer defaults to `{ paused: false, rate: 1 }`
   * (real-time, unpaused) so the legacy single-arg `onTick(dt)` callers
   * keep working.
   */
  setTickPolicyGetter(getter: TickPolicyGetter): void {
    this.getTickPolicy = getter
  }

  start(): void {
    if (this.rafId !== null) return
    this.lastFrameMs = performance.now()
    const loop = (now: number) => {
      const rawDt = Math.min(0.1, (now - this.lastFrameMs) / 1000) // clamp to avoid tab-switch jumps
      this.lastFrameMs = now

      // Tick policy: read every frame so pause/rate flips take effect
      // immediately. Default to real-time / unpaused.
      const policy = this.getTickPolicy ? this.getTickPolicy() : { paused: false, rate: 1 }
      let simTime = 0
      if (!policy.paused) {
        // The store returns the current simulation time so the renderer
        // can route it to traffic-light flashing logic.
        simTime = this.callbacks.onTick(rawDt * policy.rate) ?? 0
      }

      // Reconcile the scene with the current network. `onTick` above has
      // already mutated positions; this is where the per-frame visual sync
      // happens (cheap) plus the incremental add/remove diff (also cheap for
      // the handful of entities an M1 scene holds). When paused, the network
      // is unchanged but we still want mesh positions to track the static
      // snapshot (a save/load could have replaced it under us).
      if (this.getNetwork) {
        const network = this.getNetwork()
        if (network !== this.currentNetwork) {
          if (this.built) {
            this.scene.remove(this.built.root)
            // Dispose is best-effort — new built replaces it. The old meshes
            // were already linked to the scene root and will be GC'd once
            // the renderer drops its reference.
          }
          this.built = buildScene(network, this.renderMode)
          this.scene.add(this.built.root)
          this.currentNetwork = network
        } else if (this.built) {
          syncMeshTransforms(network, this.built, simTime)
          syncSceneContents(network, this.built)
        }
      }
      if (this.built && this.getSelection) {
        syncSelection(this.built, this.getSelection())
      }
      this.controls?.update()
      this.renderer.render(this.scene, this.camera)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  dispose(): void {
    this.stop()
    this.renderer.dispose()
  }
}

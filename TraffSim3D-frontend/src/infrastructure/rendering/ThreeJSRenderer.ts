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
import { buildRouteMesh, type RouteRenderPath } from './RouteMesh'
import { createPoiLayer, type Poi, type PoiLayer } from './PoiLayer'
import { vehicleLodScale } from './vehicleLod'
import { MAX_DPR, VEHICLE_BODY_SPEC } from '@shared/constants/simulation'

/** How far ahead of the car the first-person camera looks (m). */
export const FOLLOW_LOOK_AHEAD_M = 14

/** How far below the driver's eye the camera's look-at point sits (m). */
export const FOLLOW_LOOK_DOWN_M = 1.6

/** How far behind the car the chase camera hangs (m). */
export const FOLLOW_CHASE_BEHIND_M = 9

/** How far above the car the chase camera hangs (m). */
export const FOLLOW_CHASE_ABOVE_M = 3.4

/** How high the overhead chase camera looks down from (m). */
export const FOLLOW_CHASE_TOP_M = 55

/**
 * How many frames the camera takes to arrive at the driver's eye.
 *
 * The entry is an ease-out over this many frames (~0.7 s at 60 fps),
 * after which the camera tracks the eye **exactly**. A lerp that never
 * converges would leave the view a few metres behind the car forever,
 * and the first-person camera is supposed to be IN the car — the
 * existing spec asserts the eye position, so the move has to finish.
 */
export const FOLLOW_ENTRY_FRAMES = 40

/**
 * How long the camera takes to ease into the driver's eye, in
 * milliseconds — `FOLLOW_ENTRY_FRAMES` at 60 fps.
 *
 * Timed rather than counted in frames: a frame count ties the camera's
 * arrival to the frame rate, and on a slow machine the first-person
 * view was still swinging into place seconds after the user expected
 * it to have arrived (measured on the CI runner: 15 fps, and the
 * camera was still 2.8 m above the car after 800 ms).
 */
export const FOLLOW_ENTRY_MS = (FOLLOW_ENTRY_FRAMES * 1000) / 60

/**
 * What the first-person camera rides with.
 *
 * Structural on purpose — the render layer must not depend on the
 * application layer's types.
 */
export interface FollowCameraTarget {
  /** The eye position, already at the driver's eye height. */
  position: { x: number; y: number; z: number }
  /** The direction of travel, in radians (world XZ plane). */
  heading: number
  /**
   * The vehicle the camera rides in.
   *
   * It is **not drawn** while the camera rides: the camera sits inside
   * the car, so the car's own body would fill the frame.
   */
  vehicleId?: string
  /** The body length the chase camera hangs off (defaults to a car). */
  vehicleKind?: 'car' | 'truck' | 'bus'
  /**
   * Which ride the camera takes. `cockpit` (default) sits at the
   * driver's eye — the POI drive's first person; the car's own body is
   * hidden while it rides. `chase` hangs behind and above the car (the
   * tracking view); `chase-top` looks straight down from above it (the
   * tracking view's overhead). The car stays visible in both chase
   * views — the vehicle IS the subject there.
   */
  mode?: 'cockpit' | 'chase' | 'chase-top'
}

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
  private controls: { update: () => void; target?: THREE.Vector3 } | null = null
  /** The first-person camera's target, when one is set. */
  private getFollowTarget: (() => FollowCameraTarget | null) | null = null
  /** The planned route, read every frame. */
  private getRoute: (() => RouteRenderPath | null) | null = null
  /** The route ribbon currently in the scene (null when none). */
  private routeMesh: THREE.Mesh | null = null
  /** The route the ribbon was built from — a change rebuilds it. */
  private routeRef: RouteRenderPath | null = null
  /** The vehicle currently hidden because the camera rides in it. */
  private hiddenFollowerId: string | null = null
  /** Whether the camera is currently easing into / riding the car. */
  private following = false
  /** Frames spent easing into the first-person view (capped). */
  /**
   * How long the camera has been easing toward the driver's eye, in
   * MILLISECONDS.
   *
   * It used to be a frame COUNT, which tied the camera's arrival to the
   * frame rate: at 60 fps the ease was over in 0.67 s, at 15 fps it
   * took 2.7 s — and on a slow machine the first-person view was still
   * swinging into place long after the user expected it to have
   * arrived. The arrival is now the same wall-clock time everywhere.
   */
  private followElapsedMs = 0
  /** Where the camera is steering its look-at point toward. */
  private followLook = new THREE.Vector3()
  /** The POI markers (one draw call for the whole set). */
  private poiLayer: PoiLayer | null = null
  // 'flat' (default) renders ground + road meshes (used by
  // /scene-editor). 'smart-city' skips both because Cesium provides
  // the basemap underneath. Setting this calls `buildScene` again
  // on the next frame so the rebuild is batched with the next tick.
  private renderMode: RenderMode = 'flat'
  private rafId: number | null = null
  private lastFrameMs = 0
  private callbacks: RendererCallbacks
  /**
   * The canvas' CSS height, as of the last `resize` — the vehicle LOD
   * factor converts world metres to screen pixels with it. `null` until
   * the first resize: the LOD then degrades to 1 (true size), which is
   * the right reading for "viewport unknown".
   */
  private viewportHeightPx: number | null = null

  constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks) {
    this.callbacks = callbacks
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0b1220)
    // Distance fog so the ground edge (no matter how large)
    // fades smoothly into the background color when the camera zooms
    // out. Without this, even a 50km ground plane shows a hard gray
    // rectangle against the dark background. Fog distance scales with
    // the scene's far plane so we don't waste fillrate on fragments
    // beyond the fog cutoff.
    this.scene.fog = new THREE.Fog(0x0b1220, 500, 4000)
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 8000)
    this.camera.position.set(40, 35, 40)
    this.camera.lookAt(0, 0, 0)
    // alpha:true + clearColor(0,0) makes the Three.js
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

    // Dev-only introspection hook, same pattern as `window.__world` and
    // `window.__camera`: the performance probes need the live renderer
    // (draw calls, the scene graph) to tell one layer's cost from
    // another's. `import.meta.env.DEV` is replaced with `false` in
    // production builds, so this block is tree-shaken out of the bundle.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      ;(window as unknown as { __renderer?: ThreeJSRenderer }).__renderer = this
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.viewportHeightPx = height
    this.renderer.setSize(width, height, false)
  }

  /**
   * Retune fog + camera far plane for the current scene
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

  /**
   * Let the basemap show through the canvas.
   *
   * The renderer clears with a **transparent** colour (`alpha: true` +
   * `setClearColor(0x000000, 0)`) — but Three.js paints
   * `scene.background` over the whole canvas *first*, so the default
   * opaque background (0x0b1220) hid the Cesium basemap completely,
   * no matter how transparent the clear was. Measured: hiding the
   * Three.js canvas in the Smart City view revealed a fully rendered
   * basemap underneath — the whole thing was there all along.
   *
   * `null` is Three.js's "no background": the canvas keeps its alpha,
   * and whatever is behind it (the basemap) shows through. The fog
   * colour stays, so distant geometry still fades into the dark.
   *
   * The scene editor does NOT want this — there the dark background IS
   * the design — so it stays opt-in.
   */
  setTransparentBackground(enabled: boolean): void {
    this.scene.background = enabled ? null : new THREE.Color(0x0b1220)
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
  attachControls(controls: { update: () => void; target?: THREE.Vector3 }): void {
    this.controls = controls
    this.controls.update()
  }

  /**
   * Provide a getter for the first-person camera's target.
   *
   * While a target is returned, the renderer drives the camera itself:
   * the camera sits at the target's position, looks along its heading,
   * and the orbit controls stand down. When the getter returns `null`
   * the orbit camera takes over again, starting from where the first
   * person left off.
   */
  setFollowTargetGetter(getter: () => FollowCameraTarget | null): void {
    this.getFollowTarget = getter
  }

  /**
   * Draw the points of interest.
   *
   * The layer lives on the SCENE (not on the built scene): the POIs are
   * a map overlay, not part of the scene's geometry, and they must
   * survive a scene rebuild... which is why they are CLEARED on one
   * instead (they belonged to the old map).
   */
  setPois(pois: Poi[]): void {
    if (!this.poiLayer) {
      this.poiLayer = createPoiLayer()
      this.scene.add(this.poiLayer.mesh)
    }
    this.poiLayer.set(pois)
  }

  /** Brighten the selected POI (null clears the selection). */
  selectPoi(id: string | null): void {
    this.poiLayer?.select(id)
  }

  /**
   * Draw one POI as the DESTINATION — its marker is larger and
   * brighter, because in the first-person view it is what the driver
   * is driving at.
   */
  setPoiDestination(id: string | null): void {
    this.poiLayer?.setDestination(id)
  }

  /** Drop the POI markers (a new scene, or the user cleared them). */
  clearPois(): void {
    this.poiLayer?.set([])
  }

  /**
   * Provide a getter for the planned route.
   *
   * The ribbon is rebuilt whenever the route changes. It lives in the
   * scene root (not in the built scene) so it survives a network
   * rebuild — a route is drawn over the scene, it is not part of it.
   */
  setRouteGetter(getter: () => RouteRenderPath | null): void {
    this.getRoute = getter
  }

  /**
   * Cast a ray from screen coordinates and return the first hit vehicle or light, or null.
   * Raycasts against the body meshes (vehicles) and the bulb instances (lights) of the
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

    // Vehicles are InstancedMesh — raycast against the 3 type
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

    // No light layer (smart-city mode) → nothing to pick.
    const lightLayer = this.built.lightLayer
    if (!lightLayer) return null
    const lh = raycaster.intersectObjects([lightLayer.bulbs], false)
    if (lh.length > 0) {
      const hit = lh[0]!
      const id = lightLayer.lightIdAt(hit.instanceId ?? -1)
      if (id) return { kind: 'light', id }
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
   * Switch between `flat` (ground + road meshes drawn by
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
      // the handful of entities a demo scene holds). When paused, the network
      // is unchanged but we still want mesh positions to track the static
      // snapshot (a save/load could have replaced it under us).
      if (this.getNetwork) {
        const network = this.getNetwork()
        if (network !== this.currentNetwork) {
          // The POIs belonged to the OLD map — their coordinates are
          // projected around the old origin, so they would be in the
          // wrong place on the new one.
          this.clearPois()
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
      this.syncRouteMesh()
      // The first-person camera owns the camera while it rides; the
      // orbit controls stand down (their damping would fight the
      // per-frame placement).
      const follow = this.getFollowTarget?.() ?? null
      if (follow) {
        this.applyFollowCamera(follow, rawDt)
      } else {
        // Leaving the first-person view: the next entry eases in again
        // from wherever the camera is now.
        this.following = false
        this.controls?.update()
      }
      this.syncFollowerVisibility(follow)
      // Far-camera legibility: kilometres away, a real-size car covers
      // well under one screen pixel and the overview reads "cars
      // floating on buildings". Scale the drawn bodies up just enough
      // to hold a minimum mark — the dot is a display symbol; physics,
      // position and heading are untouched. (Real traffic platforms
      // show the same thing: city-scale dots that become vehicles as
      // the camera approaches.) Recomposition happens inside
      // `setLodScale`, so the factor also lands while paused. Until the
      // first resize the viewport height is unknown and the factor
      // degrades to 1.
      if (this.built) {
        this.built.vehicles.setLodScale(
          vehicleLodScale(
            this.camera.position.length(),
            this.viewportHeightPx ?? 0,
            (this.camera.fov * Math.PI) / 180,
          ),
        )
      }
      this.renderer.render(this.scene, this.camera)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /**
   * Place the camera at the driver's eye, looking along the heading.
   *
   * The look-at point is ahead of the car and slightly below the eye,
   * which is what a driver actually looks at — a level horizon puts the
   * road surface exactly at the middle of the frame and the far end of
   * the street exactly at the middle of the screen, with nothing in
   * between.
   */
  private applyFollowCamera(target: FollowCameraTarget, dt: number): void {
    const mode = target.mode ?? 'cockpit'
    const forward = new THREE.Vector3(Math.cos(target.heading), 0, Math.sin(target.heading))
    let eye: THREE.Vector3
    let look: THREE.Vector3
    if (mode === 'chase') {
      // Behind and above: the tracking camera reads the street the car
      // is driving through, with the car itself in the lower third.
      // The hang-back distance scales with the body — the constants
      // are tuned for a car, and a 9 m bus would fill the frame.
      const length = VEHICLE_BODY_SPEC[target.vehicleKind ?? 'car'].length
      const behind = FOLLOW_CHASE_BEHIND_M + length / 2
      const above = FOLLOW_CHASE_ABOVE_M + length * 0.18
      const body = new THREE.Vector3(target.position.x, target.position.y, target.position.z)
      eye = body
        .clone()
        .sub(forward.clone().multiplyScalar(behind))
        .add(new THREE.Vector3(0, above, 0))
      look = body.add(forward.clone().multiplyScalar(8))
    } else if (mode === 'chase-top') {
      // Straight down from above the car: the whole junction in frame.
      const body = new THREE.Vector3(target.position.x, target.position.y, target.position.z)
      eye = body.clone().add(new THREE.Vector3(0, FOLLOW_CHASE_TOP_M, 0))
      look = body.clone()
    } else {
      eye = new THREE.Vector3(target.position.x, target.position.y, target.position.z)
      look = eye.clone().add(forward.clone().multiplyScalar(FOLLOW_LOOK_AHEAD_M))
      look.y = target.position.y - FOLLOW_LOOK_DOWN_M
    }

    // The camera eases toward the driver's eye instead of snapping: a
    // snap puts the whole view at the car in one frame, and the road
    // swinging around the screen reads as a glitch rather than a move.
    //
    // The ease-out runs over `FOLLOW_ENTRY_MS` **milliseconds** and then
    // finishes exactly — a lerp that never converges would leave the
    // view a metre or two behind the car forever. It is timed, not
    // counted in frames: the camera arrives in the same wall-clock
    // time on a slow machine and on a fast one.
    if (!this.following) {
      // Entering: seed the look-at point from where the camera already
      // points, so the ease-out starts from the user's view rather than
      // from a point somewhere in the sky.
      this.following = true
      this.followElapsedMs = 0
      this.followLook.copy(this.camera.position)
      const direction = new THREE.Vector3()
      this.camera.getWorldDirection(direction)
      this.followLook.add(direction.multiplyScalar(FOLLOW_LOOK_AHEAD_M))
    }
    this.followElapsedMs = Math.min(FOLLOW_ENTRY_MS, this.followElapsedMs + dt * 1000)
    const t = this.followElapsedMs / FOLLOW_ENTRY_MS
    const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
    this.camera.position.lerp(eye, eased)
    this.followLook.lerp(look, eased)
    this.camera.lookAt(this.followLook)
    // Keep the orbit controls' target on the look-at point, so leaving
    // the first-person camera starts the orbit from where the user was
    // looking rather than from wherever the orbit camera was parked.
    this.controls?.target?.copy(look)
  }

  /**
   * Hide the vehicle the camera rides in, and show it again when the
   * camera leaves.
   *
   * The camera sits inside the car, so the car's own body would fill
   * the frame. The vehicle keeps its slot — switching the camera back
   * restores it exactly where it was.
   */
  private syncFollowerVisibility(follow: FollowCameraTarget | null): void {
    const vehicles = this.built?.vehicles
    if (!vehicles) return
    // Only the cockpit sits INSIDE the car — a chase view needs the
    // car visible, it is the subject of the shot.
    const wanted =
      follow?.vehicleId && (follow.mode ?? 'cockpit') === 'cockpit' ? follow.vehicleId : null
    if (wanted === this.hiddenFollowerId) return
    if (this.hiddenFollowerId) {
      vehicles.show(this.hiddenFollowerId)
      this.hiddenFollowerId = null
    }
    if (wanted) {
      vehicles.hide(wanted)
      this.hiddenFollowerId = wanted
    }
  }

  /** Rebuild the route ribbon when the route changed. */
  private syncRouteMesh(): void {
    const route = this.getRoute?.() ?? null
    // The comparison is by **identity**: the store hands out the same
    // object for the same route, so an unchanged route costs one pointer
    // comparison per frame — not a string rebuild of the whole polyline.
    if (route === this.routeRef) return
    this.routeRef = route
    if (this.routeMesh) {
      this.scene.remove(this.routeMesh)
      this.routeMesh.geometry.dispose()
      ;(this.routeMesh.material as THREE.Material).dispose()
      this.routeMesh = null
    }
    if (!route) return
    const mesh = buildRouteMesh(route)
    if (!mesh) return
    this.routeMesh = mesh
    this.scene.add(mesh)
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

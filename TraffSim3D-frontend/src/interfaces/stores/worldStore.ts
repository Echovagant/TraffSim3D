import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef, watch } from 'vue'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { FixedStepScheduler } from '@application/services/fixedStepScheduler'
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
  buildElevatedScene,
  buildCorridorScene,
} from '@application/services/defaultScene'
import { tick, type SignalContext } from '@application/services/tick'
import {
  spawnVehicle,
  type SpawnOptions,
  type SpawnResult,
} from '@application/services/spawnVehicle'
import { findNearestLaneOnNetwork } from '@application/services/laneFrameSync'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  createSignalController,
  type SignalController,
  type ControllerKind,
  type SignalActionSource,
} from '@application/services/signalController'
import { COORDINATED_DEFAULT_OFFSET_KEY } from '@application/services/controllers'
import {
  createPolicyActionSource,
  type PolicySignalActionSource,
  type SignalPolicyDecision,
} from '@application/services/signalPolicySource'
import { requestLaneChange as requestLaneChangeFn } from '@domain/services/laneChange'
import { SensorRegistry, type HostPoseLookup } from '@application/services/sensors'
import {
  LidarSensor,
  LidarPointCloud,
  defaultLidarConfig,
  CameraSensor,
  defaultCameraConfig,
} from '@infrastructure/sensors'
import { TrajectoryExporter } from '@infrastructure/export'
import {
  DEFAULT_CONTROLLER_KIND,
  LIDAR_MOUNT_HEIGHT,
  TRAJECTORY_BUFFER_CAP,
  CAMERA_DEFAULT_WIDTH,
  CAMERA_DEFAULT_HEIGHT,
  CAMERA_DEFAULT_FOV,
  MAX_PHYSICS_FRAME_DT,
} from '@shared/constants/simulation'
import { saveScene, loadScene, clearScene } from '@application/use-cases'
import { showFlashMessage } from '@interfaces/composables/useFlashMessage'
import { RapierWorld, buildRigidBodySpec } from '@infrastructure/physics'
import {
  serializeNetwork,
  cloneScene,
  sceneToNetwork,
  type SerializedScene,
} from '@infrastructure/persistence'
import { defaultRLWeights } from '@infrastructure/api'
import type { PolicyWeights } from '@infrastructure/rl/types'
import { computeNetworkBounds } from '@domain/services/networkBounds'

export const TICK_RATE_LADDER = [0.25, 0.5, 1, 2, 4] as const

/**
 * Scene-selector enum. The toolbar dropdown binds to this.
 * 'elevated' (高架桥 — Y-axis ramps + level tagging).
 * 'corridor' (多路口走廊 — 2-intersection corridor demo).
 * 'imported' (any OSM/PBF file loaded via MapImporter —
 *   shown in the toolbar as a read-only label with the source file name
 *   instead of the dropdown, since there's no factory to "switch back to").
 * Adding a new scene = add a factory + an entry here.
 */
export type SceneKind = 'cross' | 't' | 'loop' | 'elevated' | 'corridor' | 'imported'

const buildNetworkByKind = (kind: SceneKind): RoadNetwork => {
  switch (kind) {
    case 'cross':
      return buildCrossIntersectionNetwork()
    case 't':
      return buildTJunctionNetwork()
    case 'loop':
      return buildRectangularLoopNetwork()
    case 'elevated':
      return buildElevatedScene()
    case 'corridor':
      return buildCorridorScene()
    case 'imported':
      // switchScene should never be called with 'imported'
      // (the toolbar hides the dropdown for imported scenes). If a
      // caller does (e.g. undo restores an older state), fall back
      // to cross so we always have a valid network.
      return buildCrossIntersectionNetwork()
  }
}

/** Human-readable label for built-in scene kinds. Imported
 *  scenes use the source filename (set by loadNetwork) instead. */
const sceneLabelForKind = (kind: SceneKind): string => {
  switch (kind) {
    case 'cross':
      return '十字路口'
    case 't':
      return 'T 路口'
    case 'loop':
      return '矩形环'
    case 'elevated':
      return '高架桥'
    case 'corridor':
      return '多路口走廊'
    case 'imported':
      return '已导入'
  }
}

export const useWorldStore = defineStore('world', () => {
  // Fix: `network` is now a `shallowRef`. Earlier we kept it
  // as a plain closure variable mutated in place, but `replaceNetwork`
  // reassigns the variable (`network = next`) — Pinia setup stores do
  // not track plain reassignments, so consumers reading `world.network`
  // (EntityOutline, Inspector) saw the stale initial reference. With
  // shallowRef, Pinia auto-unwraps the ref on the store and re-runs
  // dependents when `.value` changes. shallowRef (not ref) avoids the
  // deep reactivity overhead — the store mutates the network in place
  // per-tick (see tick.ts, addVehicle, etc.) and we don't want every
  // Vehicle.position assignment to trigger a full re-render.
  const network = shallowRef<RoadNetwork>(buildCrossIntersectionNetwork())
  const tickCount = ref(0)
  const fps = ref(0)
  const isRunning = ref(true)

  // Which demo scene is currently loaded. Default 'cross'
  // (the original 4-way intersection). Drives the toolbar dropdown
  // and is read by `switchScene()` to know which factory to call.
  const currentSceneKind = ref<SceneKind>('cross')
  // Human-readable label for the currently loaded scene.
  // - For built-in scenes: '十字路口' / 'T 路口' / etc. (matches
  //   sceneLabel() in EditorToolbar).
  // - For imported OSM/PBF: the original filename (e.g. 'futian.osm').
  //   Set by loadNetwork() callers that have a source name (the
  //   MapImporterView passes `file.name`). Undo/redo restores the
  //   previous label automatically since the network state lives in
  //   history; for cross-corridor switches the label re-derives from
  //   currentSceneKind.
  const currentSceneLabel = ref<string>('十字路口')

  // Discrete tick rate ladder. +/- keys (and the toolbar buttons) cycle
  // through this list. The ladder lives at module scope so the toolbar
  // and shortcut composable can share the same array.
  const tickRate = ref<number>(1)

  // Increments every time the network is replaced (initial
  // load, scene switch, OSM import, undo/redo). Views watch this and
  // call `requestFitToNetwork()` so the camera frames the new scene
  // without the user manually panning. Kept as a separate ref so the
  // fit logic can distinguish "fit because scene changed" from
  // "fit because user pressed the button" — the latter doesn't need
  // to re-debounce.
  const fitRequestTick = ref(0)

  // RL replay surface. `policy` is the loaded SB3 PPO weights
  // (null until loadPolicy() succeeds); `replayTargetId` is the vehicle
  // being driven by the policy; `replayActive` is the toggle so the user
  // can load + dry-run without affecting the sim. `replayStep` counts
  // inference ticks (debug readout for the AI Playground).
  const policy = ref<PolicyWeights | null>(null)
  const replayTargetId = ref<string | null>(null)
  const replayActive = ref(false)
  const replayStep = ref(0)
  const replayLastObs = ref<number[]>([])
  const replayLastAction = ref<[number, number]>([0, 0])

  /** Fetch the named checkpoint's weights via the backend and store
   *  them for replay. Returns `{ ok, ... }` so the caller can flash
   *  an error on failure (e.g. 404 / 503 / network). */
  const loadPolicy = async (
    name: string,
  ): Promise<{ ok: true; obs_dim: number; action_dim: number } | { ok: false; reason: string }> => {
    try {
      const w = await defaultRLWeights.getCheckpointWeights(name)
      // Type-narrowing via duck-typing — the backend shape is fixed
      // by `app/apps/rl/weights.py::export_weights`.
      policy.value = w
      replayStep.value = 0
      return { ok: true, obs_dim: w.obs_dim, action_dim: w.action_dim }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg }
    }
  }

  /** Set which vehicle the loaded policy will drive on the next
   *  `startReplay()`. Does not auto-start replay — explicit user
   *  click required. */
  const setReplayTarget = (vehicleId: string | null): void => {
    replayTargetId.value = vehicleId
  }

  /** Begin driving `replayTargetId` with the loaded policy. Returns
   *  `{ ok: false, reason }` if policy isn't loaded or no target is
   *  set — caller should surface the reason via a flash message. */
  const startReplay = (): { ok: true } | { ok: false; reason: string } => {
    if (!policy.value) return { ok: false, reason: 'no_policy_loaded' }
    if (!replayTargetId.value) return { ok: false, reason: 'no_target_vehicle' }
    replayActive.value = true
    replayStep.value = 0
    return { ok: true }
  }

  /** Stop driving the replay target (falls back to normal Rapier control). */
  const stopReplay = (): void => {
    replayActive.value = false
  }

  /** Drop the loaded policy + target + state. Called on scene switch
   *  / reset so a stale policy never drives the wrong network. */
  const clearPolicy = (): void => {
    policy.value = null
    replayActive.value = false
    replayTargetId.value = null
    replayStep.value = 0
    replayLastObs.value = []
    replayLastAction.value = [0, 0]
  }

  // ===== the traffic-signal policy =====
  //
  // A *second*, different policy: the signal agent's (discrete, 5 actions,
  // 6 observations) as opposed to the ego agent's (continuous, 2 actions,
  // 14 observations). It drives the traffic light, not a vehicle.
  //
  // `signalPolicySource` is the `SignalActionSource` the `RLController`
  // consumes; `signalPolicyDecision` is the last decision it made, for the
  // AI Playground's "the AI is commanding" readout.

  /** The loaded signal policy's weights (null until loaded). */
  const signalPolicy = ref<PolicyWeights | null>(null)
  /** The action source built from `signalPolicy`. */
  const signalPolicySource = shallowRef<PolicySignalActionSource | null>(null)
  /** The policy's most recent decision — the UI's readout. */
  const signalPolicyDecision = ref<SignalPolicyDecision | null>(null)

  /** Load a trained signal policy by checkpoint name.
   *
   * The checkpoint has to be a *discrete* five-action policy: an ego
   * checkpoint (continuous, two actions) would produce a meaningless action
   * index, so it is rejected here rather than silently misbehaving later.
   */
  const loadSignalPolicy = async (
    name: string,
  ): Promise<{ ok: true; obs_dim: number; action_dim: number } | { ok: false; reason: string }> => {
    try {
      const w = await defaultRLWeights.getCheckpointWeights(name)
      const source = createPolicyActionSource(w, (decision) => {
        signalPolicyDecision.value = decision
      })
      signalPolicy.value = w
      signalPolicySource.value = source
      signalPolicyDecision.value = null
      // The RL controllers were built without a source; drop the cache so
      // the next tick creates them with the policy attached.
      controllers = new Map()
      bumpTick()
      return { ok: true, obs_dim: w.obs_dim, action_dim: w.action_dim }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg }
    }
  }

  /** Drop the loaded signal policy. */
  const clearSignalPolicy = (): void => {
    signalPolicy.value = null
    signalPolicySource.value = null
    signalPolicyDecision.value = null
    controllers = new Map()
    bumpTick()
  }

  /** Bump the fit tick so the editor view asks the camera
   *  to re-frame the current network. Idempotent — repeated calls
   *  just reset the same animation. */
  const requestFit = (): void => {
    fitRequestTick.value += 1
  }

  // Monotonic simulation time in seconds. Reset to 0 on `reset()`. Used
  // by tick() to stamp `Vehicle.enteredIntersectionAt` so the cross-road
  // right-of-way rule can pick "the car that got there first".
  let simTime = 0

  // Optional Rapier physics world. Null before useWorldSimulation
  // has finished its async `init()` (which loads the WASM). When null,
  // tick() falls back to the hand-rolled move+s wrap.
  let rapierWorld: RapierWorld | null = null
  const setRapierWorld = (w: RapierWorld | null): void => {
    rapierWorld = w
  }
  const getRapierWorld = (): RapierWorld | null => rapierWorld

  // Editor is currently dragging a vehicle on the 3D canvas. While
  // non-null, tick() skips that vehicle in both the applyControl
  // loop AND the per-frame position re-derivation (otherwise Rapier
  // would overwrite the drag-move on every frame). Lives as a
  // plain `let` (not a ref) — only the renderer's read path and
  // the drag handlers care; no Vue watcher needed.
  let draggingId: string | null = null
  const setDraggingId = (id: string | null): void => {
    draggingId = id
  }
  const getDraggingId = (): string | null => draggingId

  // Per-junction signal controller cache. One SignalController instance
  // per **junction**; lazy-created on first encounter. The junction owns
  // the phase plan and its lights are views of it. Switching
  // controllerKind clears the cache so the new kind's `decide()`
  // semantics take effect immediately.
  let controllers: Map<string, SignalController> = new Map()
  const controllerKind = ref<ControllerKind>(DEFAULT_CONTROLLER_KIND)
  const setControllerKind = (kind: ControllerKind): void => {
    controllerKind.value = kind
    // Force rebuild — different kinds have different `decide()` behavior,
    // so retaining stale controllers would silently mix semantics.
    controllers = new Map()
    bumpTick()
  }
  const getControllerKind = (): ControllerKind => controllerKind.value
  const getControllers = (): Map<string, SignalController> => controllers

  // The RL controller's action source — the trained signal policy, when
  // one is loaded and the RL controller is the active kind.
  const rlActionSource = (): SignalActionSource | undefined =>
    controllerKind.value === 'rl' ? (signalPolicySource.value ?? undefined) : undefined

  const controllerDeps = () => ({
    getCoordinatedOffsets: (): ReadonlyMap<string, number> => coordinatedOffsets.value,
    isCoordinatedEnabled: (): boolean => coordinatedOffsetsEnabled.value,
    rlActionSource: rlActionSource(),
  })

  /** The controller of a junction, created on demand. */
  const controllerFor = (junctionId: string): SignalController => {
    const cached = controllers.get(junctionId)
    if (cached) return cached
    const created = createSignalController(controllerKind.value, controllerDeps())
    controllers.set(junctionId, created)
    return created
  }

  const signalContext: SignalContext = {
    // A **getter**, not a snapshot: `controllers` is reassigned whenever the
    // controller kind or the signal policy changes (so the cached
    // controllers are rebuilt with the new semantics). Copying the Map by
    // value here would leave the tick using the stale one.
    get controllers() {
      return controllers
    },
    get controllerKind() {
      return controllerKind.value
    },
    getCoordinatedOffsets: () => coordinatedOffsets.value,
    isCoordinatedEnabled: () => coordinatedOffsetsEnabled.value,
    getRlActionSource: rlActionSource,
  }

  /**
   * Force every junction to AllRed for `durationSeconds`.
   *
   * The lights are written directly, so the change is visible at once;
   * the junction's **plan** is told about it as well, so the junction
   * holds the all-red and then resumes the phase it was interrupted in
   * (with the time it had left) — the same contract the RL's
   * `force_all_red` action has.
   */
  const forceAllRed = (durationSeconds = 3): void => {
    for (const inter of Object.values(network.value.intersections)) {
      for (const light of inter.trafficLights) {
        light.phase = LightPhase.AllRed
        light.phaseRemaining = durationSeconds
      }
      controllerFor(inter.id).applyAction(inter, 'force_all_red')
    }
    bumpTick()
  }

  // Per-vehicle sensor + per-tick trajectory export.
  const sensorRegistry = new SensorRegistry()
  const trajectoryExporter = new TrajectoryExporter(TRAJECTORY_BUFFER_CAP)
  const lidarEnabled = ref(false)
  const lidarFrameCount = ref(0)
  const setLidarEnabled = (enabled: boolean): void => {
    lidarEnabled.value = enabled
    if (!enabled) lidarFrameCount.value = 0
    bumpTick()
  }
  const toggleLidar = (): void => setLidarEnabled(!lidarEnabled.value)

  // Fixed-step scheduler driving the trajectory exporter
  // at 10 Hz. Lives as a plain closure var (not a ref) — the renderer
  // doesn't need to react to it; only tick() reads its state.
  const fixedStepScheduler = new FixedStepScheduler({ fixedStepSec: 0.1 })

  // Coordinated UI hooks — the green wave.
  //
  // The offsets are consulted by the CoordinatedController, which reads
  // them **per junction**: a junction's whole plan is shifted by its
  // offset against the common reference, and that shift is the wave.
  //
  // `COORDINATED_DEFAULT_OFFSET_KEY` ('r-ns|r-ew') is the corridor-wide
  // default: a junction without an explicit offset inherits it. It is
  // the key the editor has always written, so the existing UI keeps
  // working.
  const coordinatedOffsets = ref<Map<string, number>>(
    new Map([
      // Key: a junction id (its own offset) or the corridor default.
      // Value: seconds the junction's green is shifted. Default 0 = no
      // offset.
      [COORDINATED_DEFAULT_OFFSET_KEY, 0],
    ]),
  )
  const coordinatedOffsetsEnabled = ref(false)

  /**
   * Set a junction's green-wave offset (or the corridor-wide default).
   *
   * `key` is a junction id, or `COORDINATED_DEFAULT_OFFSET_KEY` for the
   * corridor-wide default.
   */
  const setCoordinatedOffset = (key: string, seconds: number): void => {
    const next = new Map(coordinatedOffsets.value)
    next.set(key, Math.max(-30, Math.min(30, seconds)))
    coordinatedOffsets.value = next
  }
  const toggleCoordinatedOffsets = (on: boolean): void => {
    coordinatedOffsetsEnabled.value = on
  }

  /** Lookup host vehicle's live pose — used by SensorRegistry.scanAll.
   *  Reads from the (mutating) network object; safe because tick() is
   *  the only writer of vehicle position, and the scan runs after
   *  Rapier step + position re-derivation in tick(). */
  const getHostPose: HostPoseLookup = (vehicleId) => {
    const v = network.value.vehicles[vehicleId]
    if (!v) return null
    return { position: v.position, heading: v.heading }
  }

  // LiDAR point cloud visualization + camera sensor.
  // The point cloud meshes are added to the scene by the renderer
  // (via addAuxiliary) when lidarCloudsEnabled is true. The cloud
  // map is keyed by vehicleId; meshes are destroyed on removeVehicle.
  let lidarPointClouds: Map<string, LidarPointCloud> = new Map()
  const lidarCloudsEnabled = ref(false)
  const setLidarCloudsEnabled = (enabled: boolean): void => {
    lidarCloudsEnabled.value = enabled
    // Note: point clouds require LiDAR to be enabled first. We don't
    // auto-enable LiDAR here to avoid confusing users. If LiDAR is not
    // enabled, the point clouds will simply not receive updates.
    bumpTick()
  }
  const toggleLidarClouds = (): void => setLidarCloudsEnabled(!lidarCloudsEnabled.value)
  const getLidarPointClouds = (): Map<string, LidarPointCloud> => lidarPointClouds

  /** Lazily create a LidarPointCloud for a vehicle. The renderer
   *  (in useWorldSimulation) calls this when lidarCloudsEnabled
   *  flips true to backfill clouds for vehicles that already exist. */
  const ensureLidarCloud = (vehicleId: string): LidarPointCloud => {
    let cloud = lidarPointClouds.get(vehicleId)
    if (!cloud) {
      cloud = new LidarPointCloud(5760)
      lidarPointClouds.set(vehicleId, cloud)
    }
    return cloud
  }

  /** Camera sensor. Lazily created on first enable so the
   *  WebGLRenderTarget is only allocated when actually used. */
  const cameraSensor = shallowRef<CameraSensor | null>(null)
  const cameraEnabled = ref(false)
  const cameraFrameCount = ref(0)
  const setCameraEnabled = (enabled: boolean): void => {
    cameraEnabled.value = enabled
    if (!enabled) {
      if (cameraSensor.value) {
        cameraSensor.value.destroy()
        cameraSensor.value = null
      }
      cameraFrameCount.value = 0
      lidarFrameCount.value = 0
    }
    bumpTick()
  }
  const toggleCamera = (): void => setCameraEnabled(!cameraEnabled.value)
  const getCameraSensor = (): CameraSensor | null => cameraSensor.value

  const initCameraSensor = (vehicleId: string): CameraSensor => {
    if (cameraSensor.value) return cameraSensor.value
    cameraSensor.value = new CameraSensor(defaultCameraConfig(vehicleId))
    return cameraSensor.value
  }

  // History for undo/redo. Each entry is a full SerializedScene JSON
  // string. Bounded to 50 entries to keep memory predictable; oldest
  // entries are dropped on overflow. Cleared on hydrate/reset (loading
  // a new scene is not undoable — it's the user's explicit decision).
  const HISTORY_LIMIT = 50
  /**
   * Undo / redo stacks.
   *
   * These are `shallowRef`s, NOT plain `let` arrays. The toolbar's
   * 撤销 / 重做 buttons call `canUndo()` / `canRedo()` **inside their
   * render function**, so the stack depth has to be a reactive
   * dependency. With a plain array the action was real (Ctrl+Z undid
   * the edit) but the button never repainted — the control said "you
   * cannot undo" while the undo worked.
   *
   * `shallowRef` rather than `ref` because every entry is a full
   * serialized scene: deep reactivity would proxy the whole road
   * network on every push. The arrays are mutated in place, so every
   * mutation site must call `triggerRef()` to notify the dependents.
   */
  const history = shallowRef<SerializedScene[]>([])
  const redoStack = shallowRef<SerializedScene[]>([])

  /**
   * Push the current network state to the history stack. Called by
   * every user-initiated mutation (add/remove/edit). Skipped during
   * tick simulation (tick mutates position/speed every frame, which
   * would fill the history in <1 second).
   *
   * Clears the redo stack — any new mutation invalidates the redo
   * trail (standard undo/redo semantic).
   */
  const pushHistory = (): void => {
    history.value.push(cloneScene(serializeNetwork(network.value)))
    if (history.value.length > HISTORY_LIMIT) {
      history.value.shift() // drop oldest
    }
    redoStack.value = []
    triggerRef(history)
    triggerRef(redoStack)
  }

  /**
   * Editor dropped a vehicle at `position`. Update the entity's
   * position, sync the Rapier body, and re-snap to the nearest lane
   * (across the whole network — the user may have dropped on a
   * different road) so future ticks resume lane-based movement.
   *
   * The re-snap is what makes the next tick "know" where the
   * vehicle is on the lane graph — without it, the vehicle would
   * snap back to its old `s` on the next frame.
   *
   * Returns `{ ok: true }` on success, `{ ok: false, reason }` if
   * the vehicle id is unknown. The caller (useEditor) uses the
   * return value to decide whether to keep or clear the drag.
   */
  const moveVehicleTo = (
    vehicleId: string,
    position: { x: number; y: number; z: number },
  ): { ok: true } | { ok: false; reason: string } => {
    const v = network.value.vehicles[vehicleId]
    if (!v) return { ok: false, reason: 'vehicle not found' }
    pushHistory()
    v.position = { x: position.x, y: position.y, z: position.z }
    if (rapierWorld) {
      rapierWorld.setVehiclePosition(vehicleId, v.position)
    }
    // Re-snap to the nearest lane across the whole network. If the
    // drop point is far from any lane (e.g. mid-intersection with
    // no road near the cursor), keep the entity's existing roadId
    // / laneIndex / s — the next tick will derive a sensible
    // position via findNearestLane anyway.
    const snap = findNearestLaneOnNetwork(network.value, v.position)
    if (snap) {
      v.roadId = snap.roadId
      v.laneIndex = snap.laneIndex
      v.s = snap.s
    }
    bumpTick()
    return { ok: true }
  }

  const togglePause = (): void => {
    isRunning.value = !isRunning.value
  }
  const setRunning = (running: boolean): void => {
    isRunning.value = running
  }
  const setTickRate = (rate: number): void => {
    tickRate.value = rate
  }
  const cycleTickRate = (direction: 1 | -1): void => {
    const ladder = TICK_RATE_LADDER
    const idx = ladder.findIndex((r) => r === tickRate.value)
    // If the current value isn't in the ladder (shouldn't happen, but be safe),
    // start from 1×. Then move with wrap-around.
    const cur = idx === -1 ? ladder.findIndex((r) => r === 1) : idx
    const next = (cur + direction + ladder.length) % ladder.length
    tickRate.value = ladder[next]!
  }

  // ===== frame-time / FPS measurement =====
  //
  // The `dt` that reaches step() is clamped twice on its way in: the
  // renderer caps it at 0.1 s (tab-switch guard) and the store caps it
  // at 1/30 s (anti-tunnelling guard). Measuring frame times from that
  // value made a 20 fps page read as 30 fps and pinned the reported
  // frame time at 33.3 ms — the readouts could not describe a slow
  // frame at all.
  //
  // step() is called exactly once per rendered frame (the renderer's
  // rAF loop is its only caller), so the wall-clock gap between two
  // consecutive calls IS the frame interval. That is what is measured
  // now: `performance.now()` deltas, never the clamped dt. The FPS
  // number is therefore the real render rate and can go below 30 fps
  // or report a frame longer than 33.3 ms.
  //
  // A gap longer than FRAME_SAMPLE_MAX_GAP_MS means the simulation was
  // not running (paused / route change / backgrounded tab) rather than
  // a slow frame. Such samples are dropped and the rolling window is
  // restarted, so a 10 s pause cannot masquerade as a 10 s frame.
  const FRAME_SAMPLE_MAX_GAP_MS = 1000

  let lastStepAtMs: number | null = null
  let frameCount = 0
  let fpsWindowMs = 0
  let lastFpsUpdateMs = performance.now()

  // Frame-time rolling window (30 frames, ~0.5s at 60fps).
  // `Min` starts at Infinity so the first frame sets it correctly.
  // `Max` starts at -Infinity so the DebugPanel can show "0.0" until a
  // frame arrives (the formatter below guards against the otherwise
  // misleading "0.0 ms max" on first load).
  const frameMsMin = ref(Infinity)
  const frameMsMax = ref(-Infinity)
  const frameMsAvg = ref(0)
  let frameWindowMs = 0
  let frameWindowCount = 0

  // A pause stops the renderer from calling step(), so the first
  // sample after resuming would span the whole pause. Drop the
  // baseline on every pause / resume so the pause gap is never
  // counted as a slow frame.
  watch(isRunning, () => {
    lastStepAtMs = null
  })

  /** Clear the FPS / frame-time readouts and restart the measurement
   *  window. Called by a view that mounts a fresh renderer, so the
   *  readouts describe the current session instead of the previous
   *  route's leftovers. */
  const resetFrameStats = (): void => {
    fps.value = 0
    frameMsMin.value = Infinity
    frameMsMax.value = -Infinity
    frameMsAvg.value = 0
    frameWindowMs = 0
    frameWindowCount = 0
    frameCount = 0
    fpsWindowMs = 0
    lastStepAtMs = null
    lastFpsUpdateMs = performance.now()
  }

  const step = (dt: number): number => {
    // Clamp dt (I5): 防止卡顿后大跳跃穿模, AND 防止 rAF 边界
    // 偶发的负 dt 进入仿真推进 (会把车辆位置往回推). 上下界都 clamp 后
    // simTime/tick 都用同一个值.
    // 注意: 帧率 / 帧耗时**不**用这个值 — 它们测的是真实的帧间隔,
    // 见下面的 frame-time 统计块.
    //
    // The upper bound used to be 1/30 s, which meant the simulation only
    // ever advanced a 30 Hz frame's worth of time no matter how slow the
    // render loop was: at 15 fps the world ran at half speed. The physics
    // layer now consumes the frame's time in **fixed sub-steps**
    // (`RapierWorld.step`), so the anti-tunnelling guarantee comes from
    // the sub-step length instead of from the frame dt — and the frame dt
    // can be left alone, which is what makes the simulation speed
    // independent of the frame rate.
    //
    // The bound is still there, for the case where the tab was backgrounded
    // and came back with an enormous dt: `MAX_PHYSICS_FRAME_DT` is the
    // physics layer's own limit, and this one matches it.
    const clampedDt = Math.max(0, Math.min(dt, MAX_PHYSICS_FRAME_DT))
    simTime += clampedDt
    tick(network.value, clampedDt, simTime, {
      rapierWorld,
      signal: signalContext,
      trajectoryExporter,
      sensorRegistry,
      lidarEnabled: lidarEnabled.value,
      getHostPose,
      draggingId,
      removeVehicle, // OOB cleanup entry point
      fixedStepScheduler, // drives trajectory export at 10 Hz
      // Pass policy + replay target to tick. tick() reads
      // `replayTargetId` and computes obs + inference each step. The
      // store keeps the always-current refs so flipping `replayActive`
      // takes effect on the very next tick.
      policy: policy.value,
      replayTargetId: replayActive.value ? replayTargetId.value : null,
    })
    // Re-apply the user's speed pins. `tick()` owns the speed
    // computation and always re-derives it from the road limit, so
    // the pins have to be re-applied *after* it — otherwise a pin
    // would last exactly one frame (the bug this replaces).
    applySpeedOverrides()
    // Update LiDAR frame counter from sensorRegistry's actual scan count
    // (not per-tick). The registry tracks frames produced (throttled scans only).
    if (lidarEnabled.value) {
      lidarFrameCount.value = sensorRegistry.frameCount
    }

    // Refresh LidarPointCloud meshes from the latest frames
    // cached by sensorRegistry.scanAll(). Each cloud is positioned
    // at its host vehicle's current pose (which is post-Rapier-step).
    if (lidarCloudsEnabled.value) {
      for (const [vehicleId, frame] of sensorRegistry.getLatestFrames()) {
        const cloud = lidarPointClouds.get(vehicleId)
        const v = network.value.vehicles[vehicleId]
        if (cloud && v) {
          cloud.updateFromFrame(frame)
          cloud.setPose(v.position, v.heading)
        }
      }
    }

    tickCount.value += 1

    // Frame-time stats + FPS, measured from the wall clock between
    // two consecutive frames (see the measurement block above). The
    // clamped `dt` is deliberately NOT used here — it can never
    // describe a frame slower than 33.3 ms.
    const nowMs = performance.now()
    const elapsedMs = lastStepAtMs === null ? null : nowMs - lastStepAtMs
    lastStepAtMs = nowMs
    if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= FRAME_SAMPLE_MAX_GAP_MS) {
      // No sample yet, or the sim was not running (pause / route
      // change / backgrounded tab): drop the stale window so the
      // averages describe the current run.
      frameCount = 0
      fpsWindowMs = 0
      frameWindowMs = 0
      frameWindowCount = 0
    } else {
      frameMsMin.value = Math.min(frameMsMin.value, elapsedMs)
      frameMsMax.value = Math.max(frameMsMax.value, elapsedMs)
      frameWindowMs += elapsedMs
      frameWindowCount += 1
      if (frameWindowCount >= 30) {
        frameMsAvg.value = frameWindowMs / frameWindowCount
        frameWindowMs = 0
        frameWindowCount = 0
      }
      frameCount += 1
      fpsWindowMs += elapsedMs
    }

    // FPS rolling window (500 ms of wall clock)
    if (nowMs - lastFpsUpdateMs >= 500) {
      if (fpsWindowMs > 0) fps.value = Math.round((frameCount * 1000) / fpsWindowMs)
      frameCount = 0
      fpsWindowMs = 0
      lastFpsUpdateMs = nowMs
    }

    // Returned to the renderer so it can drive flashing light phases
    // (FlashingYellow 1Hz / FlashingRed 0.5Hz) without the renderer
    // holding its own clock — there is one sim time in the system.
    return simTime
  }

  const reset = () => {
    // Reset physics: remove all bodies, rebuild network.
    if (rapierWorld) {
      for (const id of Object.keys(network.value.vehicles)) {
        rapierWorld.removeVehicle(id)
      }
    }
    // Clear any loaded RL policy so it can't drive the
    // fresh network's vehicles with stale target ids.
    clearPolicy()
    history.value = []
    redoStack.value = []
    controllers = new Map()
    sensorRegistry.destroyAll()
    trajectoryExporter.clear()
    // Tear down point clouds + camera sensor.
    for (const cloud of lidarPointClouds.values()) cloud.destroy()
    lidarPointClouds = new Map()
    if (cameraSensor.value) {
      cameraSensor.value.destroy()
      cameraSensor.value = null
    }
    cameraFrameCount.value = 0
    lidarFrameCount.value = 0
    network.value = buildCrossIntersectionNetwork()
    speedOverrides.clear()
    simTime = 0
    fixedStepScheduler.reset() // zero out the 10 Hz cadence
    // Re-register default vehicles.
    if (rapierWorld) {
      for (const v of Object.values(network.value.vehicles)) {
        rapierWorld.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
        // Re-mount LiDAR for the default vehicles.
        const colliderHandle = rapierWorld.getColliderHandle(v.id)
        const excludes = colliderHandle ? [colliderHandle] : []
        const sensor = new LidarSensor(defaultLidarConfig(v.id, excludes))
        sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[v.type] })
        sensorRegistry.register(v.id, sensor, `lidar-${v.id}`)
        // Backfill point clouds.
        if (lidarCloudsEnabled.value) ensureLidarCloud(v.id)
      }
    }
    tickCount.value += 1
  }

  const getNetwork = (): RoadNetwork => network.value

  const bumpTick = () => {
    tickCount.value += 1
  }
  const notifyChange = bumpTick

  let nextVehicleNum = Object.keys(network.value.vehicles).length + 1
  let nextLightNum =
    Object.values(network.value.intersections).reduce((s, i) => s + i.trafficLights.length, 0) + 1

  const addVehicle = (overrides: Partial<Vehicle> & Partial<SpawnOptions> = {}): SpawnResult => {
    pushHistory()
    const id = overrides.id ?? `v-${nextVehicleNum++}`
    // `spawnVehicle` handles picking a road/lane/s that's free, picking
    // a type with weighted random, and assigning the correct world
    // position + heading. If every lane is full (density check),
    // it returns `{ ok: false, reason }` and we surface a flash
    // message — we never silently place a colliding car.
    const spawnOpts: SpawnOptions = {
      type: overrides.type,
      color: overrides.color,
      speed: overrides.speed,
    }
    const result = spawnVehicle(network.value, id, spawnOpts)
    if (!result.ok) {
      showFlashMessage('交通密度已满 — 现有车道都无法再放车了', 'error')
      return result
    }
    network.value.vehicles[result.vehicle.id] = result.vehicle
    // Register the new body in Rapier (no-op when Rapier is not yet
    // initialised — useWorldSimulation will re-register on init).
    if (rapierWorld) {
      rapierWorld.registerVehicle(
        buildRigidBodySpec(
          result.vehicle.id,
          result.vehicle.type,
          result.vehicle.position,
          result.vehicle.heading,
        ),
      )
      // Mount a LiDAR sensor. The collider handle is needed
      // for self-occlusion filtering. If Rapier didn't
      // create a collider, the sensor still works (no exclusions).
      const colliderHandle = rapierWorld.getColliderHandle(result.vehicle.id)
      const excludes = colliderHandle ? [colliderHandle] : []
      const sensor = new LidarSensor(defaultLidarConfig(result.vehicle.id, excludes))
      sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[result.vehicle.type] })
      sensorRegistry.register(result.vehicle.id, sensor, `lidar-${result.vehicle.id}`)
      // Lazily create a LidarPointCloud if clouds are enabled.
      if (lidarCloudsEnabled.value) {
        ensureLidarCloud(result.vehicle.id)
      }
    }
    bumpTick()
    return result
  }

  // One-click spawn many vehicles for Rapier collision demo.
  // Returns the number actually added; bails on first full lane so
  // we don't spam the user with "lane full" flashes.
  const spawnMany = (count: number): number => {
    let ok = 0
    for (let i = 0; i < count; i++) {
      const r = addVehicle()
      if (r.ok) ok += 1
      else break
    }
    return ok
  }

  const removeVehicle = (id: string): void => {
    pushHistory()
    // A pin on a deleted vehicle is meaningless — drop it, otherwise
    // the id could be reused later and would silently re-pin.
    speedOverrides.delete(id)
    // Unregister sensors BEFORE removing the Rapier body.
    // The body removal deletes the collider handle that the sensor
    // needs for excludeColliders, so the order is critical.
    sensorRegistry.unregisterAllFor(id)
    // Tear down the LidarPointCloud mesh.
    const cloud = lidarPointClouds.get(id)
    if (cloud) {
      cloud.destroy()
      lidarPointClouds.delete(id)
    }
    if (rapierWorld) rapierWorld.removeVehicle(id)
    delete network.value.vehicles[id]
    bumpTick()
  }

  /**
   * Persistent, user-set speed overrides in m/s, keyed by vehicle id.
   *
   * The Inspector used to write `v.speed` once and stop there: the
   * next tick's `applyControl` re-derived the speed from the road's
   * speed limit, so the number the user typed was gone within one
   * frame. The control looked editable but was a single-frame lie
   * (set 90 km/h → next tick reads back 59.4).
   *
   * An override is a **pin**: while it is set, the vehicle keeps that
   * speed across ticks. The pin is re-applied after every `tick()`
   * (see `applySpeedOverrides`) because `tick()` owns the speed
   * computation and cannot be told about a user override.
   *
   * Semantics of a pin (documented in the Inspector too): the pinned
   * vehicle keeps its speed even at a red light. That is what "pin"
   * means — the user has taken the vehicle out of the signal
   * controller's hands. It is deliberately NOT a "cruise control
   * setpoint", because a setpoint cannot raise the speed above the
   * road limit, and the user asked for 90 km/h on a 30 km/h road.
   */
  const speedOverrides = new Map<string, number>()

  /**
   * Re-pin every vehicle the user has overridden. Called at the end of
   * `step()`, i.e. after `tick()` has recomputed the speeds.
   *
   * The replay path is excluded entirely: the policy owns the replay
   * target's speed, and the Python-side contract compares the replay
   * state bit-for-bit (`docs/contracts/sim-snapshot.md`). Applying an
   * override during a replay would change the world the replay runs
   * in, so the overrides are suspended for the duration of a replay
   * and re-applied once it stops.
   */
  const applySpeedOverrides = (): void => {
    if (speedOverrides.size === 0) return
    if (replayActive.value) return
    for (const [id, mps] of speedOverrides) {
      const v = network.value.vehicles[id]
      if (!v) {
        // The vehicle is gone (deleted / OOB cleanup) — drop the pin.
        speedOverrides.delete(id)
        continue
      }
      v.targetSpeed = mps
      v.speed = mps
      if (rapierWorld) {
        rapierWorld.setVehicleSpeed(id, mps, v.heading)
      }
    }
  }

  /**
   * User-edited a vehicle's speed via the Inspector.
   *
   * The value is stored as a **persistent pin** (see
   * `speedOverrides`): it survives ticks until the user clears it
   * (`clearVehicleSpeedOverride`). The Rapier body's linear velocity
   * is updated immediately so the 3D scene reflects the change on the
   * very next frame instead of waiting for the next `tick()`.
   */
  const setVehicleSpeed = (vehicleId: string, speedKmh: number): void => {
    const v = network.value.vehicles[vehicleId]
    if (!v) return
    pushHistory()
    const mps = Math.max(0, speedKmh) / 3.6 // km/h → m/s
    speedOverrides.set(vehicleId, mps)
    v.targetSpeed = mps
    v.speed = mps
    if (rapierWorld) {
      rapierWorld.setVehicleSpeed(vehicleId, mps, v.heading)
    }
    bumpTick()
  }

  /**
   * Release the speed pin on a vehicle: the vehicle goes back under
   * the road's speed limit + the signal / car-following constraints.
   */
  const clearVehicleSpeedOverride = (vehicleId: string): void => {
    if (!speedOverrides.delete(vehicleId)) return
    bumpTick()
  }

  /** The pinned speed of a vehicle in m/s (null when not pinned). */
  const getVehicleSpeedOverride = (vehicleId: string): number | null =>
    speedOverrides.get(vehicleId) ?? null

  // Lane change: domain decision + state mutation.
  // Returns the same shape as `requestLaneChange` (the domain function)
  // so the caller can flash the reason on rejection.
  const requestLaneChange = (
    vehicleId: string,
    direction: 'left' | 'right',
  ): { ok: boolean; reason?: string } => {
    const v = network.value.vehicles[vehicleId]
    if (!v) return { ok: false, reason: 'not-found' }
    const r = requestLaneChangeFn(v, direction, network.value, simTime)
    if (r.ok) {
      v.desiredLaneIndex = v.laneIndex + (direction === 'left' ? 1 : -1)
      v.laneChangeStartedAt = simTime
      bumpTick()
    }
    return r
  }

  /**
   * User-edited a vehicle's type via the Inspector. Mutate the
   * entity field, then ask Rapier to re-register the body with the
   * new type's mass + halfExtents.
   */
  const updateVehicleType = (vehicleId: string, newType: Vehicle['type']): void => {
    const v = network.value.vehicles[vehicleId]
    if (!v) return
    pushHistory()
    v.type = newType
    if (rapierWorld) {
      rapierWorld.updateVehicleType(vehicleId, newType)
    }
    bumpTick()
  }

  const addTrafficLight = (overrides: Partial<TrafficLight> = {}): TrafficLight | null => {
    pushHistory()
    const inter = Object.values(network.value.intersections)[0]
    if (!inter) return null
    const id = overrides.id ?? `tl-${nextLightNum++}`
    const angle = (inter.trafficLights.length * Math.PI) / 2 // N, E, S, W
    const light: TrafficLight = {
      id,
      position: overrides.position ?? {
        x: inter.position.x + Math.cos(angle) * 4,
        y: 0,
        z: inter.position.z + Math.sin(angle) * 4,
      },
      phase: overrides.phase ?? LightPhase.Red,
      phaseRemaining: overrides.phaseRemaining ?? 30,
      cycleSeconds: overrides.cycleSeconds ?? 63,
      axis: overrides.axis ?? 'ns',
    }
    inter.trafficLights.push(light)
    bumpTick()
    return light
  }

  const removeTrafficLight = (id: string): void => {
    pushHistory()
    for (const inter of Object.values(network.value.intersections)) {
      inter.trafficLights = inter.trafficLights.filter((l) => l.id !== id)
    }
    bumpTick()
  }

  // ----- persistence -----

  /**
   * Sidecar key holding the *scene metadata* (which built-in scene the
   * saved network came from, and its human-readable label).
   *
   * The serialized scene document itself only holds the network —
   * adding a field to it would bump the schema version, and the
   * serializer is not this file's to change. A separate key keeps the
   * scene document byte-compatible while letting a restored scene keep
   * the label the toolbar shows.
   */
  const SCENE_META_KEY = 'traffsim3d:scene-meta'

  interface SceneMeta {
    kind: SceneKind
    label: string
  }

  const writeSceneMeta = (): void => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(
        SCENE_META_KEY,
        JSON.stringify({ kind: currentSceneKind.value, label: currentSceneLabel.value }),
      )
    } catch {
      // Metadata is best-effort: a full / disabled LocalStorage must
      // not turn a successful scene save into a failure.
    }
  }

  const readSceneMeta = (): SceneMeta | null => {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(SCENE_META_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<SceneMeta>
      if (typeof parsed.kind !== 'string' || typeof parsed.label !== 'string') return null
      return { kind: parsed.kind as SceneKind, label: parsed.label }
    } catch {
      return null
    }
  }

  const serialize = (): { ok: true } | { ok: false; reason: string } => {
    try {
      saveScene(network.value)
      writeSceneMeta()
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg }
    }
  }

  /**
   * Internal helper used by both `hydrate()` (which loads from
   * LocalStorage) and `loadNetwork()` (which accepts an already-
   * parsed network from an imported file). Tears down the old
   * Rapier bodies, swaps the network, and re-registers the new
   * vehicles. Returns `{ ok: true }`; the network reference is
   * always replaced as long as we got here (the caller has already
   * validated the input).
   */
  const replaceNetwork = (next: RoadNetwork): { ok: true } => {
    // Remove old bodies
    if (rapierWorld) {
      for (const id of Object.keys(network.value.vehicles)) {
        rapierWorld.removeVehicle(id)
      }
    }
    // Same as reset() — never let a stale policy drive the
    // new network's vehicles. The user's selected replay target id may
    // not even exist in the loaded scene.
    clearPolicy()
    // Assign via .value so Pinia's auto-unwrap on the store
    // surfaces the new network to EntityOutline, InspectorPanel, etc.
    network.value = next
    // The pins belong to the old network's vehicles — they must not
    // silently apply to a different scene (or to an id that happens to
    // repeat in the restored one).
    speedOverrides.clear()
    // Clear controller cache + sensors + exporter — new scene has
    // different light IDs and vehicle IDs.
    controllers = new Map()
    sensorRegistry.destroyAll()
    trajectoryExporter.clear()
    // Tear down point clouds + camera sensor.
    for (const cloud of lidarPointClouds.values()) cloud.destroy()
    lidarPointClouds = new Map()
    if (cameraSensor.value) {
      cameraSensor.value.destroy()
      cameraSensor.value = null
    }
    cameraFrameCount.value = 0
    lidarFrameCount.value = 0
    // Re-register new vehicles
    if (rapierWorld) {
      for (const v of Object.values(network.value.vehicles)) {
        rapierWorld.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
        // Re-mount LiDAR.
        const colliderHandle = rapierWorld.getColliderHandle(v.id)
        const excludes = colliderHandle ? [colliderHandle] : []
        const sensor = new LidarSensor(defaultLidarConfig(v.id, excludes))
        sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[v.type] })
        sensorRegistry.register(v.id, sensor, `lidar-${v.id}`)
        // Backfill point clouds.
        if (lidarCloudsEnabled.value) ensureLidarCloud(v.id)
      }
    }
    bumpTick() // signal Vue watchers; the renderer will rebuild via identity change
    // Bump fit request so the editor view re-frames the camera.
    fitRequestTick.value += 1
    return { ok: true }
  }

  const hydrate = (): { ok: true } | { ok: false; reason: string } => {
    const result = loadScene()
    if (!result.ok) return result
    // Loading a new scene is the user's explicit decision — not undoable.
    history.value = []
    redoStack.value = []
    return replaceNetwork(result.network)
  }

  /**
   * Replace the current network with an already-validated `RoadNetwork`
   * (e.g. one produced by `importSceneFile`). Bypasses the LocalStorage
   * round-trip — the caller has already done the validation that
   * `hydrate()` would do via `loadScene()`.
   *
   * `sourceLabel` is the human-readable name shown in the
   * toolbar's scene indicator (e.g. the imported file name). When
   * omitted, the existing label is kept. Any call with a non-empty
   * `sourceLabel` flips `currentSceneKind` to `'imported'` so the
   * toolbar hides the scene-kind dropdown and shows the file name
   * instead.
   */
  const loadNetwork = (next: RoadNetwork, sourceLabel?: string): { ok: true } => {
    if (sourceLabel) {
      currentSceneKind.value = 'imported'
      currentSceneLabel.value = sourceLabel
    }
    return replaceNetwork(next)
  }

  const clearStorage = (): { ok: true } => {
    clearScene()
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(SCENE_META_KEY)
      } catch {
        // Ignore — the scene payload is already gone.
      }
    }
    return { ok: true }
  }

  /**
   * Restore the saved scene — called once when the store is created,
   * i.e. on application start.
   *
   * Before this, 保存 wrote the scene to LocalStorage and nothing ever
   * read it back automatically: a page refresh silently threw the
   * saved scene away and the user had to press 加载 to get it back.
   * The save button looked like it had done nothing.
   *
   * Returns `{ restored: true }` when a scene was restored and
   * `{ restored: false, reason }` when there was nothing to restore
   * (or the stored payload was unusable — the default scene stays).
   */
  const restoreSavedScene = (): { restored: boolean; reason?: string } => {
    if (typeof localStorage === 'undefined') return { restored: false, reason: 'no localStorage' }
    const result = loadScene()
    if (!result.ok) return { restored: false, reason: result.reason }
    // Restoring is not an undoable user edit — it is the app coming
    // back up with the state the user left behind.
    history.value = []
    redoStack.value = []
    const meta = readSceneMeta()
    if (meta) {
      currentSceneKind.value = meta.kind
      currentSceneLabel.value = meta.label
    } else {
      // Saved before the metadata sidecar existed: the provenance of
      // the network is unknown, so it is labelled as such instead of
      // claiming one of the built-in scenes.
      currentSceneKind.value = 'imported'
      currentSceneLabel.value = '已保存的场景'
    }
    replaceNetwork(result.network)
    showFlashMessage('已恢复上次保存的场景', 'info')
    return { restored: true }
  }

  /**
   * Switch the loaded scene to one of the three demo
   * factories. Clears the Rapier body / sensor / controller caches
   * via the existing `loadNetwork` path (which removes old bodies
   * and re-registers the new vehicles' bodies). Also clears undo
   * history — switching scenes is not a small enough mutation that
   * undo across the boundary would be meaningful.
   */
  const switchScene = (kind: SceneKind): { ok: true } => {
    const next = buildNetworkByKind(kind)
    history.value = []
    redoStack.value = []
    currentSceneKind.value = kind
    if (kind === 'imported') {
      // Callers must pass a label via loadNetwork() before
      // calling switchScene('imported') (or just call loadNetwork
      // directly). For safety, fall back to the current label.
    } else {
      currentSceneLabel.value = sceneLabelForKind(kind)
    }
    return loadNetwork(next)
  }

  /**
   * Undo the last user-initiated mutation. Pops the current state to
   * the redo stack, then restores the network from the popped history
   * entry. If history is empty, no-op (returns false).
   *
   * After restore: re-registers Rapier bodies via the existing
   * loadNetwork path (which removes old bodies + registers new).
   */
  const undo = (): boolean => {
    if (history.value.length === 0) return false
    const previous = history.value.pop()!
    redoStack.value.push(cloneScene(serializeNetwork(network.value)))
    if (redoStack.value.length > HISTORY_LIMIT) redoStack.value.shift()
    triggerRef(history)
    triggerRef(redoStack)
    const restored = sceneToNetwork(previous)
    // Use loadNetwork to re-register Rapier bodies
    loadNetwork(restored)
    return true
  }

  /**
   * Redo the last undone mutation. Mirror of undo().
   */
  const redo = (): boolean => {
    if (redoStack.value.length === 0) return false
    const next = redoStack.value.pop()!
    history.value.push(cloneScene(serializeNetwork(network.value)))
    if (history.value.length > HISTORY_LIMIT) history.value.shift()
    triggerRef(history)
    triggerRef(redoStack)
    const restored = sceneToNetwork(next)
    loadNetwork(restored)
    return true
  }

  const canUndo = (): boolean => history.value.length > 0
  const canRedo = (): boolean => redoStack.value.length > 0

  // Restore the scene the user saved in a previous session. This runs
  // once, when the store is created — i.e. when the application boots.
  // It is a no-op when nothing has been saved yet, and it is placed at
  // the very end of the setup so every function it uses is defined.
  restoreSavedScene()

  return {
    network,
    tickCount,
    fps,
    isRunning,
    tickRate,
    step,
    reset,
    getNetwork,
    addVehicle,
    removeVehicle,
    spawnMany,
    setVehicleSpeed,
    updateVehicleType,
    requestLaneChange,
    addTrafficLight,
    removeTrafficLight,
    notifyChange,
    serialize,
    hydrate,
    loadNetwork,
    switchScene,
    currentSceneKind,
    currentSceneLabel,
    clearStorage,
    frameMsMin,
    frameMsMax,
    frameMsAvg,
    resetFrameStats,
    togglePause,
    setRunning,
    setTickRate,
    cycleTickRate,
    setRapierWorld,
    getRapierWorld,
    setDraggingId,
    getDraggingId,
    moveVehicleTo,
    undo,
    redo,
    canUndo,
    canRedo,
    // signal controller surface
    controllerKind,
    setControllerKind,
    getControllerKind,
    getControllers,
    forceAllRed,
    // the traffic-signal policy surface
    signalPolicy,
    signalPolicyDecision,
    loadSignalPolicy,
    clearSignalPolicy,
    // sensor + exporter surface
    sensorRegistry,
    trajectoryExporter,
    lidarEnabled,
    lidarFrameCount,
    setLidarEnabled,
    toggleLidar,
    // point cloud + camera surface
    lidarCloudsEnabled,
    setLidarCloudsEnabled,
    toggleLidarClouds,
    getLidarPointClouds,
    ensureLidarCloud,
    cameraEnabled,
    cameraFrameCount,
    cameraSensor,
    setCameraEnabled,
    toggleCamera,
    getCameraSensor,
    initCameraSensor,
    // Coordinated UI hooks
    coordinatedOffsets,
    coordinatedOffsetsEnabled,
    setCoordinatedOffset,
    toggleCoordinatedOffsets,
    // RL replay surface
    policy,
    replayTargetId,
    replayActive,
    replayStep,
    replayLastObs,
    replayLastAction,
    loadPolicy,
    setReplayTarget,
    startReplay,
    stopReplay,
    clearPolicy,
    // camera fit
    fitRequestTick,
    requestFit,
    // Inspector surface
    clearVehicleSpeedOverride,
    getVehicleSpeedOverride,
    // persistence
    restoreSavedScene,
  }
})

// Dev-only window.__world introspection for Playwright e2e tests.
// `import.meta.env.DEV` is replaced with `false` in production builds by Vite,
// so this block is tree-shaken out of the production bundle.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as { __world?: ReturnType<typeof useWorldStore> }
  Object.defineProperty(w, '__world', {
    configurable: true,
    enumerable: true,
    get() {
      // The store is created lazily on first access. By the time Playwright
      // runs tests, /scene-editor is mounted and the store is live.
      return useWorldStore()
    },
  })
}

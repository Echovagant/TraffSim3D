import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { FixedStepScheduler } from '@application/services/fixedStepScheduler';
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
  buildElevatedScene,
  buildCorridorScene,
} from '@application/services/defaultScene';
import { tick, type SignalContext } from '@application/services/tick';
import { spawnVehicle, type SpawnOptions, type SpawnResult } from '@application/services/spawnVehicle';
import { findNearestLaneOnNetwork } from '@application/services/laneFrameSync';
import { LightPhase } from '@domain/value-objects/Phase';
import { createSignalController, type SignalController, type ControllerKind } from '@application/services/signalController';
import { requestLaneChange as requestLaneChangeFn } from '@domain/services/laneChange';
import { SensorRegistry, type HostPoseLookup } from '@application/services/sensors';
import {
  LidarSensor,
  LidarPointCloud,
  defaultLidarConfig,
  CameraSensor,
  defaultCameraConfig,
} from '@infrastructure/sensors';
import { TrajectoryExporter } from '@infrastructure/export';
import {
  DEFAULT_CONTROLLER_KIND,
  LIDAR_MOUNT_HEIGHT,
  TRAJECTORY_BUFFER_CAP,
  CAMERA_DEFAULT_WIDTH,
  CAMERA_DEFAULT_HEIGHT,
  CAMERA_DEFAULT_FOV,
} from '@shared/constants/simulation';
import { saveScene, loadScene, clearScene } from '@application/use-cases';
import { showFlashMessage } from '@interfaces/composables/useFlashMessage';
import { RapierWorld, buildRigidBodySpec } from '@infrastructure/physics';
import { serializeNetwork, cloneScene, sceneToNetwork, type SerializedScene } from '@infrastructure/persistence';
import { defaultRLWeights } from '@infrastructure/api';
import type { PolicyWeights } from '@infrastructure/rl/types';
import { computeNetworkBounds } from '@domain/services/networkBounds';

export const TICK_RATE_LADDER = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Plan 035: scene-selector enum. The toolbar dropdown binds to this.
 * Plan 039: added 'elevated' (高架桥 — Y-axis ramps + level tagging).
 * Plan 040: added 'corridor' (多路口走廊 — 2-intersection corridor demo).
 * Plan 054: added 'imported' (any OSM/PBF file loaded via MapImporter —
 *   shown in the toolbar as a read-only label with the source file name
 *   instead of the dropdown, since there's no factory to "switch back to").
 * Adding a new scene = add a factory + an entry here.
 */
export type SceneKind = 'cross' | 't' | 'loop' | 'elevated' | 'corridor' | 'imported';

const buildNetworkByKind = (kind: SceneKind): RoadNetwork => {
  switch (kind) {
    case 'cross':    return buildCrossIntersectionNetwork();
    case 't':        return buildTJunctionNetwork();
    case 'loop':     return buildRectangularLoopNetwork();
    case 'elevated': return buildElevatedScene();
    case 'corridor': return buildCorridorScene();
    case 'imported':
      // Plan 054: switchScene should never be called with 'imported'
      // (the toolbar hides the dropdown for imported scenes). If a
      // caller does (e.g. undo restores an older state), fall back
      // to cross so we always have a valid network.
      return buildCrossIntersectionNetwork();
  }
};

/** Plan 054: human-readable label for built-in scene kinds. Imported
 *  scenes use the source filename (set by loadNetwork) instead. */
const sceneLabelForKind = (kind: SceneKind): string => {
  switch (kind) {
    case 'cross':    return '十字路口';
    case 't':        return 'T 路口';
    case 'loop':     return '矩形环';
    case 'elevated': return '高架桥';
    case 'corridor': return '多路口走廊';
    case 'imported': return '已导入';
  }
};

export const useWorldStore = defineStore('world', () => {
  // Plan 035 fix: `network` is now a `shallowRef`. Earlier we kept it
  // as a plain closure variable mutated in place, but `replaceNetwork`
  // reassigns the variable (`network = next`) — Pinia setup stores do
  // not track plain reassignments, so consumers reading `world.network`
  // (EntityOutline, Inspector) saw the stale initial reference. With
  // shallowRef, Pinia auto-unwraps the ref on the store and re-runs
  // dependents when `.value` changes. shallowRef (not ref) avoids the
  // deep reactivity overhead — the store mutates the network in place
  // per-tick (see tick.ts, addVehicle, etc.) and we don't want every
  // Vehicle.position assignment to trigger a full re-render.
  const network = shallowRef<RoadNetwork>(buildCrossIntersectionNetwork());
  const tickCount = ref(0);
  const fps = ref(0);
  const isRunning = ref(true);

  // Plan 035: which demo scene is currently loaded. Default 'cross'
  // (the original 4-way intersection). Drives the toolbar dropdown
  // and is read by `switchScene()` to know which factory to call.
  const currentSceneKind = ref<SceneKind>('cross');
  // Plan 054: human-readable label for the currently loaded scene.
  // - For built-in scenes: '十字路口' / 'T 路口' / etc. (matches
  //   sceneLabel() in EditorToolbar).
  // - For imported OSM/PBF: the original filename (e.g. 'futian.osm').
  //   Set by loadNetwork() callers that have a source name (the
  //   MapImporterView passes `file.name`). Undo/redo restores the
  //   previous label automatically since the network state lives in
  //   history; for cross-corridor switches the label re-derives from
  //   currentSceneKind.
  const currentSceneLabel = ref<string>('十字路口');

  // Discrete tick rate ladder. +/- keys (and the toolbar buttons) cycle
  // through this list. The ladder lives at module scope so the toolbar
  // and shortcut composable can share the same array.
  const tickRate = ref<number>(1);

  // Plan 053: increments every time the network is replaced (initial
  // load, scene switch, OSM import, undo/redo). Views watch this and
  // call `requestFitToNetwork()` so the camera frames the new scene
  // without the user manually panning. Kept as a separate ref so the
  // fit logic can distinguish "fit because scene changed" from
  // "fit because user pressed the button" — the latter doesn't need
  // to re-debounce.
  const fitRequestTick = ref(0);

  // Plan 049: RL replay surface. `policy` is the loaded SB3 PPO weights
  // (null until loadPolicy() succeeds); `replayTargetId` is the vehicle
  // being driven by the policy; `replayActive` is the toggle so the user
  // can load + dry-run without affecting the sim. `replayStep` counts
  // inference ticks (debug readout for the AI Playground).
  const policy = ref<PolicyWeights | null>(null);
  const replayTargetId = ref<string | null>(null);
  const replayActive = ref(false);
  const replayStep = ref(0);
  const replayLastObs = ref<number[]>([]);
  const replayLastAction = ref<[number, number]>([0, 0]);

  /** Fetch the named checkpoint's weights via the backend and store
   *  them for replay. Returns `{ ok, ... }` so the caller can flash
   *  an error on failure (e.g. 404 / 503 / network). */
  const loadPolicy = async (
    name: string,
  ): Promise<
    | { ok: true; obs_dim: number; action_dim: number }
    | { ok: false; reason: string }
  > => {
    try {
      const w = await defaultRLWeights.getCheckpointWeights(name);
      // Type-narrowing via duck-typing — the backend shape is fixed
      // by `app/apps/rl/weights.py::export_weights`.
      policy.value = w;
      replayStep.value = 0;
      return { ok: true, obs_dim: w.obs_dim, action_dim: w.action_dim };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: msg };
    }
  };

  /** Set which vehicle the loaded policy will drive on the next
   *  `startReplay()`. Does not auto-start replay — explicit user
   *  click required. */
  const setReplayTarget = (vehicleId: string | null): void => {
    replayTargetId.value = vehicleId;
  };

  /** Begin driving `replayTargetId` with the loaded policy. Returns
   *  `{ ok: false, reason }` if policy isn't loaded or no target is
   *  set — caller should surface the reason via a flash message. */
  const startReplay = (): { ok: true } | { ok: false; reason: string } => {
    if (!policy.value) return { ok: false, reason: 'no_policy_loaded' };
    if (!replayTargetId.value) return { ok: false, reason: 'no_target_vehicle' };
    replayActive.value = true;
    replayStep.value = 0;
    return { ok: true };
  };

  /** Stop driving the replay target (falls back to normal Rapier control). */
  const stopReplay = (): void => {
    replayActive.value = false;
  };

  /** Drop the loaded policy + target + state. Called on scene switch
   *  / reset so a stale policy never drives the wrong network. */
  const clearPolicy = (): void => {
    policy.value = null;
    replayActive.value = false;
    replayTargetId.value = null;
    replayStep.value = 0;
    replayLastObs.value = [];
    replayLastAction.value = [0, 0];
  };

  /** Plan 053: bump the fit tick so the editor view asks the camera
   *  to re-frame the current network. Idempotent — repeated calls
   *  just reset the same animation. */
  const requestFit = (): void => {
    fitRequestTick.value += 1;
  };

  // Monotonic simulation time in seconds. Reset to 0 on `reset()`. Used
  // by tick() to stamp `Vehicle.enteredIntersectionAt` so the cross-road
  // right-of-way rule can pick "the car that got there first".
  let simTime = 0;

  // M2-A: optional Rapier physics world. Null before useWorldSimulation
  // has finished its async `init()` (which loads the WASM). When null,
  // tick() falls back to M1's hand-rolled move+s wrap.
  let rapierWorld: RapierWorld | null = null;
  const setRapierWorld = (w: RapierWorld | null): void => {
    rapierWorld = w;
  };
  const getRapierWorld = (): RapierWorld | null => rapierWorld;

  // Editor is currently dragging a vehicle on the 3D canvas. While
  // non-null, tick() skips that vehicle in both the applyControl
  // loop AND the per-frame position re-derivation (otherwise Rapier
  // would overwrite the drag-move on every frame). Lives as a
  // plain `let` (not a ref) — only the renderer's read path and
  // the drag handlers care; no Vue watcher needed.
  let draggingId: string | null = null;
  const setDraggingId = (id: string | null): void => {
    draggingId = id;
  };
  const getDraggingId = (): string | null => draggingId;

  // M2-B: per-light signal controller cache (plan 010). One
  // SignalController instance per traffic light; lazy-created on
  // first encounter. Switching controllerKind clears the cache so
  // the new kind's `decide()` semantics take effect immediately.
  let controllers: Map<string, SignalController> = new Map();
  const controllerKind = ref<ControllerKind>(DEFAULT_CONTROLLER_KIND);
  const setControllerKind = (kind: ControllerKind): void => {
    controllerKind.value = kind;
    // Force rebuild — different kinds have different `decide()` behavior,
    // so retaining stale controllers would silently mix semantics.
    controllers = new Map();
    bumpTick();
  };
  const getControllerKind = (): ControllerKind => controllerKind.value;
  const getControllers = (): Map<string, SignalController> => controllers;
  const signalContext: SignalContext = {
    controllers,
    get controllerKind() { return controllerKind.value; },
    getCoordinatedOffsets: () => coordinatedOffsets.value,
    isCoordinatedEnabled: () => coordinatedOffsetsEnabled.value,
  };

  /**
   * Force every traffic light to AllRed for `durationSeconds`.
   * Preemption path — bypasses the controllers and writes the
   * light state directly. M4 RL agents will get a similar API via
   * `controller.applyAction('force_all_red')`; for M2-B the
   * direct mutation is fine and explicit.
   */
  const forceAllRed = (durationSeconds = 3): void => {
    for (const inter of Object.values(network.value.intersections)) {
      for (const light of inter.trafficLights) {
        light.phase = LightPhase.AllRed;
        light.phaseRemaining = durationSeconds;
      }
    }
    bumpTick();
  };

  // M2-C: per-vehicle sensor + per-tick trajectory export.
  const sensorRegistry = new SensorRegistry();
  const trajectoryExporter = new TrajectoryExporter(TRAJECTORY_BUFFER_CAP);
  const lidarEnabled = ref(false);
  const lidarFrameCount = ref(0);
  const setLidarEnabled = (enabled: boolean): void => {
    lidarEnabled.value = enabled;
    if (!enabled) lidarFrameCount.value = 0;
    bumpTick();
  };
  const toggleLidar = (): void => setLidarEnabled(!lidarEnabled.value);

  // Plan 038: fixed-step scheduler driving the trajectory exporter
  // at 10 Hz. Lives as a plain closure var (not a ref) — the renderer
  // doesn't need to react to it; only tick() reads its state.
  const fixedStepScheduler = new FixedStepScheduler({ fixedStepSec: 0.1 });

  // M2-B Coordinated UI hooks (plan 027). The offsets are consulted by
  // CoordinatedController (plan 028) — until then they are pure UI state
  // that the modal reads / writes without effect on the running sim.
  const coordinatedOffsets = ref<Map<string, number>>(new Map([
    // Key: 'roadA-id|roadB-id' (the pair, smaller first). Value: seconds
    // the B-axis green lags the A-axis green. Default 0 = no offset.
    ['r-ns|r-ew', 0],
  ]));
  const coordinatedOffsetsEnabled = ref(false);

  const setCoordinatedOffset = (pair: string, seconds: number): void => {
    const next = new Map(coordinatedOffsets.value);
    next.set(pair, Math.max(-30, Math.min(30, seconds)));
    coordinatedOffsets.value = next;
  };
  const toggleCoordinatedOffsets = (on: boolean): void => {
    coordinatedOffsetsEnabled.value = on;
  };

  /** Lookup host vehicle's live pose — used by SensorRegistry.scanAll.
   *  Reads from the (mutating) network object; safe because tick() is
   *  the only writer of vehicle position, and the scan runs after
   *  Rapier step + position re-derivation in tick(). */
  const getHostPose: HostPoseLookup = (vehicleId) => {
    const v = network.value.vehicles[vehicleId];
    if (!v) return null;
    return { position: v.position, heading: v.heading };
  };

  // M2-D (plan 025): LiDAR point cloud visualization + camera sensor.
  // The point cloud meshes are added to the scene by the renderer
  // (via addAuxiliary) when lidarCloudsEnabled is true. The cloud
  // map is keyed by vehicleId; meshes are destroyed on removeVehicle.
  let lidarPointClouds: Map<string, LidarPointCloud> = new Map();
  const lidarCloudsEnabled = ref(false);
  const setLidarCloudsEnabled = (enabled: boolean): void => {
    lidarCloudsEnabled.value = enabled;
    // Note: point clouds require LiDAR to be enabled first. We don't
    // auto-enable LiDAR here to avoid confusing users. If LiDAR is not
    // enabled, the point clouds will simply not receive updates.
    bumpTick();
  };
  const toggleLidarClouds = (): void => setLidarCloudsEnabled(!lidarCloudsEnabled.value);
  const getLidarPointClouds = (): Map<string, LidarPointCloud> => lidarPointClouds;

  /** Lazily create a LidarPointCloud for a vehicle. The renderer
   *  (in useWorldSimulation) calls this when lidarCloudsEnabled
   *  flips true to backfill clouds for vehicles that already exist. */
  const ensureLidarCloud = (vehicleId: string): LidarPointCloud => {
    let cloud = lidarPointClouds.get(vehicleId);
    if (!cloud) {
      cloud = new LidarPointCloud(5760);
      lidarPointClouds.set(vehicleId, cloud);
    }
    return cloud;
  };

  /** M2-D: camera sensor. Lazily created on first enable so the
   *  WebGLRenderTarget is only allocated when actually used. */
  const cameraSensor = shallowRef<CameraSensor | null>(null);
  const cameraEnabled = ref(false);
  const cameraFrameCount = ref(0);
  const setCameraEnabled = (enabled: boolean): void => {
    cameraEnabled.value = enabled;
    if (!enabled) {
      if (cameraSensor.value) {
        cameraSensor.value.destroy();
        cameraSensor.value = null;
      }
      cameraFrameCount.value = 0;
      lidarFrameCount.value = 0;
    }
    bumpTick();
  };
  const toggleCamera = (): void => setCameraEnabled(!cameraEnabled.value);
  const getCameraSensor = (): CameraSensor | null => cameraSensor.value;

  const initCameraSensor = (vehicleId: string): CameraSensor => {
    if (cameraSensor.value) return cameraSensor.value;
    cameraSensor.value = new CameraSensor(defaultCameraConfig(vehicleId));
    return cameraSensor.value;
  };

  // History for undo/redo. Each entry is a full SerializedScene JSON
  // string. Bounded to 50 entries to keep memory predictable; oldest
  // entries are dropped on overflow. Cleared on hydrate/reset (loading
  // a new scene is not undoable — it's the user's explicit decision).
  const HISTORY_LIMIT = 50;
  let history: SerializedScene[] = [];
  let redoStack: SerializedScene[] = [];

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
    history.push(cloneScene(serializeNetwork(network.value)));
    if (history.length > HISTORY_LIMIT) {
      history.shift();  // drop oldest
    }
    redoStack = [];
  };

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
    const v = network.value.vehicles[vehicleId];
    if (!v) return { ok: false, reason: 'vehicle not found' };
    pushHistory();
    v.position = { x: position.x, y: position.y, z: position.z };
    if (rapierWorld) {
      rapierWorld.setVehiclePosition(vehicleId, v.position);
    }
    // Re-snap to the nearest lane across the whole network. If the
    // drop point is far from any lane (e.g. mid-intersection with
    // no road near the cursor), keep the entity's existing roadId
    // / laneIndex / s — the next tick will derive a sensible
    // position via findNearestLane anyway.
    const snap = findNearestLaneOnNetwork(network.value, v.position);
    if (snap) {
      v.roadId = snap.roadId;
      v.laneIndex = snap.laneIndex;
      v.s = snap.s;
    }
    bumpTick();
    return { ok: true };
  };

  const togglePause = (): void => {
    isRunning.value = !isRunning.value;
  };
  const setRunning = (running: boolean): void => {
    isRunning.value = running;
  };
  const setTickRate = (rate: number): void => {
    tickRate.value = rate;
  };
  const cycleTickRate = (direction: 1 | -1): void => {
    const ladder = TICK_RATE_LADDER;
    const idx = ladder.findIndex((r) => r === tickRate.value);
    // If the current value isn't in the ladder (shouldn't happen, but be safe),
    // start from 1×. Then move with wrap-around.
    const cur = idx === -1 ? ladder.findIndex((r) => r === 1) : idx;
    const next = (cur + direction + ladder.length) % ladder.length;
    tickRate.value = ladder[next]!;
  };

  // FPS rolling window (500ms)
  let frameCount = 0;
  let fpsAcc = 0;
  let lastFpsUpdateMs = performance.now();

  // Frame-time rolling window (30 frames, ~0.5s at 60fps).
  // `Min` starts at Infinity so the first frame sets it correctly.
  // `Max` starts at -Infinity so the DebugPanel can show "0.0" until a
  // frame arrives (the formatter below guards against the otherwise
  // misleading "0.0 ms max" on first load).
  const frameMsMin = ref(Infinity);
  const frameMsMax = ref(-Infinity);
  const frameMsAvg = ref(0);
  let frameWindowMs = 0;
  let frameWindowCount = 0;

  const step = (dt: number): number => {
    // Clamp dt (I5): 防止卡顿后大跳跃穿模, AND 防止 rAF 边界
    // 偶发的负 dt 进入 frame-time 统计 (会把 min 拉到 -0.x ms,
    // 看起来像 bug). 上下界都 clamp 后 simTime/tick/frame 统计
    // 都用同一个值.
    const clampedDt = Math.max(0, Math.min(dt, 1 / 30));
    simTime += clampedDt;
    tick(network.value, clampedDt, simTime, {
      rapierWorld,
      signal: signalContext,
      trajectoryExporter,
      sensorRegistry,
      lidarEnabled: lidarEnabled.value,
      getHostPose,
      draggingId,
      removeVehicle,  // Plan 034: OOB cleanup entry point
      fixedStepScheduler,  // Plan 038: drives trajectory export at 10 Hz
      // Plan 049: pass policy + replay target to tick. tick() reads
      // `replayTargetId` and computes obs + inference each step. The
      // store keeps the always-current refs so flipping `replayActive`
      // takes effect on the very next tick.
      policy: policy.value,
      replayTargetId: replayActive.value ? replayTargetId.value : null,
    });
    // M2-C: update LiDAR frame counter from sensorRegistry's actual scan count
    // (not per-tick). The registry tracks frames produced (throttled scans only).
    if (lidarEnabled.value) {
      lidarFrameCount.value = sensorRegistry.frameCount;
    }

    // M2-D: refresh LidarPointCloud meshes from the latest frames
    // cached by sensorRegistry.scanAll(). Each cloud is positioned
    // at its host vehicle's current pose (which is post-Rapier-step).
    if (lidarCloudsEnabled.value) {
      for (const [vehicleId, frame] of sensorRegistry.getLatestFrames()) {
        const cloud = lidarPointClouds.get(vehicleId);
        const v = network.value.vehicles[vehicleId];
        if (cloud && v) {
          cloud.updateFromFrame(frame);
          cloud.setPose(v.position, v.heading);
        }
      }
    }

    tickCount.value += 1;

    // Frame-time stats
    const ms = clampedDt * 1000;
    frameMsMin.value = Math.min(frameMsMin.value, ms);
    frameMsMax.value = Math.max(frameMsMax.value, ms);
    frameWindowMs += ms;
    frameWindowCount += 1;
    if (frameWindowCount >= 30) {
      frameMsAvg.value = frameWindowMs / frameWindowCount;
      frameWindowMs = 0;
      frameWindowCount = 0;
    }

    // FPS rolling window
    frameCount += 1;
    fpsAcc += clampedDt;
    const now = performance.now();
    if (now - lastFpsUpdateMs >= 500) {
      fps.value = fpsAcc > 0 ? Math.round(frameCount / fpsAcc) : 0;
      frameCount = 0;
      fpsAcc = 0;
      lastFpsUpdateMs = now;
    }

    // Returned to the renderer so it can drive flashing light phases
    // (FlashingYellow 1Hz / FlashingRed 0.5Hz) without the renderer
    // holding its own clock — there is one sim time in the system.
    return simTime;
  };

  const reset = () => {
    // Reset physics: remove all bodies, rebuild network.
    if (rapierWorld) {
      for (const id of Object.keys(network.value.vehicles)) {
        rapierWorld.removeVehicle(id);
      }
    }
    // Plan 049: clear any loaded RL policy so it can't drive the
    // fresh network's vehicles with stale target ids.
    clearPolicy();
    history = [];
    redoStack = [];
    controllers = new Map();
    sensorRegistry.destroyAll();
    trajectoryExporter.clear();
    // M2-D: tear down point clouds + camera sensor.
    for (const cloud of lidarPointClouds.values()) cloud.destroy();
    lidarPointClouds = new Map();
    if (cameraSensor.value) { cameraSensor.value.destroy(); cameraSensor.value = null; }
    cameraFrameCount.value = 0;
    lidarFrameCount.value = 0;
    network.value = buildCrossIntersectionNetwork();
    simTime = 0;
    fixedStepScheduler.reset();  // Plan 038: zero out the 10 Hz cadence
    // Re-register default vehicles.
    if (rapierWorld) {
      for (const v of Object.values(network.value.vehicles)) {
        rapierWorld.registerVehicle(
          buildRigidBodySpec(v.id, v.type, v.position, v.heading),
        );
        // Re-mount LiDAR for the default vehicles.
        const colliderHandle = rapierWorld.getColliderHandle(v.id);
        const excludes = colliderHandle ? [colliderHandle] : [];
        const sensor = new LidarSensor(defaultLidarConfig(v.id, excludes));
        sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[v.type] });
        sensorRegistry.register(v.id, sensor, `lidar-${v.id}`);
        // M2-D: backfill point clouds.
        if (lidarCloudsEnabled.value) ensureLidarCloud(v.id);
      }
    }
    tickCount.value += 1;
  };

  const getNetwork = (): RoadNetwork => network.value;

  const bumpTick = () => {
    tickCount.value += 1;
  };
  const notifyChange = bumpTick;

  let nextVehicleNum = Object.keys(network.value.vehicles).length + 1;
  let nextLightNum = Object.values(network.value.intersections)
    .reduce((s, i) => s + i.trafficLights.length, 0) + 1;

  const addVehicle = (overrides: Partial<Vehicle> & Partial<SpawnOptions> = {}): SpawnResult => {
    pushHistory();
    const id = overrides.id ?? `v-${nextVehicleNum++}`;
    // `spawnVehicle` handles picking a road/lane/s that's free, picking
    // a type with weighted random, and assigning the correct world
    // position + heading. If every lane is full (M1.5 density check),
    // it returns `{ ok: false, reason }` and we surface a flash
    // message — we never silently place a colliding car.
    const spawnOpts: SpawnOptions = {
      type: overrides.type,
      color: overrides.color,
      speed: overrides.speed,
    };
    const result = spawnVehicle(network.value, id, spawnOpts);
    if (!result.ok) {
      showFlashMessage('交通密度已满 — 现有车道都无法再放车了', 'error');
      return result;
    }
    network.value.vehicles[result.vehicle.id] = result.vehicle;
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
      );
      // M2-C: mount a LiDAR sensor. The collider handle is needed
      // for self-occlusion filtering (017 H4). If Rapier didn't
      // create a collider, the sensor still works (no exclusions).
      const colliderHandle = rapierWorld.getColliderHandle(result.vehicle.id);
      const excludes = colliderHandle ? [colliderHandle] : [];
      const sensor = new LidarSensor(defaultLidarConfig(result.vehicle.id, excludes));
      sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[result.vehicle.type] });
      sensorRegistry.register(result.vehicle.id, sensor, `lidar-${result.vehicle.id}`);
      // M2-D: lazily create a LidarPointCloud if clouds are enabled.
      if (lidarCloudsEnabled.value) {
        ensureLidarCloud(result.vehicle.id);
      }
    }
    bumpTick();
    return result;
  };

  // Plan 031: one-click spawn many vehicles for Rapier collision demo.
  // Returns the number actually added; bails on first full lane so
  // we don't spam the user with "lane full" flashes.
  const spawnMany = (count: number): number => {
    let ok = 0;
    for (let i = 0; i < count; i++) {
      const r = addVehicle();
      if (r.ok) ok += 1;
      else break;
    }
    return ok;
  };

  const removeVehicle = (id: string): void => {
    pushHistory();
    // M2-C: unregister sensors BEFORE removing the Rapier body.
    // The body removal deletes the collider handle that the sensor
    // needs for excludeColliders, so the order is critical.
    sensorRegistry.unregisterAllFor(id);
    // M2-D: tear down the LidarPointCloud mesh.
    const cloud = lidarPointClouds.get(id);
    if (cloud) {
      cloud.destroy();
      lidarPointClouds.delete(id);
    }
    if (rapierWorld) rapierWorld.removeVehicle(id);
    delete network.value.vehicles[id];
    bumpTick();
  };

  /**
   * User-edited a vehicle's speed via the Inspector. Update the
   * Rapier body's linear velocity immediately so the 3D scene
   * reflects the change, then mutate the entity field. The entity's
   * `targetSpeed` is NOT changed — the next tick's applyControl will
   * re-derive linvel from `targetSpeed`, which is the road limit, so
   * the user's edit only persists for one frame. This is a known
   * trade-off; the inspector's purpose is **observe** + **small nudges**,
   * not permanent speed override.
   */
  const setVehicleSpeed = (vehicleId: string, speedKmh: number): void => {
    const v = network.value.vehicles[vehicleId];
    if (!v) return;
    pushHistory();
    v.speed = speedKmh / 3.6;  // km/h → m/s
    if (rapierWorld) {
      rapierWorld.setVehicleSpeed(vehicleId, v.speed, v.heading);
    }
    bumpTick();
  };

  // Plan 029 (M2 lane change): domain decision + state mutation.
  // Returns the same shape as `requestLaneChange` (the domain function)
  // so the caller can flash the reason on rejection.
  const requestLaneChange = (vehicleId: string, direction: 'left' | 'right'): { ok: boolean; reason?: string } => {
    const v = network.value.vehicles[vehicleId];
    if (!v) return { ok: false, reason: 'not-found' };
    const r = requestLaneChangeFn(v, direction, network.value, simTime);
    if (r.ok) {
      v.desiredLaneIndex = v.laneIndex + (direction === 'left' ? 1 : -1);
      v.laneChangeStartedAt = simTime;
      bumpTick();
    }
    return r;
  };

  /**
   * User-edited a vehicle's type via the Inspector. Mutate the
   * entity field, then ask Rapier to re-register the body with the
   * new type's mass + halfExtents.
   */
  const updateVehicleType = (vehicleId: string, newType: Vehicle['type']): void => {
    const v = network.value.vehicles[vehicleId];
    if (!v) return;
    pushHistory();
    v.type = newType;
    if (rapierWorld) {
      rapierWorld.updateVehicleType(vehicleId, newType);
    }
    bumpTick();
  };

  const addTrafficLight = (overrides: Partial<TrafficLight> = {}): TrafficLight | null => {
    pushHistory();
    const inter = Object.values(network.value.intersections)[0];
    if (!inter) return null;
    const id = overrides.id ?? `tl-${nextLightNum++}`;
    const angle = (inter.trafficLights.length * Math.PI) / 2;  // N, E, S, W
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
    };
    inter.trafficLights.push(light);
    bumpTick();
    return light;
  };

  const removeTrafficLight = (id: string): void => {
    pushHistory();
    for (const inter of Object.values(network.value.intersections)) {
      inter.trafficLights = inter.trafficLights.filter((l) => l.id !== id);
    }
    bumpTick();
  };

  // ----- persistence (added by Plan 005) -----

  const serialize = (): { ok: true } | { ok: false; reason: string } => {
    try {
      saveScene(network.value);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: msg };
    }
  };

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
        rapierWorld.removeVehicle(id);
      }
    }
    // Plan 049: same as reset() — never let a stale policy drive the
    // new network's vehicles. The user's selected replay target id may
    // not even exist in the loaded scene.
    clearPolicy();
    // Plan 035: assign via .value so Pinia's auto-unwrap on the store
    // surfaces the new network to EntityOutline, InspectorPanel, etc.
    network.value = next;
    // Clear controller cache + sensors + exporter — new scene has
    // different light IDs and vehicle IDs.
    controllers = new Map();
    sensorRegistry.destroyAll();
    trajectoryExporter.clear();
    // M2-D: tear down point clouds + camera sensor.
    for (const cloud of lidarPointClouds.values()) cloud.destroy();
    lidarPointClouds = new Map();
    if (cameraSensor.value) { cameraSensor.value.destroy(); cameraSensor.value = null; }
    cameraFrameCount.value = 0;
    lidarFrameCount.value = 0;
    // Re-register new vehicles
    if (rapierWorld) {
      for (const v of Object.values(network.value.vehicles)) {
        rapierWorld.registerVehicle(
          buildRigidBodySpec(v.id, v.type, v.position, v.heading),
        );
        // Re-mount LiDAR.
        const colliderHandle = rapierWorld.getColliderHandle(v.id);
        const excludes = colliderHandle ? [colliderHandle] : [];
        const sensor = new LidarSensor(defaultLidarConfig(v.id, excludes));
        sensor.configure({ mountHeight: LIDAR_MOUNT_HEIGHT[v.type] });
        sensorRegistry.register(v.id, sensor, `lidar-${v.id}`);
        // M2-D: backfill point clouds.
        if (lidarCloudsEnabled.value) ensureLidarCloud(v.id);
      }
    }
    bumpTick();  // signal Vue watchers; the renderer will rebuild via identity change
    // Plan 053: bump fit request so the editor view re-frames the camera.
    fitRequestTick.value += 1;
    return { ok: true };
  };

  const hydrate = (): { ok: true } | { ok: false; reason: string } => {
    const result = loadScene();
    if (!result.ok) return result;
    // Loading a new scene is the user's explicit decision — not undoable.
    history = [];
    redoStack = [];
    return replaceNetwork(result.network);
  };

  /**
   * Replace the current network with an already-validated `RoadNetwork`
   * (e.g. one produced by `importSceneFile`). Bypasses the LocalStorage
   * round-trip — the caller has already done the validation that
   * `hydrate()` would do via `loadScene()`.
   *
   * Plan 054: `sourceLabel` is the human-readable name shown in the
   * toolbar's scene indicator (e.g. the imported file name). When
   * omitted, the existing label is kept. Any call with a non-empty
   * `sourceLabel` flips `currentSceneKind` to `'imported'` so the
   * toolbar hides the scene-kind dropdown and shows the file name
   * instead.
   */
  const loadNetwork = (next: RoadNetwork, sourceLabel?: string): { ok: true } => {
    if (sourceLabel) {
      currentSceneKind.value = 'imported';
      currentSceneLabel.value = sourceLabel;
    }
    return replaceNetwork(next);
  };

  const clearStorage = (): { ok: true } => {
    clearScene();
    return { ok: true };
  };

  /**
   * Plan 035: switch the loaded scene to one of the three demo
   * factories. Clears the Rapier body / sensor / controller caches
   * via the existing `loadNetwork` path (which removes old bodies
   * and re-registers the new vehicles' bodies). Also clears undo
   * history — switching scenes is not a small enough mutation that
   * undo across the boundary would be meaningful.
   */
  const switchScene = (kind: SceneKind): { ok: true } => {
    const next = buildNetworkByKind(kind);
    history = [];
    redoStack = [];
    currentSceneKind.value = kind;
    if (kind === 'imported') {
      // Plan 054: callers must pass a label via loadNetwork() before
      // calling switchScene('imported') (or just call loadNetwork
      // directly). For safety, fall back to the current label.
    } else {
      currentSceneLabel.value = sceneLabelForKind(kind);
    }
    return loadNetwork(next);
  };

  /**
   * Undo the last user-initiated mutation. Pops the current state to
   * the redo stack, then restores the network from the popped history
   * entry. If history is empty, no-op (returns false).
   *
   * After restore: re-registers Rapier bodies via the existing
   * loadNetwork path (which removes old bodies + registers new).
   */
  const undo = (): boolean => {
    if (history.length === 0) return false;
    const previous = history.pop()!;
    redoStack.push(cloneScene(serializeNetwork(network.value)));
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
    const restored = sceneToNetwork(previous);
    // Use loadNetwork to re-register Rapier bodies
    loadNetwork(restored);
    return true;
  };

  /**
   * Redo the last undone mutation. Mirror of undo().
   */
  const redo = (): boolean => {
    if (redoStack.length === 0) return false;
    const next = redoStack.pop()!;
    history.push(cloneScene(serializeNetwork(network.value)));
    if (history.length > HISTORY_LIMIT) history.shift();
    const restored = sceneToNetwork(next);
    loadNetwork(restored);
    return true;
  };

  const canUndo = (): boolean => history.length > 0;
  const canRedo = (): boolean => redoStack.length > 0;

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
    // M2-B signal controller surface
    controllerKind,
    setControllerKind,
    getControllerKind,
    getControllers,
    forceAllRed,
    // M2-C sensor + exporter surface
    sensorRegistry,
    trajectoryExporter,
    lidarEnabled,
    lidarFrameCount,
    setLidarEnabled,
    toggleLidar,
    // M2-D point cloud + camera surface
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
    // M2-B Coordinated UI hooks (plan 027)
    coordinatedOffsets,
    coordinatedOffsetsEnabled,
    setCoordinatedOffset,
    toggleCoordinatedOffsets,
    // Plan 049: RL replay surface
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
    // Plan 053: camera fit
    fitRequestTick,
    requestFit,
  };
});

// Plan 042: dev-only window.__world introspection for Playwright e2e tests.
// `import.meta.env.DEV` is replaced with `false` in production builds by Vite,
// so this block is tree-shaken out of the production bundle.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as { __world?: ReturnType<typeof useWorldStore> };
  Object.defineProperty(w, '__world', {
    configurable: true,
    enumerable: true,
    get() {
      // The store is created lazily on first access. By the time Playwright
      // runs tests, /scene-editor is mounted and the store is live.
      return useWorldStore();
    },
  });
}

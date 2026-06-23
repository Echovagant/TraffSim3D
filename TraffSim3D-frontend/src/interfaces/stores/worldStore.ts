import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { buildDefaultNetwork } from '@application/services/defaultScene';
import { tick } from '@application/services/tick';
import { spawnVehicle, type SpawnOptions, type SpawnResult } from '@application/services/spawnVehicle';
import { findNearestLaneOnNetwork } from '@application/services/laneFrameSync';
import { LightPhase } from '@domain/value-objects/Phase';
import { saveScene, loadScene, clearScene } from '@application/use-cases';
import { showFlashMessage } from '@interfaces/composables/useFlashMessage';
import { RapierWorld, buildRigidBodySpec } from '@infrastructure/physics';
import { serializeNetwork, cloneScene, sceneToNetwork, type SerializedScene } from '@infrastructure/persistence';

export const TICK_RATE_LADDER = [0.25, 0.5, 1, 2, 4] as const;

export const useWorldStore = defineStore('world', () => {
  // Plain object — see Plan 003 for why this is NOT a ref/shallowRef.
  let network: RoadNetwork = buildDefaultNetwork();
  const tickCount = ref(0);
  const fps = ref(0);
  const isRunning = ref(true);

  // Discrete tick rate ladder. +/- keys (and the toolbar buttons) cycle
  // through this list. The ladder lives at module scope so the toolbar
  // and shortcut composable can share the same array.
  const tickRate = ref<number>(1);

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
    history.push(cloneScene(serializeNetwork(network)));
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
    const v = network.vehicles[vehicleId];
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
    const snap = findNearestLaneOnNetwork(network, v.position);
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

  const step = (dt: number) => {
    // Clamp dt (I5): 防止卡顿后大跳跃穿模, AND 防止 rAF 边界
    // 偶发的负 dt 进入 frame-time 统计 (会把 min 拉到 -0.x ms,
    // 看起来像 bug). 上下界都 clamp 后 simTime/tick/frame 统计
    // 都用同一个值.
    const clampedDt = Math.max(0, Math.min(dt, 1 / 30));
    simTime += clampedDt;
    tick(network, clampedDt, simTime, rapierWorld, draggingId);
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
      fps.value = Math.round(frameCount / fpsAcc);
      frameCount = 0;
      fpsAcc = 0;
      lastFpsUpdateMs = now;
    }
  };

  const reset = () => {
    // Reset physics: remove all bodies, rebuild network.
    if (rapierWorld) {
      for (const id of Object.keys(network.vehicles)) {
        rapierWorld.removeVehicle(id);
      }
    }
    history = [];
    redoStack = [];
    network = buildDefaultNetwork();
    simTime = 0;
    // Re-register default vehicles.
    if (rapierWorld) {
      for (const v of Object.values(network.vehicles)) {
        rapierWorld.registerVehicle(
          buildRigidBodySpec(v.id, v.type, v.position, v.heading),
        );
      }
    }
    tickCount.value += 1;
  };

  const getNetwork = (): RoadNetwork => network;

  const bumpTick = () => {
    tickCount.value += 1;
  };
  const notifyChange = bumpTick;

  let nextVehicleNum = Object.keys(network.vehicles).length + 1;
  let nextLightNum = Object.values(network.intersections)
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
    const result = spawnVehicle(network, id, spawnOpts);
    if (!result.ok) {
      showFlashMessage('交通密度已满 — 现有车道都无法再放车了', 'error');
      return result;
    }
    network.vehicles[result.vehicle.id] = result.vehicle;
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
    }
    bumpTick();
    return result;
  };

  const removeVehicle = (id: string): void => {
    pushHistory();
    if (rapierWorld) rapierWorld.removeVehicle(id);
    delete network.vehicles[id];
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
    const v = network.vehicles[vehicleId];
    if (!v) return;
    pushHistory();
    v.speed = speedKmh / 3.6;  // km/h → m/s
    if (rapierWorld) {
      rapierWorld.setVehicleSpeed(vehicleId, v.speed, v.heading);
    }
    bumpTick();
  };

  /**
   * User-edited a vehicle's type via the Inspector. Mutate the
   * entity field, then ask Rapier to re-register the body with the
   * new type's mass + halfExtents.
   */
  const updateVehicleType = (vehicleId: string, newType: Vehicle['type']): void => {
    const v = network.vehicles[vehicleId];
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
    const inter = Object.values(network.intersections)[0];
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
    for (const inter of Object.values(network.intersections)) {
      inter.trafficLights = inter.trafficLights.filter((l) => l.id !== id);
    }
    bumpTick();
  };

  // ----- persistence (added by Plan 005) -----

  const serialize = (): { ok: true } | { ok: false; reason: string } => {
    try {
      saveScene(network);
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
      for (const id of Object.keys(network.vehicles)) {
        rapierWorld.removeVehicle(id);
      }
    }
    network = next;
    // Re-register new vehicles
    if (rapierWorld) {
      for (const v of Object.values(network.vehicles)) {
        rapierWorld.registerVehicle(
          buildRigidBodySpec(v.id, v.type, v.position, v.heading),
        );
      }
    }
    bumpTick();  // signal Vue watchers; the renderer will rebuild via identity change
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
   */
  const loadNetwork = (next: RoadNetwork): { ok: true } => {
    return replaceNetwork(next);
  };

  const clearStorage = (): { ok: true } => {
    clearScene();
    return { ok: true };
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
    redoStack.push(cloneScene(serializeNetwork(network)));
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
    history.push(cloneScene(serializeNetwork(network)));
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
    setVehicleSpeed,
    updateVehicleType,
    addTrafficLight,
    removeTrafficLight,
    notifyChange,
    serialize,
    hydrate,
    loadNetwork,
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
  };
});

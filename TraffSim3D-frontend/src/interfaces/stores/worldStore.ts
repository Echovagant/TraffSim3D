import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { buildDefaultNetwork } from '@application/services/defaultScene';
import { tick } from '@application/services/tick';
import { Speed } from '@domain/value-objects/Speed';
import { LightPhase } from '@domain/value-objects/Phase';
import { saveScene, loadScene, clearScene } from '@application/use-cases';

export const useWorldStore = defineStore('world', () => {
  // Plain object — see Plan 003 for why this is NOT a ref/shallowRef.
  let network: RoadNetwork = buildDefaultNetwork();
  const tickCount = ref(0);
  const fps = ref(0);
  const isRunning = ref(false);

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
    tick(network, dt);
    tickCount.value += 1;

    // Frame-time stats
    const ms = dt * 1000;
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
    fpsAcc += dt;
    const now = performance.now();
    if (now - lastFpsUpdateMs >= 500) {
      fps.value = Math.round(frameCount / fpsAcc);
      frameCount = 0;
      fpsAcc = 0;
      lastFpsUpdateMs = now;
    }
  };

  const reset = () => {
    network = buildDefaultNetwork();
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

  const addVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => {
    const id = overrides.id ?? `v-${nextVehicleNum++}`;
    const centerInter = Object.values(network.intersections)[0];
    if (!centerInter) {
      throw new Error('addVehicle: network has no intersections to anchor on');
    }
    const offsetX = (Math.random() - 0.5) * 10;
    const offsetZ = (Math.random() - 0.5) * 10;
    const v: Vehicle = {
      id,
      type: overrides.type ?? 'car',
      position: overrides.position ?? {
        x: centerInter.position.x + offsetX,
        y: 0,
        z: centerInter.position.z + offsetZ,
      },
      speed: overrides.speed ?? Speed.fromKmh(40),
      heading: overrides.heading ?? 0,
      lane: overrides.lane ?? 'r-ns#1',
      color: overrides.color ?? '#3a86ff',
      status: overrides.status ?? 'driving',
    };
    network.vehicles[id] = v;
    bumpTick();
    return v;
  };

  const removeVehicle = (id: string): void => {
    delete network.vehicles[id];
    bumpTick();
  };

  const addTrafficLight = (overrides: Partial<TrafficLight> = {}): TrafficLight | null => {
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

  const hydrate = (): { ok: true } | { ok: false; reason: string } => {
    const result = loadScene();
    if (!result.ok) return result;
    network = result.network;
    bumpTick();  // signal Vue watchers; the renderer will rebuild via identity change
    return { ok: true };
  };

  const clearStorage = (): { ok: true } => {
    clearScene();
    return { ok: true };
  };

  return {
    network,
    tickCount,
    fps,
    isRunning,
    step,
    reset,
    getNetwork,
    addVehicle,
    removeVehicle,
    addTrafficLight,
    removeTrafficLight,
    notifyChange,
    serialize,
    hydrate,
    clearStorage,
    frameMsMin,
    frameMsMax,
    frameMsAvg,
  };
});

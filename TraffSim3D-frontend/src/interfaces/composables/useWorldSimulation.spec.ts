// Unit tests for src/interfaces/composables/useWorldSimulation.ts
//
// This composable is the wiring seam between the Pinia world store and
// the rendering/physics stack. A real ThreeJSRenderer needs a WebGL
// context and a real RapierWorld needs WASM, neither of which happy-dom
// provides — so ONLY those two constructors plus LidarSensor are
// replaced. Everything the composable itself owns runs for real:
// renderer construction + its four callbacks, the ResizeObserver
// wiring, the Rapier registration loop, the LiDAR point-cloud watchers,
// the camera-sensor watcher and the unmount teardown.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, h, ref, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { getMainRenderer } from './rendererRegistry';
import { getOrCreateRapierWorld, destroySharedRapierWorld, useWorldSimulation } from './useWorldSimulation';
import { LIDAR_MOUNT_HEIGHT } from '@shared/constants/simulation';

type Store = ReturnType<typeof useWorldStore>;

// ---- mocks -----------------------------------------------------------------

const SCENE = { name: 'scene' } as unknown as Record<string, unknown>;

const rendererInstances = vi.hoisted(() => [] as Array<Record<string, ReturnType<typeof vi.fn>>>);
const rapierInitFails = vi.hoisted(() => ({ value: false }));
const registerVehicle = vi.hoisted(() => vi.fn());
const rapierDestroy = vi.hoisted(() => vi.fn());
const colliderHandles = vi.hoisted(() => new Map<string, string>());
const lidarConfigure = vi.hoisted(() => vi.fn());
const buildRigidBodySpec = vi.hoisted(() =>
  vi.fn((id: string, type: string, position: unknown, heading: number) => ({ id, type, position, heading })),
);
const defaultLidarConfig = vi.hoisted(() =>
  vi.fn((vehicleId: string, excludes: string[]) => ({ vehicleId, excludes })),
);

// The fake scene graph really parents/unparents, so the composable's
// `if (!cloud.mesh.parent)` guard is genuinely exercised rather than
// always-true.
vi.mock('@infrastructure/rendering', () => ({
  ThreeJSRenderer: class {
    onTick: unknown;
    resize = vi.fn();
    start = vi.fn();
    dispose = vi.fn();
    setNetworkGetter = vi.fn();
    setSelectionGetter = vi.fn();
    setTickPolicyGetter = vi.fn();
    addAuxiliary = vi.fn((mesh: { parent: unknown }) => {
      mesh.parent = SCENE;
    });
    removeAuxiliary = vi.fn((mesh: { parent: unknown }) => {
      mesh.parent = null;
    });
    constructor(canvas: HTMLCanvasElement, callbacks: { onTick: unknown }) {
      this.onTick = callbacks.onTick;
      rendererInstances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
      void canvas;
    }
  },
}));

vi.mock('@infrastructure/physics', () => ({
  RapierWorld: class {
    async init(): Promise<void> {
      if (rapierInitFails.value) throw new Error('WASM unavailable');
    }
    registerVehicle = registerVehicle;
    removeVehicle = vi.fn();
    setVehiclePosition = vi.fn();
    step = vi.fn();
    getColliderHandle = (id: string) => colliderHandles.get(id) ?? null;
    destroy = rapierDestroy;
  },
  buildRigidBodySpec,
}));

// LidarPointCloud / CameraSensor are constructed by the worldStore, not
// by the composable under test — minimal stand-ins with the same
// surface the store touches (a `mesh` object with a parentable
// `parent`, plus destroy()).
vi.mock('@infrastructure/sensors', () => ({
  LidarSensor: class {
    configure = lidarConfigure;
    destroy = vi.fn();
  },
  defaultLidarConfig,
  LidarPointCloud: class {
    mesh = { parent: null as unknown };
    destroy = vi.fn();
  },
  CameraSensor: class {
    destroy = vi.fn();
  },
  defaultCameraConfig: (vehicleId: string) => ({ vehicleId }),
}));

interface FakeResizeObserverInstance {
  observed: Element[];
  disconnected: boolean;
  trigger(width: number, height: number): void;
}

class FakeResizeObserver {
  static instances: FakeResizeObserverInstance[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this as unknown as FakeResizeObserverInstance);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(width: number, height: number): void {
    this.cb(
      [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

// ---- harness ---------------------------------------------------------------

type Sim = ReturnType<typeof useWorldSimulation>;

interface Harness {
  sim: Sim;
  wrapper: VueWrapper;
  flush: () => Promise<void>;
}

const mountSim = async (opts: { withParent?: boolean; expectRapier?: boolean } = {}): Promise<Harness> => {
  const withParent = opts.withParent ?? true;
  const expectRapier = opts.expectRapier ?? true;

  const canvas = document.createElement('canvas');
  if (withParent) {
    const container = document.createElement('div');
    // happy-dom reports 0x0 for a plain detached div; pin a size so
    // the initial resize() call is observable.
    Object.defineProperty(container, 'clientWidth', { value: 1280, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 720, configurable: true });
    container.appendChild(canvas);
    document.body.appendChild(container);
  }
  // NOTE: when `withParent` is false the canvas stays fully detached —
  // appending it anywhere (even <body>) would give it a parentElement
  // and defeat the branch under test.

  const canvasRef = ref<HTMLCanvasElement | null>(null);
  let sim!: Sim;
  const Host = defineComponent({
    setup() {
      sim = useWorldSimulation(canvasRef);
      return () => h('div');
    },
  });
  const wrapper = mount(Host);

  // The canvas watcher is not immediate — it fires on assignment.
  canvasRef.value = canvas;
  await nextTick();
  // setupRenderer is async (it awaits Rapier init).
  await vi.waitFor(() => {
    expect(sim.isReady.value).toBe(true);
  });
  if (expectRapier) {
    await vi.waitFor(() => {
      expect(sim.rapierReady.value).toBe(true);
    });
  }
  await nextTick();

  const flush = async () => {
    await nextTick();
    await Promise.resolve();
  };

  return { sim, wrapper, flush };
};

const lastRenderer = () => rendererInstances[rendererInstances.length - 1]!;
const firstArg = (fn: ReturnType<typeof vi.fn>, index = 0): unknown =>
  fn.mock.calls[index]![0];
const callbackOf = (name: 'setNetworkGetter' | 'setSelectionGetter' | 'setTickPolicyGetter') =>
  lastRenderer()[name]!.mock.calls[0]![0] as () => unknown;

// ---- tests -----------------------------------------------------------------

describe('useWorldSimulation', () => {
  let store: Store;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useWorldStore();
    rendererInstances.length = 0;
    FakeResizeObserver.instances.length = 0;
    colliderHandles.clear();
    rapierInitFails.value = false;
    registerVehicle.mockClear();
    rapierDestroy.mockClear();
    lidarConfigure.mockClear();
    buildRigidBodySpec.mockClear();
    defaultLidarConfig.mockClear();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    destroySharedRapierWorld();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('renderer setup', () => {
    it('constructs the renderer with the store step callback once the canvas arrives', async () => {
      const { wrapper } = await mountSim();

      expect(rendererInstances).toHaveLength(1);
      expect(lastRenderer().onTick).toBe(store.step);
      wrapper.unmount();
    });

    it('creates nothing while the canvas is still null', () => {
      let sim!: Sim;
      const canvasRef = ref<HTMLCanvasElement | null>(null);
      const Host = defineComponent({
        setup() {
          sim = useWorldSimulation(canvasRef);
          return () => h('div');
        },
      });
      const wrapper = mount(Host);

      expect(rendererInstances).toHaveLength(0);
      expect(sim.isReady.value).toBe(false);
      expect(sim.getRenderer()).toBeNull();
      wrapper.unmount();
    });

    it('marks itself ready, publishes the renderer and starts the loop', async () => {
      const { sim, wrapper } = await mountSim();

      expect(sim.isReady.value).toBe(true);
      expect(sim.getRenderer()).toBe(rendererInstances[0]);
      expect(lastRenderer().start).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('registers itself in the module-level renderer registry', async () => {
      const { wrapper } = await mountSim();

      expect(getMainRenderer()).toBe(rendererInstances[0]);
      wrapper.unmount();
    });

    it('wires the network getter to the live store network', async () => {
      const { wrapper } = await mountSim();

      expect(callbackOf('setNetworkGetter')()).toBe(store.getNetwork());
      wrapper.unmount();
    });

    it('the selection getter reports null when nothing is selected', async () => {
      const { wrapper } = await mountSim();

      expect(callbackOf('setSelectionGetter')()).toBeNull();
      wrapper.unmount();
    });

    it('the selection getter reports the current selection', async () => {
      const { wrapper } = await mountSim();
      const id = Object.keys(store.getNetwork().vehicles)[0]!;

      useSelectionStore().select('vehicle', id);

      expect(callbackOf('setSelectionGetter')()).toEqual({ kind: 'vehicle', id });
      wrapper.unmount();
    });

    it('the tick policy getter mirrors isRunning and tickRate', async () => {
      const { wrapper } = await mountSim();

      expect(callbackOf('setTickPolicyGetter')()).toEqual({ paused: false, rate: 1 });

      store.togglePause();
      store.setTickRate(4);

      expect(callbackOf('setTickPolicyGetter')()).toEqual({ paused: true, rate: 4 });
      wrapper.unmount();
    });
  });

  describe('resize', () => {
    it('sizes the renderer from the container box', async () => {
      const { wrapper } = await mountSim();

      expect(lastRenderer().resize).toHaveBeenCalledWith(1280, 720);
      wrapper.unmount();
    });

    it('observes the container and follows later resizes', async () => {
      const { wrapper } = await mountSim();
      const observer = FakeResizeObserver.instances[0]!;
      expect(observer.observed).toHaveLength(1);

      observer.trigger(800, 600);

      expect(lastRenderer().resize).toHaveBeenCalledWith(800, 600);
      wrapper.unmount();
    });

    it('skips the ResizeObserver entirely when the canvas has no parent', async () => {
      const { wrapper } = await mountSim({ withParent: false });

      expect(FakeResizeObserver.instances).toHaveLength(0);
      expect(lastRenderer().resize).not.toHaveBeenCalled();
      // Still otherwise fully functional.
      expect(rendererInstances).toHaveLength(1);
      wrapper.unmount();
    });
  });

  describe('rapier physics', () => {
    it('registers one rigid body per vehicle, built from its live pose', async () => {
      const { wrapper } = await mountSim();
      const vehicles = Object.values(store.getNetwork().vehicles);

      expect(registerVehicle).toHaveBeenCalledTimes(vehicles.length);
      for (const v of vehicles) {
        expect(buildRigidBodySpec).toHaveBeenCalledWith(v.id, v.type, v.position, v.heading);
      }
      wrapper.unmount();
    });

    it('flips rapierReady once the shared world is up', async () => {
      const { sim, wrapper } = await mountSim();

      expect(sim.rapierReady.value).toBe(true);
      wrapper.unmount();
    });

    it('hands the very same shared world to the store', async () => {
      const setRapierWorld = vi.spyOn(store, 'setRapierWorld');

      const { wrapper } = await mountSim();
      const shared = await getOrCreateRapierWorld();

      expect(setRapierWorld).toHaveBeenCalledWith(shared);
      wrapper.unmount();
    });

    it('mounts exactly one LiDAR sensor per vehicle', async () => {
      const { sim, wrapper } = await mountSim();
      const vehicleIds = Object.keys(store.getNetwork().vehicles);

      for (const id of vehicleIds) {
        expect(sim.store.sensorRegistry.getSensorsFor(id)).toHaveLength(1);
      }
      expect(defaultLidarConfig).toHaveBeenCalledTimes(vehicleIds.length);
      wrapper.unmount();
    });

    it('configures each LiDAR at its vehicle type mount height', async () => {
      const { wrapper } = await mountSim();
      const vehicleIds = Object.keys(store.getNetwork().vehicles);

      for (const id of vehicleIds) {
        const type = store.getNetwork().vehicles[id]!.type;
        expect(lidarConfigure).toHaveBeenCalledWith({ mountHeight: LIDAR_MOUNT_HEIGHT[type] });
      }
      wrapper.unmount();
    });

    it("excludes the vehicle's own collider handle from its LiDAR", async () => {
      const firstId = Object.keys(store.getNetwork().vehicles)[0]!;
      colliderHandles.set(firstId, `handle-${firstId}`);

      const { wrapper } = await mountSim();

      expect(defaultLidarConfig).toHaveBeenCalledWith(firstId, [`handle-${firstId}`]);
      wrapper.unmount();
    });

    it('falls back to an empty exclude list when no collider handle exists', async () => {
      const { wrapper } = await mountSim();
      const firstId = Object.keys(store.getNetwork().vehicles)[0]!;

      expect(defaultLidarConfig).toHaveBeenCalledWith(firstId, []);
      wrapper.unmount();
    });

    it('a failed WASM load degrades gracefully — the scene still renders', async () => {
      rapierInitFails.value = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { sim, wrapper } = await mountSim({ expectRapier: false });

      expect(sim.rapierReady.value).toBe(false);
      expect(sim.isReady.value).toBe(true);
      expect(registerVehicle).not.toHaveBeenCalled();
      expect(defaultLidarConfig).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '[useWorldSimulation] Rapier init failed — physics disabled',
      );
      wrapper.unmount();
    });

    it('shares one rapier world across mounts (1 per page lifetime)', async () => {
      const a = await mountSim();
      const aWorld = await getOrCreateRapierWorld();
      a.wrapper.unmount();

      const b = await mountSim();
      const bWorld = await getOrCreateRapierWorld();

      expect(bWorld).toBe(aWorld);
      b.wrapper.unmount();
    });
  });

  describe('lidar point clouds', () => {
    it('adds one cloud mesh per vehicle when the toggle flips on', async () => {
      const { flush, wrapper } = await mountSim();
      const vehicleCount = Object.keys(store.getNetwork().vehicles).length;

      store.setLidarCloudsEnabled(true);
      await flush();

      expect(lastRenderer().addAuxiliary).toHaveBeenCalledTimes(vehicleCount);
      wrapper.unmount();
    });

    it('removes every cloud mesh when the toggle flips back off', async () => {
      const { flush, wrapper } = await mountSim();
      const vehicleCount = Object.keys(store.getNetwork().vehicles).length;

      store.setLidarCloudsEnabled(true);
      await flush();
      store.setLidarCloudsEnabled(false);
      await flush();

      expect(lastRenderer().removeAuxiliary).toHaveBeenCalledTimes(vehicleCount);
      wrapper.unmount();
    });

    it('leaves the scene untouched while the toggle stays off', async () => {
      const { flush, wrapper } = await mountSim();

      // Switching scenes must not attach clouds while disabled.
      store.switchScene('loop');
      await flush();

      expect(lastRenderer().addAuxiliary).not.toHaveBeenCalled();
      expect(lastRenderer().removeAuxiliary).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it('re-attaches clouds after an off/on cycle', async () => {
      const { flush, wrapper } = await mountSim();
      const vehicleCount = Object.keys(store.getNetwork().vehicles).length;

      store.setLidarCloudsEnabled(true);
      await flush();
      store.setLidarCloudsEnabled(false);
      await flush();
      store.setLidarCloudsEnabled(true);
      await flush();

      expect(lastRenderer().addAuxiliary).toHaveBeenCalledTimes(vehicleCount * 2);
      wrapper.unmount();
    });

    it('adds only the new clouds when the vehicle count changes', async () => {
      const { flush, wrapper } = await mountSim();
      const before = Object.keys(store.getNetwork().vehicles).length;

      store.setLidarCloudsEnabled(true);
      await flush();
      expect(lastRenderer().addAuxiliary).toHaveBeenCalledTimes(before);

      // The loop scene swaps 6 vehicles for 8, which trips the
      // vehicle-count watcher; already-parented clouds must be skipped.
      store.switchScene('loop');
      await flush();

      const added = lastRenderer().addAuxiliary.mock.calls.length - before;
      expect(added).toBe(Object.keys(store.getNetwork().vehicles).length);
      expect(added).toBeGreaterThan(0);
      wrapper.unmount();
    });
  });

  describe('camera sensor', () => {
    it('is not created while the toggle is off', async () => {
      const { wrapper } = await mountSim();

      expect(store.getCameraSensor()).toBeNull();
      wrapper.unmount();
    });

    it('mounts the camera sensor on the selected vehicle', async () => {
      const { flush, wrapper } = await mountSim();
      const id = Object.keys(store.getNetwork().vehicles)[1]!;
      useSelectionStore().select('vehicle', id);

      store.setCameraEnabled(true);
      await flush();

      expect(store.getCameraSensor()).not.toBeNull();
      wrapper.unmount();
    });

    it('falls back to the first vehicle when nothing is selected', async () => {
      const { flush, wrapper } = await mountSim();

      store.setCameraEnabled(true);
      await flush();

      expect(store.getCameraSensor()).not.toBeNull();
      wrapper.unmount();
    });

    it('re-enabling after a disable yields a fresh sensor', async () => {
      const { flush, wrapper } = await mountSim();

      store.setCameraEnabled(true);
      await flush();
      const first = store.getCameraSensor();
      expect(first).not.toBeNull();

      store.setCameraEnabled(false);
      await flush();
      expect(store.getCameraSensor()).toBeNull();

      store.setCameraEnabled(true);
      await flush();

      expect(store.getCameraSensor()).not.toBeNull();
      wrapper.unmount();
    });
  });

  describe('teardown', () => {
    it('disposes the renderer and clears the registry slot', async () => {
      const { sim, wrapper } = await mountSim();
      const renderer = lastRenderer();

      wrapper.unmount();

      expect(renderer.dispose).toHaveBeenCalledTimes(1);
      expect(sim.getRenderer()).toBeNull();
      expect(getMainRenderer()).toBeNull();
    });

    it('disconnects the ResizeObserver', async () => {
      const { wrapper } = await mountSim();
      const observer = FakeResizeObserver.instances[0]!;

      wrapper.unmount();

      expect(observer.disconnected).toBe(true);
    });

    it('does NOT destroy the shared rapier world on unmount (HMR safety)', async () => {
      const { wrapper } = await mountSim();

      wrapper.unmount();

      expect(rapierDestroy).not.toHaveBeenCalled();
    });
  });

  describe('destroySharedRapierWorld', () => {
    it('is safe to call when nothing was ever created', () => {
      expect(() => destroySharedRapierWorld()).not.toThrow();
      expect(rapierDestroy).not.toHaveBeenCalled();
    });

    it('destroys and clears the singleton so the next mount rebuilds it', async () => {
      const { wrapper } = await mountSim();
      const before = await getOrCreateRapierWorld();
      expect(before).not.toBeNull();
      wrapper.unmount();

      destroySharedRapierWorld();

      expect(rapierDestroy).toHaveBeenCalledTimes(1);

      const after = await getOrCreateRapierWorld();
      expect(after).not.toBe(before);
    });
  });
});

import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { ThreeJSRenderer } from '@infrastructure/rendering';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { RapierWorld, buildRigidBodySpec } from '@infrastructure/physics';

let sharedRapierWorld: RapierWorld | null = null;
let rapierInitPromise: Promise<RapierWorld> | null = null;

/** Lazily create + init the Rapier world singleton. Called from
 *  useWorldSimulation. M2-A: 1 world per page lifetime; HMR
 *  destroys on dispose (R7). */
export const getOrCreateRapierWorld = async (): Promise<RapierWorld> => {
  if (sharedRapierWorld) return sharedRapierWorld;
  if (!rapierInitPromise) {
    const w = new RapierWorld();
    rapierInitPromise = w.init().then(() => {
      sharedRapierWorld = w;
      return w;
    });
  }
  return rapierInitPromise;
};

export const destroySharedRapierWorld = (): void => {
  if (sharedRapierWorld) {
    sharedRapierWorld.destroy();
    sharedRapierWorld = null;
  }
  rapierInitPromise = null;
};

// HMR teardown (R7) — Vite dispose callback runs on module reload.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroySharedRapierWorld();
  });
}

export const useWorldSimulation = (canvasRef: Ref<HTMLCanvasElement | null>) => {
  const store = useWorldStore();
  const selection = useSelectionStore();
  const isReady = ref(false);
  const rapierReady = ref(false);
  let renderer: ThreeJSRenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rapierWorld: RapierWorld | null = null;

  const setupRenderer = async (canvas: HTMLCanvasElement) => {
    // Init Rapier first so the store can register bodies before the
    // first frame.
    rapierWorld = await getOrCreateRapierWorld();
    rapierReady.value = true;
    // Register existing vehicles in Rapier (covers M1 saved-scene
    // load path AND the default scene built by buildDefaultNetwork).
    for (const v of Object.values(store.getNetwork().vehicles)) {
      rapierWorld.registerVehicle(
        buildRigidBodySpec(v.id, v.type, v.position, v.heading),
      );
    }
    store.setRapierWorld(rapierWorld);

    renderer = new ThreeJSRenderer(canvas, { onTick: store.step });
    renderer.setNetworkGetter(store.getNetwork);
    renderer.setSelectionGetter(() => {
      if (selection.kind && selection.id) {
        return { kind: selection.kind, id: selection.id };
      }
      return null;
    });
    renderer.setTickPolicyGetter(() => ({
      paused: !store.isRunning,
      rate: store.tickRate,
    }));
    renderer.start();
    const container = canvas.parentElement;
    if (container) {
      renderer.resize(container.clientWidth, container.clientHeight);
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          renderer?.resize(width, height);
        }
      });
      resizeObserver.observe(container);
    }
    isReady.value = true;
  };

  watch(
    canvasRef,
    (canvas) => {
      if (canvas) void setupRenderer(canvas);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    renderer?.dispose();
    renderer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    // Note: do NOT destroy the shared RapierWorld here. HMR might
    // re-mount the same composable. HMR disposal goes through
    // import.meta.hot.dispose above.
    rapierWorld = null;
  });

  const getRenderer = (): ThreeJSRenderer | null => renderer;
  return { isReady, rapierReady, store, getRenderer };
};

import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { ThreeJSRenderer } from '@infrastructure/rendering';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';

export const useWorldSimulation = (canvasRef: Ref<HTMLCanvasElement | null>) => {
  const store = useWorldStore();
  const selection = useSelectionStore();
  const isReady = ref(false);
  let renderer: ThreeJSRenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const setupRenderer = (canvas: HTMLCanvasElement) => {
    renderer = new ThreeJSRenderer(canvas, { onTick: store.step });
    // Pass a getter, NOT the network object — the store mutates the
    // network in place each tick, and the renderer's per-frame loop
    // calls the getter to see the latest state.
    renderer.setNetworkGetter(store.getNetwork);
    // Plan B: the renderer reads the current selection each frame and
    // positions the selection ring under the chosen entity.
    renderer.setSelectionGetter(() => {
      if (selection.kind && selection.id) {
        return { kind: selection.kind, id: selection.id };
      }
      return null;
    });
    // Pause + sim rate: read every frame so toolbar/keyboard changes
    // take effect immediately. `isRunning` defaults to `true`; `tickRate`
    // defaults to `1` (real-time).
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
      if (canvas) setupRenderer(canvas);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    renderer?.dispose();
    renderer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  const getRenderer = (): ThreeJSRenderer | null => renderer;
  return { isReady, store, getRenderer };
};

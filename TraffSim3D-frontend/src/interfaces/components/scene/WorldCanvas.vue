<template>
  <div ref="containerRef" class="world-canvas">
    <canvas
      ref="canvasRef"
      data-testid="world-canvas"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue';
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation';
import { useCameraControls } from '@interfaces/composables/useCameraControls';
import { useEditor } from '@interfaces/composables/useEditor';
import type { ThreeJSRenderer } from '@infrastructure/rendering';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { computeNetworkBounds } from '@domain/services/networkBounds';
import { requestFitToNetwork } from '@interfaces/composables/useCameraFocus';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);

// We need a handle on the renderer to wire camera controls + picking.
// `useWorldSimulation` exposes `getRenderer()` once the renderer is constructed
// (see the patch below). We mirror it into a shallowRef so Vue tracks the change.
const { isReady, getRenderer } = useWorldSimulation(canvasRef);
const rendererRef = shallowRef<ThreeJSRenderer | null>(null);
useCameraControls(canvasRef, rendererRef);
const { handleMouseDown, handleMouseMove, handleMouseUp } = useEditor(rendererRef);

// Plan 053: whenever the worldStore requests a fit (network loaded,
// scene switched, OSM imported, undo/redo, manual button), ask the
// camera composable to frame the new network. The 200ms debounce
// guards against rapid back-to-back network changes (e.g. reset
// + immediate OSM load) piling up fit animations.
const world = useWorldStore();
let fitTimer: number | null = null;
const requestFitForCurrent = (): void => {
  if (fitTimer !== null) clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    fitTimer = null;
    const bounds = computeNetworkBounds(world.network);
    if (bounds.diagonal === 0) return;  // empty network, nothing to frame
    // Plan 054: retune the renderer's camera far plane + fog so the
    // ground edge stays hidden when the user zooms out. Without
    // this, a 5km OSM district shows a visible 200m gray square
    // (the default ground size) until the ground is rebuilt — and
    // even after the rebuild, fog hides the boundary smoothly.
    // Also called for built-in scenes (corridor, loop) so their
    // ground edges fade too.
    const halfExtent = bounds.diagonal / 2;
    rendererRef.value?.setSceneScale(Math.max(halfExtent, 50));
    const aspect = canvasRef.value
      ? canvasRef.value.clientWidth / Math.max(1, canvasRef.value.clientHeight)
      : 16 / 9;
    requestFitToNetwork({ bounds, aspect, durationMs: 600 });
  }, 200);
};

// Watch isReady to trigger the FIRST fit once the renderer + OrbitControls
// are wired up. Without this, the camera sits at ThreeJSRenderer's
// default (40, 35, 40) until the user manually clicks "适配场景"
// (Plan 053 follow-up: Playwright caught this bug — initial distance
// 66.5m = default camera position, not the bbox-derived fit distance).
watch(isReady, (ready) => {
  if (ready) {
    rendererRef.value = getRenderer();
    requestFitForCurrent();
  }
});
// Subsequent fits: scene switch, OSM import, undo/redo, manual button.
watch(() => world.fitRequestTick, () => requestFitForCurrent());
</script>

<style scoped>
.world-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.world-canvas canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>

<template>
  <div ref="containerRef" class="world-canvas">
    <canvas ref="canvasRef" @click="handleClick" />
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue';
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation';
import { useCameraControls } from '@interfaces/composables/useCameraControls';
import { useEditor } from '@interfaces/composables/useEditor';
import type { ThreeJSRenderer } from '@infrastructure/rendering';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);

// We need a handle on the renderer to wire camera controls + picking.
// `useWorldSimulation` exposes `getRenderer()` once the renderer is constructed
// (see the patch below). We mirror it into a shallowRef so Vue tracks the change.
const { isReady, getRenderer } = useWorldSimulation(canvasRef);
const rendererRef = shallowRef<ThreeJSRenderer | null>(null);
watch(isReady, (ready) => {
  if (ready) rendererRef.value = getRenderer();
});
useCameraControls(canvasRef, rendererRef);
const { handleClick } = useEditor(rendererRef);
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

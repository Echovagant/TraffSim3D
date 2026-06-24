<template>
  <div v-if="world.cameraEnabled" class="camera-view">
    <header>
      <span>📷 {{ hostLabel }}</span>
      <span class="meta">{{ width }}×{{ height }} · {{ cameraFrameCount }} frames</span>
    </header>
    <canvas ref="canvasRef" :width="width" :height="height" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation';
import {
  CAMERA_DEFAULT_WIDTH,
  CAMERA_DEFAULT_HEIGHT,
  CAMERA_SAMPLE_INTERVAL,
} from '@shared/constants/simulation';
import type { Ref } from 'vue';

const world = useWorldStore();
const selection = useSelectionStore();
// Pass a no-op canvas ref since the camera sensor renders to an
// offscreen WebGLRenderTarget — it doesn't share this component's
// canvas directly.
const noopRef = ref<HTMLCanvasElement | null>(null) as Ref<HTMLCanvasElement | null>;
const { getRenderer } = useWorldSimulation(noopRef);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const width = CAMERA_DEFAULT_WIDTH;
const height = CAMERA_DEFAULT_HEIGHT;
const cameraFrameCount = ref(0);
let lastSampleSimTime = -Infinity;

const hostLabel = computed(() => {
  // Prefer the user's selection if it's a vehicle.
  if (selection.kind === 'vehicle' && selection.id) return selection.id;
  const first = Object.keys(world.network.vehicles)[0];
  return first ?? 'no-host';
});

/** Read a frame from the camera sensor and write it to the canvas.
 *  Throttled by CAMERA_SAMPLE_INTERVAL (5 Hz). Returns true if a
 *  frame was rendered. */
const renderOnce = (simTime: number): boolean => {
  if (!world.cameraEnabled) return false;
  if (simTime - lastSampleSimTime < CAMERA_SAMPLE_INTERVAL) return false;
  const cs = world.getCameraSensor();
  if (!cs || !canvasRef.value) return false;
  const renderer = getRenderer();
  if (!renderer) return false;
  const hostId = hostLabel.value;
  const v = world.network.vehicles[hostId];
  if (!v) return false;
  const frame = cs.render(renderer.getGl(), renderer.getScene(), simTime, {
    position: v.position,
    heading: v.heading,
  });
  cs.renderToCanvas(frame, canvasRef.value);
  cameraFrameCount.value += 1;
  lastSampleSimTime = simTime;
  return true;
};

// Wrap worldStore.step so we get called every tick with simTime.
let origStep: ((dt: number) => number) | null = null;
const wrapStep = (): void => {
  if (origStep) return;
  origStep = world.step;
  world.step = (dt: number): number => {
    const simTime = origStep!(dt);
    renderOnce(simTime);
    return simTime;
  };
};
const unwrapStep = (): void => {
  if (!origStep) return;
  world.step = origStep;
  origStep = null;
};

onMounted(() => {
  wrapStep();
});
onBeforeUnmount(() => {
  unwrapStep();
});
</script>

<style scoped>
.camera-view {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: rgba(15, 23, 42, 0.85);
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #f1f5f9;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  z-index: 5;
}
.camera-view header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  gap: 8px;
}
.camera-view .meta { opacity: 0.6; }
.camera-view canvas {
  display: block;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 4px;
}
</style>
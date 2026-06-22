<template>
  <div class="world-canvas">
    <canvas ref="canvasRef" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation';

const canvasRef = ref<HTMLCanvasElement | null>(null);
useWorldSimulation(canvasRef);
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

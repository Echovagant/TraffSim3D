<template>
  <div class="hud">
    <div>FPS: {{ store.fps }}</div>
    <!-- tickCount is read so the template re-renders every step;
         Object.keys() on the plain-object network is the actual count. -->
    <div>Vehicles: {{ store.tickCount >= 0 ? Object.keys(store.network.vehicles).length : 0 }}</div>
  </div>
</template>

<script setup lang="ts">
import { useWorldStore } from '@interfaces/stores/worldStore';
const store = useWorldStore();
</script>

<style scoped>
.hud {
  position: absolute;
  top: 12px;
  right: 12px;
  padding: 8px 12px;
  background: rgba(15, 23, 42, 0.6);
  color: #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
}
</style>

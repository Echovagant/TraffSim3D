<template>
  <div class="debug">
    <div class="row"><span>FPS</span><b :class="fpsClass">{{ store.fps }}</b></div>
    <div class="row"><span>Vehicles</span><b>{{ vehicleCount }}</b></div>
    <div class="row"><span>Lights</span><b>{{ lightCount }} <small>(R:{{ counts.red }} Y:{{ counts.yellow }} G:{{ counts.green }})</small></b></div>
    <div class="row"><span>Frame ms</span><b>{{ frameMin }}-{{ frameMax }} <small>avg {{ frameAvg }}</small></b></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { LightPhase } from '@domain/value-objects/Phase';
import { M1_MIN_FPS } from '@shared/constants/simulation';

const store = useWorldStore();
const vehicleCount = computed(() => Object.keys(store.network.vehicles).length);
const lightCount = computed(() =>
  Object.values(store.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0));
const counts = computed(() => {
  const out = { red: 0, yellow: 0, green: 0 };
  for (const inter of Object.values(store.network.intersections)) {
    for (const l of inter.trafficLights) {
      if (l.phase === LightPhase.Red) out.red += 1;
      else if (l.phase === LightPhase.Yellow) out.yellow += 1;
      else if (l.phase === LightPhase.Green) out.green += 1;
    }
  }
  return out;
});
const frameMin = computed(() => (store.frameMsMin === Infinity ? 0 : store.frameMsMin.toFixed(1)));
const frameMax = computed(() => (store.frameMsMax === -Infinity ? 0 : store.frameMsMax.toFixed(1)));
const frameAvg = computed(() => store.frameMsAvg.toFixed(1));
const fpsClass = computed(() => (store.fps >= M1_MIN_FPS ? 'ok' : 'warn'));
</script>

<style scoped>
.debug {
  position: absolute;
  top: 12px;
  right: 12px;
  min-width: 220px;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.debug .row { display: flex; justify-content: space-between; gap: 12px; }
.debug .row b { font-weight: 600; }
.debug .row b.ok { color: #22c55e; }
.debug .row b.warn { color: #fbbf24; }
.debug .row small { opacity: 0.6; }
</style>

<!--
  PROTOTYPE — throwaway. Part of the SceneLab layout prototype
  (`/scene-editor?variant=A|B|C`). Delete with the rest of
  `src/interfaces/components/prototype/` once a layout wins.

  The shared simulation readout: the numbers SimulationLab shows today
  (scene stats, signal phases, sensor state, trajectory buffer), read
  LIVE from the store so the prototype shows the real density. Read-only
  on purpose — the question is "where should these live?", not "does the
  backend work?".

  Shared between the variants on purpose: a common *content* block is
  fine (like a shared header); what the variants must not share is the
  *layout* around it — that is what is being judged.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { getAxisQueueLength } from '@application/services/signalController'
import { subscribeOobEvents, type OobEvent } from '@application/services/oobCleanup'

const world = useWorldStore()

const vehicleCount = computed(() => Object.keys(world.network.vehicles).length)
const intersectionCount = computed(() => Object.keys(world.network.intersections).length)
const roadCount = computed(() => Object.keys(world.network.roads).length)
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((n, i) => n + i.trafficLights.length, 0),
)
const changingCount = computed(
  () => Object.values(world.network.vehicles).filter((v) => v.desiredLaneIndex !== null).length,
)

const nsQueue = computed(() => {
  const light = Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .find((l) => l.axis === 'ns')
  return light ? getAxisQueueLength(light, world.network) : 0
})
const ewQueue = computed(() => {
  const light = Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .find((l) => l.axis === 'ew')
  return light ? getAxisQueueLength(light, world.network) : 0
})

/** The signal phases, as a compact list (id / axis / phase / left). */
const lightRows = computed(() =>
  Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .slice(0, 8)
    .map((l) => ({ id: l.id, axis: l.axis, phase: l.phase, left: l.phaseRemaining })),
)

const lastOobEvent = ref<OobEvent | null>(null)
let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = subscribeOobEvents((e) => {
    lastOobEvent.value = e
  })
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="readout">
    <div class="stats">
      <span class="stat"
        ><i>车辆</i><b>{{ vehicleCount }}</b></span
      >
      <span class="stat"
        ><i>路口</i><b>{{ intersectionCount }}</b></span
      >
      <span class="stat"
        ><i>道路</i><b>{{ roadCount }}</b></span
      >
      <span class="stat"
        ><i>灯</i><b>{{ lightCount }}</b></span
      >
      <span class="stat" :class="{ hot: nsQueue > 0 }"
        ><i>NS 队列</i><b>{{ nsQueue }}</b></span
      >
      <span class="stat" :class="{ hot: ewQueue > 0 }"
        ><i>EW 队列</i><b>{{ ewQueue }}</b></span
      >
      <span class="stat"
        ><i>变道</i><b>{{ changingCount }}</b></span
      >
      <span class="stat"
        ><i>tick</i><b>{{ world.tickCount }}</b></span
      >
      <span class="stat" title="车偏离车道后会被拉回车道或放回路口起点">
        <i>越界</i><b>{{ lastOobEvent ? lastOobEvent.kind : '—' }}</b>
      </span>
    </div>

    <div class="phases">
      <span v-for="row in lightRows" :key="row.id" class="phase-row">
        <code>{{ row.id }}</code>
        <span :class="`phase phase-${row.phase}`">{{ row.phase }}</span>
        <em>{{ row.left.toFixed(0) }}s</em>
      </span>
    </div>

    <div class="sensors">
      <span class="chip">LiDAR {{ world.lidarEnabled ? `${world.lidarScanRate}/s` : '关' }}</span>
      <span class="chip"
        >相机 {{ world.cameraEnabled ? `${world.cameraFrameCount}帧` : '关' }}</span
      >
      <span class="chip">轨迹 {{ world.trajectoryExporter.rowCount }} 行</span>
    </div>
  </div>
</template>

<style scoped>
.readout {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 10px;
  background: rgba(15, 23, 42, 0.86);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 8px;
  color: var(--dc-text-dim);
  font-size: 11px;
  overflow: hidden;
}
.stats {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.stat {
  display: flex;
  gap: 4px;
  align-items: baseline;
  white-space: nowrap;
}
.stat i {
  font-style: normal;
  color: var(--dc-text-faint);
}
.stat b {
  color: var(--dc-text);
  font-variant-numeric: tabular-nums;
}
.stat.hot b {
  color: var(--dc-warning);
}
.phases {
  display: flex;
  gap: 6px;
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
}
.phase-row {
  display: flex;
  gap: 4px;
  align-items: baseline;
  white-space: nowrap;
}
.phase-row code {
  color: var(--dc-text-faint);
  font-size: 10px;
}
.phase-row em {
  font-style: normal;
  color: var(--dc-text-dim);
  font-variant-numeric: tabular-nums;
}
.phase {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
}
.phase-green {
  background: rgba(34, 197, 94, 0.22);
  color: #86efac;
}
.phase-yellow {
  background: rgba(234, 179, 8, 0.22);
  color: var(--dc-warning);
}
.phase-red {
  background: rgba(239, 68, 68, 0.22);
  color: #fca5a5;
}
.phase-allRed {
  background: color-mix(in srgb, var(--dc-text-dim) 22%, transparent);
  color: var(--dc-text-dim);
}
.sensors {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.chip {
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dc-text-dim) 15%, transparent);
  color: var(--dc-text-dim);
  white-space: nowrap;
}
</style>

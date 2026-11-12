<!--
  The simulation readout drawer — the bottom strip of the merged lab.

  This is SimulationLab's three data cards (scene stats, signal
  control, performance), re-laid-out for a HORIZONTAL strip: the old
  page stacked them in a 300px column, the drawer runs them side by
  side. Every testid, every control and every number is the same as
  on the old page — only the geometry changed — so the specs that
  drive this page through those testids keep working.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useWorldStore, type SceneKind } from '@interfaces/stores/worldStore'
import { getAxisQueueLength } from '@application/services/signalController'
import { subscribeOobEvents, type OobEvent } from '@application/services/oobCleanup'
import { M1_MIN_FPS } from '@shared/constants/simulation'
import AppSelect from '@interfaces/components/command/AppSelect.vue'
import { CoordinatedConfigModal } from '@interfaces/components/editor'
import { controllerOptions } from '@interfaces/components/editor/controllerOptions'

const world = useWorldStore()
const showCoordinated = ref(false)

// The drawn select's options (the native control's popup is an OS
// window — see components/command/AppSelect.vue). Same sets the old
// page offered. The list lives in one place, and the RL entry says
// whether the policy is ACTUALLY installed — see controllerOptions.ts.
const CONTROLLER_OPTIONS = computed(() =>
  controllerOptions(!!world.signalPolicy, world.signalPolicyOrigin),
)
const SCENE_OPTIONS = [
  { value: 'cross', label: '单路口 (cross)' },
  { value: 'corridor', label: '走廊 (corridor)' },
  { value: 't', label: 'T 型路口 (t)' },
  { value: 'loop', label: '矩形环 (loop)' },
  { value: 'elevated', label: '高架桥 (elevated)' },
  { value: 'grid', label: '5×5 网格 (grid)' },
  { value: 'junction', label: '无信号路口' },
  { value: 'junction-grid', label: '无信号路网' },
  { value: 'micro-city', label: '微型城区' },
]

/**
 * The store's network is a SHALLOW ref — a deep-reactive network of a
 * thousand roads would re-run every dependent on every field write,
 * every frame. The readouts therefore take the store's tick counter
 * as their trigger: every simulation step they recompute from the
 * live network. (Without it these were one-frame snapshots: the
 * countdown table froze at the mount-time phase, the tick display was
 * the only thing that moved.)
 */
const tick = computed(() => world.uiTick)

const vehicleCount = computed(() => {
  void tick.value
  return Object.keys(world.network.vehicles).length
})
const intersectionCount = computed(() => Object.keys(world.network.intersections).length)
const roadCount = computed(() => Object.keys(world.network.roads).length)
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((n, i) => n + i.trafficLights.length, 0),
)
const changingCount = computed(() => {
  void tick.value
  return Object.values(world.network.vehicles).filter((v) => v.desiredLaneIndex !== null).length
})

const nsQueue = computed(() => {
  void tick.value
  const light = Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .find((l) => l.axis === 'ns')
  return light ? getAxisQueueLength(light, world.network) : 0
})
const ewQueue = computed(() => {
  void tick.value
  const light = Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .find((l) => l.axis === 'ew')
  return light ? getAxisQueueLength(light, world.network) : 0
})

/** The signal phases, as a compact list (id / axis / phase / left). */
const lightRows = computed(() => {
  void tick.value
  return Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .slice(0, 6)
    .map((l) => ({ id: l.id, axis: l.axis, phase: l.phase, left: l.phaseRemaining }))
})

const onControllerKindChange = (value: string): void => {
  world.setControllerKind(value as never)
}
const onSceneChange = (value: string): void => {
  world.switchScene(value as SceneKind)
}

// ===== trajectory loss =====
//
// The exporter is a plain class instance, so its counters are not
// reactive on their own — read them through plain functions (the old
// page's comment explains why a computed would cache forever).
const droppedSamples = (): number => world.trajectoryExporter.droppedSampleCount
const recordedSamples = (): number => world.trajectoryExporter.rowCount
const totalSamples = (): number => recordedSamples() + droppedSamples()
const dropRateText = (): string =>
  totalSamples() > 0 ? `${((droppedSamples() / totalSamples()) * 100).toFixed(1)}%` : '—'

// ===== out-of-bounds handling =====
const lastOobEvent = ref<OobEvent | null>(null)
let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = subscribeOobEvents((e) => {
    lastOobEvent.value = e
  })
})
onUnmounted(() => unsubscribe?.())

/**
 * Why the last out-of-bounds event happened — the same labels the old
 * SimulationLab page used, and the vehicle id: a car suddenly
 * reappearing on the road must never be a silent blink.
 */
const OOB_EVENT_LABELS: Record<string, string> = {
  'exit-start': '驶离中',
  reset: '已复位',
  'orphan-removed': '已移除',
  'lane-guard': '车道归位',
  'lateral-guard': '横向纠偏',
}
const oobEventLabel = computed(() =>
  lastOobEvent.value
    ? `${OOB_EVENT_LABELS[lastOobEvent.value.kind] ?? lastOobEvent.value.kind} ${lastOobEvent.value.vehicleId}`
    : '—',
)
const oobEventDetail = computed(() => lastOobEvent.value?.reason ?? '')

// ===== the frame-rate readouts =====
// Frame stats via the non-reactive snapshot (uiTick-triggered) — same
// reason as the debug panel: the per-frame refs would re-render this
// drawer sixty times a second.
const frameSnapshot = computed(() => {
  void world.uiTick
  return world.frameStatsSnapshot()
})
const fpsText = computed(() =>
  frameSnapshot.value.fps > 0 ? String(frameSnapshot.value.fps) : '—',
)
const frameAvg = computed(() =>
  Number.isFinite(frameSnapshot.value.avg) ? `${frameSnapshot.value.avg.toFixed(1)}` : '—',
)
const frameMin = computed(() =>
  Number.isFinite(frameSnapshot.value.min) ? `${frameSnapshot.value.min.toFixed(1)}` : '—',
)
const frameMax = computed(() =>
  Number.isFinite(frameSnapshot.value.max) ? `${frameSnapshot.value.max.toFixed(1)}` : '—',
)
const formatRate = (rate: number): string =>
  Number.isInteger(rate) ? `${rate}×` : `${rate.toFixed(1)}×`
</script>

<template>
  <div class="drawer" data-testid="sim-readout-drawer">
    <!-- 1. scene -->
    <section class="pane">
      <header class="pane-head">
        <h3>场景</h3>
        <AppSelect
          :model-value="world.currentSceneKind"
          :options="SCENE_OPTIONS"
          aria-label="场景"
          data-testid="scene-select"
          @update:model-value="onSceneChange"
        />
      </header>
      <div class="stats">
        <span class="stat"
          ><i>车辆</i><b>{{ vehicleCount }}</b></span
        >
        <span class="stat"
          ><i>道路</i><b>{{ roadCount }}</b></span
        >
        <span class="stat"
          ><i>路口</i><b>{{ intersectionCount }}</b></span
        >
        <span class="stat"
          ><i>灯</i><b>{{ lightCount }}</b></span
        >
        <span class="stat"
          ><i>NS 队列</i><b>{{ nsQueue }}</b></span
        >
        <span class="stat"
          ><i>EW 队列</i><b>{{ ewQueue }}</b></span
        >
        <span class="stat"
          ><i>变道</i><b :class="{ changing: changingCount > 0 }">{{ changingCount }}</b></span
        >
        <span class="stat" title="每个渲染帧 +1；store 变更通知也会 +1">
          <i>tick</i><b data-testid="sim-tick">{{ world.uiTick }}</b></span
        >
        <span class="stat" title="车偏离车道后会被拉回车道或放回路口起点 — 这里记录最近一次的原因">
          <i>越界</i
          ><b data-testid="oob-event" :title="oobEventDetail">{{ oobEventLabel }}</b></span
        >
      </div>
    </section>

    <!-- 2. signals -->
    <section class="pane">
      <header class="pane-head">
        <h3>信号</h3>
        <div class="head-ctrl">
          <AppSelect
            :model-value="world.controllerKind"
            :options="CONTROLLER_OPTIONS"
            aria-label="控制器"
            data-testid="controller-select"
            @update:model-value="onControllerKindChange"
          />
          <button
            class="mini-btn"
            data-testid="coordinated-button"
            :disabled="world.controllerKind !== 'coordinated'"
            @click="showCoordinated = true"
          >
            ⚙ 绿波
          </button>
          <button class="mini-btn danger" data-testid="force-all-red" @click="world.forceAllRed()">
            🚨 全红
          </button>
        </div>
      </header>
      <table class="phase-table">
        <thead>
          <tr>
            <th>灯</th>
            <th>轴</th>
            <th>相位</th>
            <th>剩余</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in lightRows" :key="row.id">
            <td class="dc-num">{{ row.id }}</td>
            <td>{{ row.axis.toUpperCase() }}</td>
            <td>
              <span :class="`phase phase-${row.phase}`">{{ row.phase }}</span>
            </td>
            <td class="dc-num" data-testid="phase-remaining">{{ row.left.toFixed(1) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 3. performance -->
    <section class="pane">
      <header class="pane-head">
        <h3>性能</h3>
        <span
          class="running"
          :class="world.isRunning ? 'is-running' : 'is-paused'"
          data-testid="drawer-running"
        >
          {{ world.isRunning ? '运行中' : '已暂停' }}
        </span>
      </header>
      <div class="stats">
        <span
          class="stat"
          :class="{ warn: world.fps > 0 && world.fps < M1_MIN_FPS }"
          title="最近 500 ms 的实际渲染帧率"
        >
          <i>FPS</i><b data-testid="fps">{{ fpsText }}</b></span
        >
        <span class="stat" title="最近 30 帧的帧间隔均值">
          <i>帧 ms</i><b data-testid="frame-avg">{{ frameAvg }}</b></span
        >
        <span class="stat" title="本次会话中最短的帧间隔">
          <i>min</i><b data-testid="frame-min">{{ frameMin }}</b></span
        >
        <span class="stat" title="本次会话中最长的帧间隔">
          <i>max</i><b data-testid="frame-max">{{ frameMax }}</b></span
        >
        <span class="stat">
          <i>速率</i>
          <b class="rate-control">
            <button
              class="rate-btn"
              data-testid="tick-rate-down"
              title="减速"
              @click="world.cycleTickRate(-1)"
            >
              −
            </button>
            <span class="rate-value" data-testid="tick-rate">{{ formatRate(world.tickRate) }}</span>
            <button
              class="rate-btn"
              data-testid="tick-rate-up"
              title="加速"
              @click="world.cycleTickRate(1)"
            >
              +
            </button>
          </b>
        </span>
        <span class="stat">
          <i>&nbsp;</i>
          <button class="pause-btn" data-testid="pause-button" @click="world.togglePause()">
            {{ world.isRunning ? '⏸ 暂停' : '▶ 播放' }}
          </button>
        </span>
      </div>
      <div class="traj-row">
        <span>Trajectory</span>
        <b data-testid="trajectory-rows"
          >{{ world.trajectoryExporter.rowCount }} /
          {{ world.trajectoryExporter.maxBufferRows }} 行</b
        >
        <b
          data-testid="trajectory-dropped"
          :class="{ warn: droppedSamples() > 0 }"
          title="脏数据过滤器丢弃的样本数 / 全部样本数"
        >
          丢弃 {{ droppedSamples() }} / {{ totalSamples() }} ({{ dropRateText() }})
        </b>
      </div>
    </section>

    <CoordinatedConfigModal v-model:open="showCoordinated" />
  </div>
</template>

<style scoped>
/* The strip: three panes side by side, the drawer scrolls internally
   when the viewport is narrow (the drawer's HOST controls the height). */
.drawer {
  display: grid;
  grid-template-columns: 1.25fr 1fr 1.1fr;
  gap: 0;
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.pane {
  padding: 10px 14px;
  border-right: 1px solid color-mix(in srgb, var(--dc-accent) 18%, transparent);
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pane:last-child {
  border-right: none;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.pane-head h3 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--dc-text-dim);
  text-transform: uppercase;
}
.head-ctrl {
  display: flex;
  align-items: center;
  gap: 6px;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
}
.stat i {
  font-style: normal;
  color: var(--dc-text-faint);
}
.stat b {
  color: var(--dc-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat b.changing {
  color: var(--dc-flow);
}
.stat b.warn {
  color: var(--dc-warning);
}
.stat.warn b {
  color: var(--dc-warning);
}
.running {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
}
.running.is-running {
  color: var(--dc-ok);
  background: color-mix(in srgb, var(--dc-ok) 14%, transparent);
}
.running.is-paused {
  color: var(--dc-warning);
  background: color-mix(in srgb, var(--dc-warning) 14%, transparent);
}
.mini-btn {
  padding: 2px 8px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 36%, transparent);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  color: var(--dc-text);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.mini-btn:hover {
  background: color-mix(in srgb, var(--dc-accent) 20%, transparent);
}
.mini-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mini-btn.danger {
  border-color: color-mix(in srgb, var(--dc-alert) 45%, transparent);
  color: color-mix(in srgb, var(--dc-alert) 82%, var(--dc-text));
}
.phase-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.phase-table th {
  text-align: left;
  color: var(--dc-text-faint);
  font-weight: 500;
  padding: 1px 6px 3px;
  border-bottom: 1px solid color-mix(in srgb, var(--dc-accent) 18%, transparent);
}
.phase-table td {
  padding: 1px 6px;
  color: var(--dc-text-dim);
}
.phase {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
}
.phase-green {
  color: var(--dc-ok);
  background: color-mix(in srgb, var(--dc-ok) 14%, transparent);
}
.phase-yellow {
  color: var(--dc-warning);
  background: color-mix(in srgb, var(--dc-warning) 14%, transparent);
}
.phase-red,
.phase-allRed {
  color: var(--dc-alert);
  background: color-mix(in srgb, var(--dc-alert) 14%, transparent);
}
.rate-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rate-btn {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 36%, transparent);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  color: var(--dc-text);
  cursor: pointer;
  line-height: 1;
}
.rate-value {
  color: var(--dc-text);
  font-weight: 600;
  min-width: 28px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.pause-btn {
  padding: 2px 10px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 40%, transparent);
  background: color-mix(in srgb, var(--dc-accent) 16%, transparent);
  color: var(--dc-text);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.traj-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  color: var(--dc-text-faint);
  margin-top: auto;
}
.traj-row b {
  color: var(--dc-text-dim);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.traj-row b.warn {
  color: var(--dc-warning);
}
</style>

<template>
  <div class="debug">
    <div class="row">
      <span>帧率</span><b data-testid="fps" :class="fpsClass">{{ store.fps }}</b>
    </div>
    <div class="row" data-testid="vehicle-count">
      <span>车辆数</span><b>{{ vehicleCount }}</b>
    </div>
    <div class="row">
      <span>灯数</span
      ><b
        >{{ lightCount }}
        <small>(R:{{ counts.red }} Y:{{ counts.yellow }} G:{{ counts.green }})</small></b
      >
    </div>
    <div class="row" title="信号控制器类型">
      <span>信号</span>
      <b>{{ controllerKindLabel }}</b>
    </div>
    <div v-if="isCoordinated" class="row" title="协调偏移表 (UI only)">
      <span>偏移</span>
      <b>
        <span v-for="[pair, val] in coordinatedPairs" :key="pair" class="offset-chip">
          {{ pair }}: {{ val }}秒
        </span>
        <span v-if="!coordinatedPairs.length" class="warn">— 无路口对</span>
      </b>
    </div>
    <div class="row">
      <span>帧耗时</span
      ><b
        >{{ frameMin }}-{{ frameMax }} <small>平均 {{ frameAvg }}</small></b
      >
    </div>
    <div class="row" :class="{ paused: !store.isRunning }">
      <span>仿真</span>
      <b>{{ store.isRunning ? `运行 @ ${formatRate(store.tickRate)}` : '已暂停' }}</b>
    </div>
    <div class="row" :title="`LiDAR sensors active: ${store.sensorRegistry.sensorCount}`">
      <span>LiDAR</span>
      <b :class="store.lidarEnabled ? 'ok' : ''">
        {{ store.lidarEnabled ? `开 · ${store.lidarFrameCount} 帧` : '关' }}
      </b>
    </div>
    <div class="row" title="按 lane 分布的车辆数">
      <span>车道</span>
      <b>{{ laneDistribution }}</b>
    </div>
    <div
      class="row"
      :title="`Trajectory buffer: ${store.trajectoryExporter.rowCount} / ${store.trajectoryExporter.maxBufferRows} rows`"
    >
      <span>轨迹</span>
      <b>{{ store.trajectoryExporter.rowCount }} 行</b>
    </div>
    <div class="row" :title="cameraTooltip">
      <span>摄像头</span>
      <b :class="cameraClass">{{ cameraLabel }}</b>
    </div>
    <div class="row backend" :title="backendTooltip">
      <span>后端</span>
      <b :class="backendClass">
        <span class="dot" :class="backendDotClass"></span>
        {{ backendLabel }}
      </b>
      <button class="refresh" :disabled="isProbing" title="重新探测后端 (B)" @click="probeBackend">
        {{ isProbing ? '…' : '↻' }}
      </button>
    </div>
    <label
      class="auto-poll"
      :title="autoPoll ? `每 ${POLL_INTERVAL_MS / 1000}s 自动探测` : '关闭自动探测'"
    >
      <input type="checkbox" v-model="autoPoll" />
      <span>自动探测</span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { LightPhase } from '@domain/value-objects/Phase'
import { M1_MIN_FPS } from '@shared/constants/simulation'
import { defaultBackend, BackendError } from '@infrastructure/api'

const store = useWorldStore()
const vehicleCount = computed(() => Object.keys(store.network.vehicles).length)
const lightCount = computed(() =>
  Object.values(store.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0),
)
const counts = computed(() => {
  const out = { red: 0, yellow: 0, green: 0 }
  for (const inter of Object.values(store.network.intersections)) {
    for (const l of inter.trafficLights) {
      if (l.phase === LightPhase.Red) out.red += 1
      else if (l.phase === LightPhase.Yellow) out.yellow += 1
      else if (l.phase === LightPhase.Green) out.green += 1
    }
  }
  return out
})
const frameMin = computed(() => (store.frameMsMin === Infinity ? 0 : store.frameMsMin.toFixed(1)))
const frameMax = computed(() => (store.frameMsMax === -Infinity ? 0 : store.frameMsMax.toFixed(1)))
const frameAvg = computed(() => store.frameMsAvg.toFixed(1))
const fpsClass = computed(() => (store.fps >= M1_MIN_FPS ? 'ok' : 'warn'))

/**
 * Camera readout.
 *
 * "开 · 0 帧" was a control that looked alive and never produced
 * anything. The panel now distinguishes the three real states:
 * off / on-but-no-frame-yet / on-and-rendering. The middle state
 * means the sensor has not delivered a frame yet (no host vehicle, or
 * the renderer is not up) — that is worth saying out loud instead of
 * showing a permanent zero.
 */
const cameraLabel = computed(() => {
  if (!store.cameraEnabled) return '关'
  if (store.cameraFrameCount > 0) return `开 · ${store.cameraFrameCount} 帧`
  return '开 · 等待首帧'
})
const cameraClass = computed(() => {
  if (!store.cameraEnabled) return ''
  return store.cameraFrameCount > 0 ? 'ok' : 'warn'
})
const cameraTooltip = computed(() => {
  if (!store.cameraEnabled) return 'PiP camera inactive — 点工具栏的「摄像头」开启'
  if (store.cameraFrameCount > 0) return `PiP camera active — 已渲染 ${store.cameraFrameCount} 帧`
  return 'PiP camera 已开启但还没有帧 — 传感器尚未产出（场景需有车辆且渲染器已就绪）'
})

// controller kind label + coordinated offset list (read from worldStore).
const controllerKindLabel = computed(() => {
  const k = store.controllerKind
  if (k === 'fixed-cycle') return '固定'
  if (k === 'actuated') return '感应'
  if (k === 'coordinated') return '协调'
  return 'RL (stub)' // stub: does not implement RL control yet
})
const isCoordinated = computed(() => store.controllerKind === 'coordinated')
const coordinatedPairs = computed(() =>
  Array.from(store.coordinatedOffsets.entries())
    .filter(([, v]) => v !== 0)
    .sort(),
)
const laneDistribution = computed(() => {
  void store.tickCount
  const lanes = new Map<string, number>()
  let changing = 0
  for (const v of Object.values(store.network.vehicles)) {
    const key = `${v.roadId}#${v.laneIndex}`
    lanes.set(key, (lanes.get(key) ?? 0) + 1)
    if (v.desiredLaneIndex !== null) changing += 1
  }
  if (lanes.size === 0) return '—'
  const base = Array.from(lanes.entries())
    .sort()
    .map(([k, n]) => `${k}:${n}`)
    .join(' ')
  return changing > 0 ? `${base} · ${changing} 变道中` : base
})

const formatRate = (r: number): string => `${Number(r.toFixed(2))}×`

// ----- Backend probe (Plan A, extended) -----
// On mount, hit `/health` and `/api/v1/ping` in parallel. The user can
// re-trigger with the `↻` button or toggle `auto-poll` to keep the
// status fresh (e.g. while waiting for the backend to come back up).
type BackendState = 'unknown' | 'ok' | 'error'
const POLL_INTERVAL_MS = 5000
const backendState = ref<BackendState>('unknown')
const backendDetail = ref<string>('')
const backendCheckedAt = ref<number | null>(null)
const isProbing = ref(false)
const autoPoll = ref(false)
let pollTimer: number | null = null

const probeBackend = async (): Promise<void> => {
  if (isProbing.value) return
  isProbing.value = true
  try {
    const [h, p] = await Promise.all([defaultBackend.health(), defaultBackend.ping()])
    if (h.status === 'ok' && p.pong === true) {
      backendState.value = 'ok'
      backendDetail.value = `health=${h.status} ping=${String(p.pong)}`
    } else {
      backendState.value = 'error'
      backendDetail.value = `unexpected payload: ${JSON.stringify({ h, p })}`
    }
  } catch (err) {
    backendState.value = 'error'
    backendDetail.value =
      err instanceof BackendError
        ? `${err.status || 'network'}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err)
  } finally {
    backendCheckedAt.value = Date.now()
    isProbing.value = false
  }
}

const startPolling = (): void => {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => {
    void probeBackend()
  }, POLL_INTERVAL_MS)
}
const stopPolling = (): void => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(autoPoll, (on) => {
  if (on) {
    void probeBackend() // probe immediately on toggle
    startPolling()
  } else {
    stopPolling()
  }
})

onMounted(() => {
  void probeBackend()
})

onBeforeUnmount(() => {
  stopPolling()
})

const backendClass = computed(() =>
  backendState.value === 'ok' ? 'ok' : backendState.value === 'error' ? 'warn' : '',
)
const backendDotClass = computed(() => `dot-${backendState.value}`)
const backendLabel = computed(() => {
  if (isProbing.value) return '检查中…'
  if (backendState.value === 'ok') return '在线'
  if (backendState.value === 'error') return '离线'
  return '检查中…'
})
const backendTooltip = computed(() => {
  if (!backendCheckedAt.value) return '后端状态未知'
  const ago = Math.max(0, Math.round((Date.now() - backendCheckedAt.value) / 1000))
  return `${backendDetail.value} (${ago}秒前检查)`
})
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
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.debug .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.debug .row b {
  font-weight: 600;
}
.debug .row b.ok {
  color: #22c55e;
}
.debug .row b.warn {
  color: #fbbf24;
}
.debug .row small {
  opacity: 0.6;
}
.debug .row.paused b {
  color: #fde047;
}

.debug .row.backend {
  border-top: 1px solid rgba(148, 163, 184, 0.2);
  margin-top: 4px;
  padding-top: 4px;
}
.debug .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: 1px;
}
.debug .dot-unknown {
  background: #64748b;
}
.debug .dot-ok {
  background: #22c55e;
  box-shadow: 0 0 4px #22c55e;
}
.debug .dot-error {
  background: #ef4444;
  box-shadow: 0 0 4px #ef4444;
}

.debug button.refresh {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 12px;
  background: #1e293b;
  color: #f1f5f9;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}
.debug button.refresh:hover:not(:disabled) {
  background: #334155;
}
.debug button.refresh:disabled {
  opacity: 0.4;
  cursor: wait;
}

.debug .offset-chip {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 4px;
  background: #1e3a8a;
  color: #dbeafe;
  border-radius: 3px;
  font-size: 10px;
}
.debug b.warn {
  color: #fbbf24;
}

.debug .auto-poll {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.8;
  cursor: pointer;
}
.debug .auto-poll input {
  margin: 0;
}
</style>

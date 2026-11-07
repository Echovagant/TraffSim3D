<template>
  <main class="smart-city">
    <!-- Cesium viewer container (basemap). Sits at z=0;
         Three.js canvas overlays at z=1. Both fill the viewport.
         The raster basemap is inverted + hue-rotated by CSS so the
         light OSM tiles read as a night map — without it a dark
         dashboard sits on a bright map and the whole screen falls
         apart. -->
    <ShowcaseNav variant="minimal" />
    <div ref="cesiumContainer" class="cesium-container" data-testid="cesium-container" />

    <!-- Three.js overlay: transparent background, vehicles + lights
         + LiDAR are drawn here. z=1 so it stacks above the basemap.
         In "free" view mode the canvas takes pointer events so
         OrbitControls can drive the simulation camera (the basemap
         then follows it). -->
    <canvas
      ref="threeCanvas"
      data-testid="world-canvas"
      class="three-canvas"
      :class="{ 'three-canvas--interactive': viewMode === 'free' }"
    />

    <!--
      The command-centre overlay. The container is transparent to the
      pointer (the basemap must stay draggable); the panels take it
      back (pointer-events: auto).
    -->
    <div class="hud" :class="{ 'hud--compact': panelsCollapsed }">
      <!-- ===== 顶栏：标题 + 控制 + 读数带 ===== -->
      <header class="dc-topbar">
        <div class="topbar-left">
          <router-link to="/" class="top-link" title="返回首页">← 首页</router-link>
          <button
            class="top-btn"
            :class="{ paused: !world.isRunning }"
            :title="world.isRunning ? '暂停 (Space)' : '播放 (Space)'"
            data-testid="pause-button"
            @click="world.togglePause()"
          >
            {{ world.isRunning ? '⏸ 暂停' : '▶ 播放' }}
          </button>
          <button
            class="top-btn"
            title="重新框选整个场景 (F)"
            data-testid="fit-scene-button"
            @click="world.requestFit()"
          >
            🎯 适配场景
          </button>
          <label class="top-field" title="Cesium 视图模式">
            <span>视图</span>
            <select v-model="viewMode" data-testid="view-mode-select">
              <option value="bird">鸟瞰 (1500m)</option>
              <option value="street">平视 (1.7m)</option>
              <option value="free">自由</option>
            </select>
          </label>
        </div>

        <h1 class="topbar-title">智慧城市运行管理中心</h1>

        <div class="topbar-right">
          <span class="top-readout" v-if="osmStats">
            <span data-testid="osm-road-count">{{ osmStats.roadCount }} 道路</span>
            <span data-testid="osm-building-count">{{ osmStats.buildingCount }} 建筑</span>
          </span>
          <div class="theme-picker" role="group" aria-label="主题">
            <button
              v-for="t in themes"
              :key="t.id"
              class="theme-dot"
              :class="{ on: themeId === t.id }"
              :title="`${t.label} — ${t.description}`"
              :aria-pressed="themeId === t.id"
              @click="setTheme(t.id)"
            >
              <span v-for="(c, i) in t.swatches" :key="i" :style="{ background: c }"></span>
            </button>
          </div>
          <button
            class="top-btn"
            :class="{ on: panelsCollapsed }"
            title="收起 / 展开两侧面板"
            data-testid="toggle-panels"
            @click="panelsCollapsed = !panelsCollapsed"
          >
            {{ panelsCollapsed ? '▣ 展开面板' : '▤ 收起面板' }}
          </button>
        </div>
      </header>

      <!-- ===== 左列：核心指标 + 车辆状态构成 ===== -->
      <aside class="col col-left" data-testid="col-left">
        <PanelCard title="核心指标" :badge="controllerLabel">
          <div class="metric-grid">
            <MetricCard label="车辆" :value="vehicleCount" unit="辆" live />
            <MetricCard label="信号灯" :value="lightCount" unit="盏" />
            <MetricCard label="交叉口" :value="intersectionCount" unit="处" />
            <MetricCard label="道路" :value="osmStats?.roadCount ?? 0" unit="条" />
            <MetricCard label="建筑" :value="osmStats?.buildingCount ?? 0" unit="栋" />
            <MetricCard label="平均速度" :value="avgSpeed.toFixed(1)" unit="m/s" />
          </div>
        </PanelCard>

        <PanelCard title="车辆状态构成">
          <MiniDonut :slices="vehicleSlices" :caption="String(vehicleCount)" />
        </PanelCard>
      </aside>

      <!-- ===== 右列：交通趋势 + 信号相位 ===== -->
      <aside class="col col-right" data-testid="col-right">
        <PanelCard title="交通趋势" badge="实时">
          <MiniLine :series="trendSeries" :width="264" :height="70" />
        </PanelCard>

        <PanelCard title="信号相位" :badge="`${lightCount} 盏`">
          <ul class="phase-list">
            <li v-for="row in lightRows" :key="row.id">
              <code>{{ row.id }}</code>
              <span class="phase-chip" :class="`phase-${row.phase}`">{{ row.phase }}</span>
              <span class="phase-axis">{{ row.axis.toUpperCase() }}</span>
              <b class="dc-num">{{ row.left.toFixed(0) }}s</b>
            </li>
            <li v-if="lightRows.length === 0" class="empty">本场景没有信号灯</li>
          </ul>
        </PanelCard>
      </aside>

      <!-- ===== 底栏：事件流 ===== -->
      <footer class="bottom-bar" data-testid="bottom-bar">
        <PanelCard title="事件流" :badge="`${events.length} 条`">
          <ul class="event-list">
            <li v-for="(e, i) in events" :key="i" :class="`kind-${e.kind}`">
              <span class="event-time dc-num">{{ e.time }}</span>
              <span class="event-text">{{ e.text }}</span>
            </li>
            <li v-if="events.length === 0" class="empty">
              暂无事件（车辆越界、碰撞等会出现在这里）
            </li>
          </ul>
        </PanelCard>
      </footer>
    </div>

    <!-- Floating error / loading toast (replaces the editor's
         flash-message area while we wait for Cesium + OSM to load). -->
    <div v-if="status" class="status-toast" :class="status.kind" data-testid="status-toast">
      {{ status.text }}
    </div>
  </main>
</template>

<script setup lang="ts">
/**
 * Smart City — the command-centre view.
 *
 * Layering (z=0 below, z=1 above):
 *   z=0  Cesium Viewer  — the OSM basemap + the road/building vectors
 *   z=1  Three.js canvas — vehicles + traffic lights + LiDAR
 *
 * The screen is laid out as the user's own 智慧城市 project does it:
 * a top bar (title + controls + readout band), a left column, the 3D
 * scene in the middle, a right column, and an event feed along the
 * bottom. The panels FLOAT over the map — the basemap is never cropped,
 * so not one line of Cesium logic has to change.
 *
 * Everything is styled from the `--dc-*` tokens, and the 3D scene reads
 * the same tokens for its road/building colours: the dashboard and the
 * city can never disagree about the palette.
 */
import { ShowcaseNav } from '@interfaces/components/showcase'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation'
import { useEditor } from '@interfaces/composables/useEditor'
import { useCameraControls } from '@interfaces/composables/useCameraControls'
import type { ThreeJSRenderer } from '@infrastructure/rendering'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { computeNetworkBounds } from '@domain/services/networkBounds'
import {
  createCesiumViewer,
  DEFAULT_IMAGERY,
  resolveTangentOrigin,
} from '@infrastructure/cesium/viewer'
import {
  loadOSMScene,
  bboxAround,
  DEFAULT_BBOX,
  type LoadedOSMScene,
} from '@infrastructure/cesium/loadOSMScene'
import {
  createCameraSync,
  type CameraSyncContext,
  type TangentOrigin,
} from '@infrastructure/cesium/cameraSync'
import { subscribeOobEvents, type OobEvent } from '@application/services/oobCleanup'
import { useTheme } from '@interfaces/composables/useTheme'
import PanelCard from '@interfaces/components/command/PanelCard.vue'
import MetricCard from '@interfaces/components/command/MetricCard.vue'
import MiniDonut from '@interfaces/components/command/MiniDonut.vue'
import MiniLine from '@interfaces/components/command/MiniLine.vue'

const cesiumContainer = ref<HTMLDivElement | null>(null)
const threeCanvas = ref<HTMLCanvasElement | null>(null)
const viewMode = ref<'bird' | 'street' | 'free'>('bird')
const status = ref<{ kind: 'info' | 'error'; text: string } | null>(null)
const osmStats = ref<{ roadCount: number; buildingCount: number } | null>(null)
/** Both side columns folded away — the map gets the whole screen. */
const panelsCollapsed = ref(false)

const world = useWorldStore()
const { themeId, themes, setTheme, initTheme } = useTheme()

let cesiumViewer: Cesium.Viewer | null = null
let syncRafId: number | null = null
let cameraSync: CameraSyncContext | null = null

// Geographic anchor of the loaded scene. An imported OSM map carries
// its own projection origin; the built-in demo scenes have none and
// fall back to the default 天安门 anchor.
const sceneOrigin = world.network.origin ?? null
const tangent: TangentOrigin = resolveTangentOrigin(sceneOrigin)

// How much of the scene the bird's-eye camera has to cover, and which
// basemap area to fetch. A demo scene keeps the historic 天安门 bbox;
// an imported map gets a bbox around its own origin.
const sceneBounds = computeNetworkBounds(world.network)
const birdHeight = Math.max(1500, Math.round(sceneBounds.diagonal * 1.2))
const osmBbox = sceneOrigin
  ? bboxAround(sceneOrigin.lat, sceneOrigin.lon, Math.max(1500, sceneBounds.diagonal / 2))
  : DEFAULT_BBOX

// Reuse the simulation tick so the simulation keeps running.
const { isReady, getRenderer } = useWorldSimulation(threeCanvas)
const rendererRef = ref<ThreeJSRenderer | null>(null)
watch(isReady, (ready) => {
  if (ready) {
    const r = getRenderer()
    if (!r) return
    r.setRenderMode('smart-city')
    // This view IS the basemap: the Cesium layer underneath has to
    // show through the simulation overlay (the viewer's own comment
    // says the canvas must be transparent for that). The scene editor
    // keeps its opaque dark background.
    r.setTransparentBackground(true)
    rendererRef.value = r
  }
})
useCameraControls(threeCanvas, rendererRef as unknown as Parameters<typeof useCameraControls>[1])
const { handleMouseDown, handleMouseMove, handleMouseUp } = useEditor(
  rendererRef as unknown as Parameters<typeof useEditor>[0],
)

const vehicleCount = computed(() => Object.keys(world.network.vehicles).length)
const intersectionCount = computed(() => Object.keys(world.network.intersections).length)
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0),
)

const avgSpeed = computed(() => {
  const vehicles = Object.values(world.network.vehicles)
  if (vehicles.length === 0) return 0
  const totalSpeed = vehicles.reduce((sum, v) => sum + v.speed, 0)
  return totalSpeed / vehicles.length
})

const controllerLabel = computed(() => {
  const map: Record<string, string> = {
    'fixed-cycle': '固定',
    actuated: '感应',
    coordinated: '协调',
    rl: 'RL (stub)',
  }
  return map[world.controllerKind] || world.controllerKind
})

/** The vehicles by state — the donut's four slices. */
const vehicleSlices = computed(() => {
  const buckets = { driving: 0, waiting: 0, crashed: 0 }
  for (const v of Object.values(world.network.vehicles)) {
    if (v.status === 'crashed') buckets.crashed += 1
    else if (v.status === 'waiting') buckets.waiting += 1
    else buckets.driving += 1
  }
  return [
    { label: '行驶', value: buckets.driving },
    { label: '等待', value: buckets.waiting },
    { label: '碰撞', value: buckets.crashed },
  ]
})

/** The signal phases, newest first. */
const lightRows = computed(() =>
  Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .slice(0, 8)
    .map((l) => ({ id: l.id, axis: l.axis, phase: l.phase, left: l.phaseRemaining })),
)

// ===== the live readouts ==================================================

/** Rolling samples for the trend chart (one per second, 40 points). */
const TREND_LEN = 40
const speedHistory = ref<number[]>([])
const vehicleHistory = ref<number[]>([])
let trendTimer: number | null = null

const trendSeries = computed(() => [
  { label: '平均速度', values: speedHistory.value },
  { label: '车辆', values: vehicleHistory.value },
])

/** The event feed — real events only (vehicle left the lane network,
 *  collisions, phase changes would go here too). */
interface FeedEvent {
  kind: string
  time: string
  text: string
}
const events = ref<FeedEvent[]>([])
let unsubscribeOob: (() => void) | null = null

const pushEvent = (kind: string, text: string): void => {
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  events.value = [{ kind, time, text }, ...events.value].slice(0, 24)
}

const onOobEvent = (e: OobEvent): void => {
  const kind = e.kind === 'lane-guard' || e.kind === 'lateral-guard' ? '车道修正' : '越界'
  pushEvent(kind, e.reason)
}

// ===== lifecycle ==========================================================

onMounted(async () => {
  initTheme()
  unsubscribeOob = subscribeOobEvents(onOobEvent)
  trendTimer = window.setInterval(() => {
    speedHistory.value = [...speedHistory.value, avgSpeed.value].slice(-TREND_LEN)
    vehicleHistory.value = [...vehicleHistory.value, vehicleCount.value].slice(-TREND_LEN)
  }, 1000)

  if (!cesiumContainer.value) {
    status.value = { kind: 'error', text: 'Cesium 容器未挂载' }
    return
  }
  // 1) Construct Cesium viewer (sync — the SDK init is fast).
  try {
    cesiumViewer = createCesiumViewer(cesiumContainer.value, {
      center: tangent,
      zoomLevel: birdHeight,
      imagery: DEFAULT_IMAGERY,
    })
    // The only raster basemap reachable from this network is the OSM
    // standard style — a bright beige map. Under a dark dashboard that
    // reads as a mistake, so the imagery is dimmed, desaturated and
    // hue-shifted toward the night palette. Done on the IMAGERY LAYER
    // (not with a CSS filter on the canvas): a filter would also
    // invert the vector roads and buildings, whose colours come from
    // the theme tokens — the theme would then disagree with itself.
    const imageryLayer = cesiumViewer.imageryLayers.get(0)
    if (imageryLayer) {
      // The raster becomes a faint substrate, not the subject: dimmed
      // hard and nearly desaturated, so the token-coloured vector
      // network (roads/buildings) reads as the city and the OSM
      // building outlines stop shouting in yellow.
      imageryLayer.brightness = 0.26
      imageryLayer.contrast = 1.05
      imageryLayer.saturation = 0.12
      imageryLayer.gamma = 1.25
      // A third of a turn: any raster road line joins the night
      // palette instead of fighting the blue network.
      imageryLayer.hue = 0.55
    }
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `Cesium 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
    }
    return
  }

  // 2) Async load OSM buildings + roads.
  status.value = { kind: 'info', text: '正在从 Overpass 加载 OSM 数据...' }
  // Dev-only handle on the viewer, for the e2e specs (the basemap's
  // tile URL is the thing they assert) — same pattern as the store's
  // `window.__world`, and tree-shaken out of the production bundle.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __cesium?: Cesium.Viewer }).__cesium = cesiumViewer
  }
  try {
    const loaded: LoadedOSMScene = await loadOSMScene(cesiumViewer, osmBbox)
    osmStats.value = {
      roadCount: loaded.roadCount,
      buildingCount: loaded.buildingCount,
    }
    status.value = {
      kind: 'info',
      text: `✓ 已加载 ${loaded.roadCount} 条道路 + ${loaded.buildingCount} 栋建筑`,
    }
    // Fade the toast after 3s.
    setTimeout(() => {
      status.value = null
    }, 3000)
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `OSM 加载失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 3) Start camera sync loop — Cesium → Three.js every frame.
  startCameraSync()
})

// View mode toggle: Cesium flyTo for bird/street; orbit controls
// for free. We watch viewMode and react.
watch(viewMode, (mode) => {
  if (!cesiumViewer) return
  if (mode === 'bird') {
    // Cesium owns the camera again — hand the current view over once
    // so the switch does not jump.
    cameraSync?.setOwner('cesium')
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(tangent.lng, tangent.lat, birdHeight),
      duration: 2,
    })
  } else if (mode === 'street') {
    cameraSync?.setOwner('cesium')
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(tangent.lng, tangent.lat, 1.7),
      orientation: { heading: 0, pitch: 0, roll: 0 },
      duration: 2,
    })
  } else {
    // 'free': Three.js owns the camera (OrbitControls), the basemap
    // follows it. Copy the current Cesium view into Three once (the
    // handover) before the owner flips, so nothing jumps.
    cameraSync?.setOwner('cesium')
    cameraSync?.tick()
    cameraSync?.setOwner('three')
  }
})

/** Per-frame: apply the current owner's direction (Cesium → Three, or
 *  Three → Cesium in "free" mode). Exactly one direction runs per
 *  frame — see the ownership note in cameraSync.ts. */
const startCameraSync = (): void => {
  const tick = (): void => {
    if (!cesiumViewer || !rendererRef.value) {
      syncRafId = requestAnimationFrame(tick)
      return
    }
    if (!cameraSync) {
      cameraSync = createCameraSync({
        cesiumViewer,
        threeCamera: rendererRef.value.getCamera(),
        tangent,
        owner: 'cesium',
      })
    }
    cameraSync.tick()
    syncRafId = requestAnimationFrame(tick)
  }
  syncRafId = requestAnimationFrame(tick)
}

onBeforeUnmount(() => {
  if (syncRafId !== null) cancelAnimationFrame(syncRafId)
  if (trendTimer !== null) window.clearInterval(trendTimer)
  unsubscribeOob?.()
  cesiumViewer?.destroy()
  cesiumViewer = null
})
</script>

<style scoped>
.smart-city {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: var(--dc-screen);
  color: var(--dc-text);
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

/* Cesium container fills the viewport (basemap). */
.cesium-container {
  position: absolute;
  inset: 0;
  z-index: var(--dc-z-base);
}

/* Three.js canvas overlays the basemap. Transparent BG. */
.three-canvas {
  position: absolute;
  inset: 0;
  z-index: var(--dc-z-canvas);
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
.three-canvas--interactive {
  pointer-events: auto;
  cursor: grab;
}

/* ===== the overlay shell =====
   The container is pointer-transparent so the basemap stays
   draggable; the panels take the pointer back. */
.hud {
  position: absolute;
  inset: 0;
  z-index: var(--dc-z-overlay);
  pointer-events: none;
  display: grid;
  grid-template-columns: 300px 1fr 300px;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    'top top top'
    'left . right'
    'bottom bottom bottom';
  gap: var(--dc-gap);
  padding: var(--dc-gap);
}
.hud > * {
  pointer-events: auto;
}

/* ===== 顶栏 ===== */
.dc-topbar {
  grid-area: top;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dc-panel) 92%, transparent) 0%,
    color-mix(in srgb, var(--dc-panel) 55%, transparent) 70%,
    transparent 100%
  );
  border-bottom: 1px solid color-mix(in srgb, var(--dc-accent) 45%, transparent);
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.topbar-title {
  margin: 0;
  font-size: var(--dc-title-size);
  font-weight: 600;
  letter-spacing: 0.24em;
  text-indent: 0.24em;
  color: var(--dc-text);
  text-shadow: 0 0 18px color-mix(in srgb, var(--dc-flow) 45%, transparent);
  white-space: nowrap;
}
.topbar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}
.top-readout {
  display: flex;
  gap: 10px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
  white-space: nowrap;
}
.top-link,
.top-btn {
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--dc-secondary) 55%, transparent);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-screen) 70%, transparent);
  color: var(--dc-text-dim);
  font-size: var(--dc-label-size);
  letter-spacing: 0.08em;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.top-link:hover,
.top-btn:hover {
  border-color: var(--dc-flow);
  color: var(--dc-flow);
}
.top-btn.on {
  border-color: var(--dc-flow);
  color: var(--dc-flow);
}
.top-btn.paused {
  border-color: color-mix(in srgb, var(--dc-alert) 60%, transparent);
  color: color-mix(in srgb, var(--dc-alert) 85%, var(--dc-text));
}
.top-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-faint);
}
.top-field select {
  padding: 4px 6px;
  border: 1px solid color-mix(in srgb, var(--dc-secondary) 55%, transparent);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-screen) 70%, transparent);
  color: var(--dc-text);
  font-size: var(--dc-label-size);
}

/* ===== the theme picker ===== */
.theme-picker {
  display: flex;
  gap: 4px;
}
.theme-dot {
  display: flex;
  padding: 2px;
  gap: 1px;
  border: 1px solid transparent;
  border-radius: var(--dc-radius);
  background: transparent;
  cursor: pointer;
}
.theme-dot span {
  width: 8px;
  height: 14px;
  border-radius: 1px;
}
.theme-dot.on {
  border-color: var(--dc-flow);
  box-shadow: 0 0 10px color-mix(in srgb, var(--dc-flow) 35%, transparent);
}

/* ===== the two columns ===== */
.col {
  display: flex;
  flex-direction: column;
  gap: var(--dc-gap);
  min-height: 0;
  overflow-y: auto;
}
.col-left {
  grid-area: left;
}
.col-right {
  grid-area: right;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

/* ===== 信号相位 ===== */
.phase-list,
.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.phase-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
}
.phase-list code {
  color: var(--dc-text-faint);
  font-size: var(--dc-small-size);
}
.phase-chip {
  padding: 0 5px;
  border-radius: 2px;
  font-size: var(--dc-small-size);
  letter-spacing: 0.06em;
}
.phase-green {
  background: color-mix(in srgb, var(--dc-ok) 26%, transparent);
  color: color-mix(in srgb, var(--dc-ok) 90%, var(--dc-text));
}
.phase-yellow {
  background: color-mix(in srgb, var(--dc-warning) 26%, transparent);
  color: color-mix(in srgb, var(--dc-warning) 90%, var(--dc-text));
}
.phase-red {
  background: color-mix(in srgb, var(--dc-alert) 26%, transparent);
  color: color-mix(in srgb, var(--dc-alert) 90%, var(--dc-text));
}
.phase-allRed {
  background: color-mix(in srgb, var(--dc-secondary) 40%, transparent);
  color: var(--dc-text-dim);
}
.phase-axis {
  flex: 1;
  color: var(--dc-text-faint);
  font-size: var(--dc-small-size);
}
.phase-list b {
  color: var(--dc-text);
}

/* ===== 底栏事件流 ===== */
.bottom-bar {
  grid-area: bottom;
  max-height: 168px;
}
.event-list {
  max-height: 108px;
  overflow-y: auto;
}
.event-list li {
  display: flex;
  gap: 8px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
}
.event-time {
  color: var(--dc-text-faint);
  flex-shrink: 0;
}
.event-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind-越界 .event-text,
.kind-车道修正 .event-text {
  color: color-mix(in srgb, var(--dc-warning) 80%, var(--dc-text));
}
.empty {
  color: var(--dc-text-faint);
  font-size: var(--dc-label-size);
}

/* ===== 收起面板：两侧列让位给地图 ===== */
.hud--compact {
  grid-template-columns: 0 1fr 0;
}
.hud--compact .col {
  display: none;
}

/* ===== responsive =====
   The columns are the first thing to go: on a narrow screen the map
   matters more than the readouts. Below 1100 px both columns fold
   away; the top bar keeps the title, the view controls and the
   "收起/展开面板" button, so the operator can still bring them back. */
@media (max-width: 1400px) {
  .hud {
    grid-template-columns: 260px 1fr 260px;
  }
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  .hud {
    grid-template-columns: 0 1fr 0;
  }
  .col {
    display: none;
  }
  .dc-topbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .topbar-title {
    display: none;
  }
  .top-readout {
    display: none;
  }
}
@media (max-height: 700px) {
  .bottom-bar {
    max-height: 110px;
  }
}

/* ===== the toast ===== */
.status-toast {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--dc-z-toast);
  padding: 8px 16px;
  border-radius: var(--dc-radius);
  font-size: var(--dc-label-size);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.status-toast.info {
  background: color-mix(in srgb, var(--dc-ok) 18%, transparent);
  color: color-mix(in srgb, var(--dc-ok) 85%, var(--dc-text));
  border: 1px solid color-mix(in srgb, var(--dc-ok) 45%, transparent);
}
.status-toast.error {
  background: color-mix(in srgb, var(--dc-alert) 18%, transparent);
  color: color-mix(in srgb, var(--dc-alert) 85%, var(--dc-text));
  border: 1px solid color-mix(in srgb, var(--dc-alert) 45%, transparent);
}
</style>

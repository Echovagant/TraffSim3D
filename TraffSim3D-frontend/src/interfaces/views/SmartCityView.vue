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
            <AppSelect
              v-model="viewMode"
              :options="VIEW_MODE_OPTIONS"
              aria-label="视图"
              data-testid="view-mode-select"
            />
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

    <!-- The cockpit's instrument panel (driving only). -->
    <DriveGauge
      v-if="ride && ride.mode === 'cockpit'"
      :speed-mps="rideSpeed"
      :limit-mps="rideLimit"
      :pedal="world.driverInput"
      :status="rideStatus"
      :signal="rideSignal"
      :steer-deg="rideSteerDeg"
    />

    <!-- The ride banner: tracking / driving one vehicle. -->
    <div v-if="ride" class="ride-banner" data-testid="ride-banner">
      <span class="ride-id">{{ ride.id }}</span>
      <span class="ride-mode">{{
        ride.mode === 'cockpit' ? '驾驶' : ride.mode === 'chase-top' ? '跟踪·俯视' : '跟踪·平视'
      }}</span>
      <button class="ride-btn" data-testid="ride-look" @click="world.toggleRideLook()">
        {{ ride.mode === 'chase-top' ? '平视' : '俯视' }}
      </button>
      <button class="ride-btn" data-testid="ride-drive" @click="driveRide()">
        {{ ride.mode === 'cockpit' ? '跟踪' : '驾驶' }}
      </button>
      <button class="ride-btn ride-exit" data-testid="ride-exit" @click="leaveRide()">退出</button>
      <span class="ride-hint">{{
        ride.mode === 'cockpit'
          ? 'W/S 油门·刹车 · A/D 变道 · 点击空白退出'
          : '点击空白处也可退出 · 滚轮拉远近'
      }}</span>
    </div>
  </main>
</template>

<script setup lang="ts">
// The drawn select's options (the native control's popup is an OS
// window — see components/command/AppSelect.vue).
const VIEW_MODE_OPTIONS = [
  { value: 'bird', label: '鸟瞰 (1500m)' },
  { value: 'street', label: '平视 (1.7m)' },
  { value: 'free', label: '自由' },
]
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
import AppSelect from '@interfaces/components/command/AppSelect.vue'
import { ShowcaseNav } from '@interfaces/components/showcase'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation'
import { useEditor } from '@interfaces/composables/useEditor'
import { useCameraControls } from '@interfaces/composables/useCameraControls'
import type { ThreeJSRenderer } from '@infrastructure/rendering'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { computeNetworkBounds } from '@domain/services/networkBounds'
import { approachSignalFor, signalPhaseLabel } from '@domain/services/approachSignal'
import { laneForwardSign, roadForward, roadLength } from '@domain/services/laneGeometry'
import {
  createCesiumViewer,
  DEFAULT_IMAGERY,
  resolveTangentOrigin,
} from '@infrastructure/cesium/viewer'
import {
  loadNetworkRoads,
  loadOSMBuildings,
  localToLngLat,
  bboxAround,
  DEFAULT_BBOX,
  type LoadedNetworkRoads,
} from '@infrastructure/cesium/loadOSMScene'
import {
  createCameraSync,
  type CameraSyncContext,
  type TangentOrigin,
} from '@infrastructure/cesium/cameraSync'
import { subscribeOobEvents, type OobEvent } from '@application/services/oobCleanup'
import { useTheme } from '@interfaces/composables/useTheme'
import { useSampleCity } from '@interfaces/composables/useSampleCity'
import PanelCard from '@interfaces/components/command/PanelCard.vue'
import MetricCard from '@interfaces/components/command/MetricCard.vue'
import MiniDonut from '@interfaces/components/command/MiniDonut.vue'
import MiniLine from '@interfaces/components/command/MiniLine.vue'
import DriveGauge from '@interfaces/components/command/DriveGauge.vue'

const cesiumContainer = ref<HTMLDivElement | null>(null)
const threeCanvas = ref<HTMLCanvasElement | null>(null)
const viewMode = ref<'bird' | 'street' | 'free'>('bird')
const status = ref<{ kind: 'info' | 'error'; text: string } | null>(null)
const osmStats = ref<{ roadCount: number; buildingCount: number } | null>(null)
/** Both side columns folded away — the map gets the whole screen. */
const panelsCollapsed = ref(false)

const world = useWorldStore()
const { themeId, themes, setTheme, initTheme } = useTheme()
const { loadSampleCity } = useSampleCity()

let cesiumViewer: Cesium.Viewer | null = null
let syncRafId: number | null = null
let cameraSync: CameraSyncContext | null = null
// The two city layers, kept so a theme switch can re-colour them.
let networkRoads: LoadedNetworkRoads | null = null
let osmBuildings: { restyle: () => void } | null = null

// Geographic anchor of the loaded scene.
//
// The view loads a REAL city (the backend's bundled 深圳福田 extract)
// before the basemap is built, so the anchor, the camera height and the
// basemap rectangle all follow the loaded network — not the demo scene
// that happened to be in the store when the view mounted. That is the
// whole point: the cars and the picture must describe one place.
const sceneOrigin = computed(() => world.network.origin ?? null)
const tangent = computed<TangentOrigin>(() => resolveTangentOrigin(sceneOrigin.value))

// How much of the scene the bird's-eye camera has to cover, and which
// basemap area to fetch. A demo scene keeps the default bbox; a loaded
// city gets a bbox around its own origin.
const sceneBounds = computed(() => computeNetworkBounds(world.network))
const birdHeight = computed(() => {
  const diagonal = sceneBounds.value.diagonal
  // A 45° oblique frames a ground swath of about `height` metres in
  // front of the camera, so the altitude has to match the size of the
  // area we want to see — not the 1.2× diagonal a plan view needs.
  return Math.max(1200, Math.min(4200, Math.round(diagonal * 0.55)))
})
const osmBbox = computed(() =>
  sceneOrigin.value
    ? bboxAround(
        sceneOrigin.value.lat,
        sceneOrigin.value.lon,
        Math.max(1500, sceneBounds.value.diagonal / 2),
      )
    : DEFAULT_BBOX,
)

// The bird's-eye camera: a 45° oblique, not a plan view.
//
// A vertical top-down view reads as a MAP; a 45° oblique reads as a
// CITY — the buildings get their sides, the streets get their
// perspective, the cars have a horizon to drive toward. The reference
// project frames it the same way (altitude 1500 m, 45° tilt, camera
// pulled back by the distance it is high).
const OVERHEAD_TILT_RAD = Math.PI / 4

/** Where the street-level camera stands: on a real road, not inside a
 *  block. The projection origin is the middle of the drawn rectangle,
 *  which in a city is as likely to be a building as a street. */
const streetAnchor = computed(() => {
  const origin = sceneOrigin.value
  const fallback = { lng: tangent.value.lng, lat: tangent.value.lat }
  if (!origin) return fallback
  let best: { lng: number; lat: number } | null = null
  let bestDist = Infinity
  for (const road of Object.values(world.network.roads)) {
    const points =
      road.waypoints && road.waypoints.length >= 2
        ? road.waypoints
        : [road.startNode, road.endNode]
    const mid = points[Math.floor(points.length / 2)]
    if (!mid) continue
    const dist = mid.x * mid.x + mid.z * mid.z
    if (dist >= bestDist) continue
    bestDist = dist
    best = localToLngLat(origin, mid.x, mid.z)
  }
  return best ?? fallback
})

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

// uiTick (10 Hz) is the reactive trigger for every readout below:
// the network is a shallow ref that mutates IN PLACE while the sim
// runs, so a computed keyed only on it never recomputes and the
// panel froze at its mount-time values.
const readoutTick = computed(() => world.uiTick)

const vehicleCount = computed(() => {
  void readoutTick.value
  return Object.keys(world.network.vehicles).length
})
const intersectionCount = computed(() => Object.keys(world.network.intersections).length)
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0),
)

const avgSpeed = computed(() => {
  void readoutTick.value
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
  void readoutTick.value
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
const lightRows = computed(() => {
  void readoutTick.value
  return Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .slice(0, 8)
    .map((l) => ({ id: l.id, axis: l.axis, phase: l.phase, left: l.phaseRemaining }))
})

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
  // The event's `reason` is the domain layer's English text (the unit
  // tests pin it). The dashboard speaks Chinese, so the message is
  // assembled here from the STRUCTURED fields — not by translating the
  // string — so a wording change in the domain can never garble it.
  const d = e.distance.toFixed(1)
  const v = e.speed.toFixed(1)
  let kind = '越界'
  let text: string
  switch (e.kind) {
    case 'lane-guard':
      kind = '车道修正'
      text = `${e.vehicleId} 偏离车道点 ${d} m（${v} m/s）—— 已拉回，速度清零`
      break
    case 'lateral-guard':
      kind = '车道修正'
      text = `${e.vehicleId} 侧向漂移 ${d} m（${v} m/s）—— 已修正，速度限幅`
      break
    case 'exit-start':
      kind = '越界'
      text = `${e.vehicleId} 驶出路网（偏离 ${d} m）—— 刹停中`
      break
    case 'reset': {
      kind = '复位'
      const why =
        e.resetReason === 'stopped' ? '已停稳' : e.resetReason === 'distance' ? '滑出过远' : '超时'
      text = `${e.vehicleId} 已送回${e.roadId ?? '原路'} 车道 ${e.laneIndex ?? 0} 起点（${why}）`
      break
    }
    case 'orphan-removed':
      kind = '移除'
      text = `${e.vehicleId} 所在道路已不存在 —— 车辆已移除`
      break
    default:
      text = e.reason
  }
  pushEvent(kind, text)
}

/**
 * Tune the raster basemap and the sky for the current theme.
 *
 * The only raster basemap reachable from this network is the OSM
 * standard style — a bright beige map. Under a dark dashboard that
 * reads as a mistake, so on the dark themes it is dimmed, desaturated
 * and hue-shifted into a faint substrate (the vector network is the
 * subject); on the paper theme it is left at its natural brightness.
 * Done on the IMAGERY LAYER (not with a CSS filter on the canvas): a
 * filter would also invert the vector roads and buildings, whose
 * colours come from the theme tokens.
 *
 * The sky follows the same rule: Cesium's default atmosphere is a BLUE
 * gradient, and at street level it fills the whole upper half of the
 * frame — a blue sky over a dark dashboard is the same mistake. The
 * dark themes turn it off (the backdrop becomes the theme's screen
 * colour); paper keeps it.
 */
const applyBasemapTuning = (viewer: Cesium.Viewer, theme: string): void => {
  const imageryLayer = viewer.imageryLayers.get(0)
  if (imageryLayer) {
    const paper = theme === 'paper'
    // The clay theme keeps a whisper of raster texture (its buildings
    // are light and a fully-black ground reads as a void from street
    // level) — but at 0.34 the ground washed out the whole street-level
    // frame and the white model lost its base. 0.22 keeps the texture
    // and lets the road ribbons own the lower band.
    const dim = theme === 'paper' ? 1 : theme === 'clay' ? 0.22 : 0.26
    imageryLayer.brightness = dim
    imageryLayer.contrast = paper ? 1 : 1.05
    imageryLayer.saturation = paper ? 1 : 0.12
    imageryLayer.gamma = paper ? 1 : 1.25
    // A third of a turn: any raster road line joins the night palette
    // instead of fighting the token colours.
    imageryLayer.hue = paper ? 0 : 0.55
  }
  const dark = theme !== 'paper'
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = !dark
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = !dark
  // What shows behind the tiles when the sky is off — the theme's own
  // screen colour, so the void is THE THEME's void, not Cesium's black.
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(
    theme === 'paper' ? '#f5f5f7' : tokenScreen(theme),
  )
}

/** The theme's screen colour — read from the CSS custom property so a
 *  token change never has to touch this file. The theme is already
 *  applied to the document root whenever this runs (initTheme at
 *  mount; setTheme before the watch fires). */
const tokenScreen = (_theme: string): string => {
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--dc-screen').trim()
    if (raw.length > 0) return raw
  }
  return '#0d1117'
}

// ===== the ride (tracking / driving) ======================================

/** Banner state, or null when the camera rides with nobody. */
const ride = computed(() => {
  const id = world.rideVehicleId
  if (!id) return null
  return { id, mode: world.rideMode }
})

const driveRide = (): void => {
  if (!world.rideVehicleId) return
  world.setRideMode(world.rideMode === 'cockpit' ? 'chase' : 'cockpit')
}

/**
 * The cluster's readouts, and why they take the tick counter.
 *
 * The store's network is a **shallow** ref — a deep-reactive network
 * of 1 000 roads and 90 vehicles would re-evaluate every dependent on
 * every field write, every frame. So the readouts below would have
 * been one-frame snapshots: the dial would have shown the speed the
 * car had when the ride started.
 *
 * The store already counts the ticks (`tickCount`, a ref that grows on
 * every simulation step), so reading it here is the trigger: every
 * tick the cluster recomputes from the live network. The numbers stay
 * exactly what the simulation has — the gauge invents nothing.
 */
const rideVehicle = computed(() => {
  void world.uiTick
  const id = world.rideVehicleId
  if (!id) return null
  return world.network.vehicles[id] ?? null
})
const rideSpeed = computed(() => rideVehicle.value?.speed ?? 0)
const rideLimit = computed(() => {
  const v = rideVehicle.value
  if (!v) return 0
  return world.network.roads[v.roadId]?.speedLimit ?? 0
})
const rideStatus = computed(() => rideVehicle.value?.status ?? 'driving')

/**
 * The signal ahead of the car, for the cluster.
 *
 * Read from the LIVE network — the tick writes the phase and the
 * countdown every frame — so the lamp shows the real signal, not a
 * forecast of it.
 */
const rideSignal = computed(() => {
  void world.uiTick
  const v = rideVehicle.value
  if (!v) return null
  const signal = approachSignalFor(v, world.network)
  if (!signal) return null
  const label = signalPhaseLabel(signal.phase)
  const tone: 'go' | 'warn' | 'stop' =
    label === '绿灯' ? 'go' : label === '黄灯' || label === '闪黄' ? 'warn' : 'stop'
  return { label, remainingS: signal.remainingS, distanceM: signal.distanceM, tone }
})

/**
 * The steering angle: the car's heading against its lane's direction.
 *
 * This is the quantity the lane guard watches (a car pointing away
 * from its lane is the failure the guard corrects), so the wheel
 * shows the car's real attitude to the road — it turns when the car
 * drifts, and through the turn arcs.
 */
const rideSteerDeg = computed(() => {
  void world.uiTick
  const v = rideVehicle.value
  if (!v) return 0
  const road = world.network.roads[v.roadId]
  if (!road) return 0
  // The wheel shows how much steering the road ahead ASKS for: the
  // angle between where the car points now and the lane's heading a
  // car's-length-and-a-half ahead. On a straight that is zero; in a
  // bend it is the corner the wheel has to hold. (Comparing the car's
  // heading with the lane's tangent AT the car would read zero in a
  // bend too — the car follows the tangent — which is why the wheel
  // looked frozen.)
  const len = roadLength(road)
  const lookS = Math.min(len, Math.max(0, v.s + 18))
  const ahead = roadForward(road, lookS)
  // The tangent is the ROAD's; a car on a backward lane travels the
  // other way, so the sign of the lane flips it — otherwise every car
  // on the oncoming carriageway would show the wheel at full lock.
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  const aheadHeading = Math.atan2(ahead.uz * sign, ahead.ux * sign)
  let diff = aheadHeading - v.heading
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  let deg = (diff * 180) / Math.PI
  // A lane change IS a steering input: the wheel turns the way the
  // car is crossing. Lane 0 is the rightmost, so a HIGHER target lane
  // is a turn to the LEFT — negative on the dial.
  if (v.desiredLaneIndex !== null && v.desiredLaneIndex !== v.laneIndex) {
    deg += v.desiredLaneIndex > v.laneIndex ? -26 : 26
  }
  return deg
})

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

  // 1) Load the city FIRST — before the basemap exists.
  //
  // The order is the whole fix: the basemap is built FROM the loaded
  // network (its anchor, its rectangle and its very road geometry), so
  // a car can never end up on a street the picture does not contain.
  status.value = { kind: 'info', text: '正在载入深圳福田路网...' }
  const city = await loadSampleCity()
  if (city.ok) {
    status.value = {
      kind: 'info',
      text: `✓ 福田路网 ${city.roadCount} 条道路 · ${city.vehicleCount} 辆车已就位`,
    }
  } else {
    // The city could not be loaded — the demo scene stays in the store
    // and the view still works, but it must say so.
    status.value = {
      kind: 'error',
      text: `路网载入失败（${city.error ?? '未知原因'}）— 显示当前场景`,
    }
  }

  // 2) Construct Cesium viewer (sync — the SDK init is fast).
  try {
    cesiumViewer = createCesiumViewer(cesiumContainer.value, {
      center: tangent.value,
      zoomLevel: birdHeight.value,
      imagery: DEFAULT_IMAGERY,
    })
    // The viewer opens looking straight down (Cesium's default for a
    // destination without an orientation). A command centre wants the
    // 45° oblique, so the camera is placed explicitly right away.
    const opening = birdView.value
    cesiumViewer.camera.setView({
      destination: opening.destination,
      orientation: { heading: opening.heading, pitch: opening.pitch, roll: 0 },
    })
    // The raster basemap, the sky and the globe colour all FOLLOW the
    // theme — and a theme switch re-runs this (the watch below), so the
    // map and the dashboard never disagree.
    applyBasemapTuning(cesiumViewer, themeId.value)
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `Cesium 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
    }
    return
  }

  // 3) Draw the city: the SIMULATED roads first (they are the ones the
  //    cars drive on), then the buildings around them.
  status.value = { kind: 'info', text: '正在绘制路网与建筑...' }
  // Dev-only handle on the viewer, for the e2e specs (the basemap's
  // tile URL is the thing they assert) — same pattern as the store's
  // `window.__world`, and tree-shaken out of the production bundle.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __cesium?: Cesium.Viewer }).__cesium = cesiumViewer
  }
  try {
    const roads: LoadedNetworkRoads = await loadNetworkRoads(
      cesiumViewer,
      world.network,
      sceneOrigin.value,
    )
    networkRoads = roads
    // The road count is published as soon as the roads are on the map —
    // the buildings take a while longer, and a panel that says
    // 「道路 0 条」 while a thousand roads are drawn is a lie.
    osmStats.value = { roadCount: roads.roadCount, buildingCount: 0 }
    const buildings = await loadOSMBuildings(cesiumViewer, osmBbox.value)
    osmBuildings = buildings
    osmStats.value = {
      roadCount: roads.roadCount,
      buildingCount: buildings.buildingCount,
    }
    status.value = {
      kind: 'info',
      text: `✓ ${roads.roadCount} 条仿真道路 + ${buildings.buildingCount} 栋建筑`,
    }
    // Fade the toast after 3s.
    setTimeout(() => {
      status.value = null
    }, 3000)
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `城市绘制失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 3) Start camera sync loop — Cesium → Three.js every frame.
  startCameraSync()

  // 4) The interaction layer: walking keys, the Alt free look, and
  //    click-to-track. All on `window`/`document` — the Cesium canvas
  //    keeps dragging the basemap and rarely owns keyboard focus.
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlurWindow)
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  cesiumContainer.value?.addEventListener('mousemove', onMouseLook)
})

/**
 * The 45° oblique view of the city.
 *
 * The camera stands due south of the city centre, at the same distance
 * back as it is high — that is what makes the tilt exactly 45° — and
 * looks north. The city fills the lower two thirds of the frame and
 * the skyline sits on the upper third.
 */
const birdView = computed(() => {
  const t = tangent.value
  const height = birdHeight.value
  const back = height / Math.tan(OVERHEAD_TILT_RAD)
  // The bearing from the city centre TO the camera, clockwise from north.
  const bearing = Math.PI
  const cosLat = Math.max(0.05, Math.cos((t.lat * Math.PI) / 180))
  const dLat = (back * Math.cos(bearing)) / 111000
  const dLng = (back * Math.sin(bearing)) / (111000 * cosLat)
  return {
    destination: Cesium.Cartesian3.fromDegrees(t.lng + dLng, t.lat + dLat, height),
    // Looking back at the centre: the camera's heading is the bearing
    // from the centre to the camera, plus half a turn.
    heading: bearing + Math.PI,
    pitch: -OVERHEAD_TILT_RAD,
  }
})

// The ride (tracking / driving) hands the camera to Three.js — the
// basemap follows through the sync. EVERY path in and out (a click, a
// programmatic ride, the exit button) goes through this watch, so the
// ownership can never disagree with the ride state.
watch(
  () => world.rideVehicleId,
  (id) => {
    if (!cameraSync) return
    if (id) {
      cameraSync.setOwner('three')
    } else {
      cameraSync.setOwner('cesium')
    }
  },
)

// A theme switch changes the road and building colours — and the
// Cesium layers bake their colours in at creation, so they have to be
// re-coloured explicitly. The raster basemap and the sky follow the
// same switch. Without this the city would keep the old palette while
// the dashboard around it changed.
watch(themeId, (theme) => {
  networkRoads?.restyle()
  osmBuildings?.restyle()
  if (cesiumViewer) applyBasemapTuning(cesiumViewer, theme)
})

// View mode toggle: Cesium flyTo for bird/street; orbit controls
// for free; the ride camera (tracking / driving) takes the Three.js
// camera and lets the basemap follow. We watch viewMode and react.
watch(viewMode, (mode) => {
  if (!cesiumViewer) return
  if (world.rideVehicleId) {
    // Riding: the follow camera owns the view regardless of the
    // dropdown. The dropdown itself is restored when the ride ends.
    cameraSync?.setOwner('three')
    return
  }
  if (mode === 'bird') {
    // Cesium owns the camera again — hand the current view over once
    // so the switch does not jump.
    cameraSync?.setOwner('cesium')
    const view = birdView.value
    cesiumViewer.camera.flyTo({
      destination: view.destination,
      orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
      duration: 2,
    })
  } else if (mode === 'street') {
    cameraSync?.setOwner('cesium')
    const anchor = streetAnchor.value
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(anchor.lng, anchor.lat, 1.7),
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

// ===== riding: click a car to track it, drive it, or leave =========
//
// A click picks a vehicle through the Three.js camera (the same ray
// the editor uses). Dragging the basemap must NOT pick, so the click
// is only honoured when the pointer travelled less than a few pixels
// between down and up.
const downPos = { x: 0, y: 0 }
const onPointerDown = (e: PointerEvent): void => {
  downPos.x = e.clientX
  downPos.y = e.clientY
}
const onPointerUp = (e: PointerEvent): void => {
  if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return
  const renderer = rendererRef.value
  if (!renderer) return
  const hit = renderer.pick(e.clientX, e.clientY, world.network)
  if (hit?.kind === 'vehicle') {
    world.setRideVehicle(hit.id, 'chase')
  } else if (world.rideVehicleId) {
    // Clicking empty space leaves the ride — the basemap comes back.
    leaveRide()
  }
}

const leaveRide = (): void => {
  world.setRideVehicle(null)
  // Back to the mode the ride interrupted (the oblique is the home).
  cameraSync?.setOwner('cesium')
  const view = birdView.value
  cesiumViewer?.camera.flyTo({
    destination: view.destination,
    orientation: { heading: view.heading, pitch: view.pitch, roll: 0 },
    duration: 1.2,
  })
}

/** The ride's keyboard: C toggles the tracking look, X drives, Esc leaves,
 *  and while DRIVING the A/D keys are the steering intent (the lane
 *  change is what the lane model offers as steering). */
const onRideKey = (e: KeyboardEvent): void => {
  if (!world.rideVehicleId) return
  if (e.code === 'KeyC') world.toggleRideLook()
  else if (e.code === 'KeyX')
    world.setRideMode(world.rideMode === 'cockpit' ? 'chase' : 'cockpit')
  else if (e.code === 'Escape') leaveRide()
  else if (e.code === 'KeyA' && world.rideMode === 'cockpit') {
    flashLaneChange(world.requestLaneChange(world.rideVehicleId, 'left'))
  } else if (e.code === 'KeyD' && world.rideMode === 'cockpit') {
    flashLaneChange(world.requestLaneChange(world.rideVehicleId, 'right'))
  }
}

/**
 * A rejected steering intent must SAY why — on this city's mostly
 * two-lane ways there is often no lane to change into (a forward car
 * on a 2-lane street has the oncoming carriageway on its left and the
 * curb on its right), and a silent refusal reads as a broken key.
 */
const flashLaneChange = (r: { ok: boolean; reason?: string }): void => {
  if (r.ok) return
  const texts: Record<string, string> = {
    crashed: '车辆已碰撞，无法变道',
    'already-changing': '正在变道中',
    'in-intersection': '路口内不能变道',
    'too-slow': '车速过低，无法变道（需 5 m/s 以上）',
    'not-found': '车辆不在路网上',
    'no-target-lane': '该方向没有目标车道',
    'not-drivable-lane': '该方向没有可行驶车道',
  }
  const text = texts[r.reason ?? ''] ?? '此处无法变道'
  status.value = { kind: 'info', text }
  setTimeout(() => {
    if (status.value?.text === text) status.value = null
  }, 2000)
}

// ===== street-level walking: WASD moves, Alt+mouse looks ============
//
// The reference project's pattern: keys are collected in a Set on
// `window` (a dashboard often has no canvas focus), Alt enters the
// free look by disabling Cesium's own drag controller while held, and
// a blur releases everything — otherwise the car walks on after an
// Alt+Tab.
const keysDown = new Set<string>()
let altLook = false

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
  )
}

const setStreetControlsEnabled = (enabled: boolean): void => {
  const controller = cesiumViewer?.scene.screenSpaceCameraController
  if (!controller) return
  controller.enableRotate = enabled
  controller.enableTranslate = enabled
  controller.enableTilt = enabled
  controller.enableZoom = enabled
}

const onKeyDown = (e: KeyboardEvent): void => {
  if (isTypingTarget(e.target)) return
  keysDown.add(e.code)
  onRideKey(e)
  if (viewMode.value === 'street' && (e.code === 'AltLeft' || e.code === 'AltRight')) {
    // Alt hands the look to the mouse; without preventDefault the
    // browser moves focus to its own menu bar.
    e.preventDefault()
    altLook = true
    setStreetControlsEnabled(false)
  }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
}
const onKeyUp = (e: KeyboardEvent): void => {
  keysDown.delete(e.code)
  if (e.code === 'AltLeft' || e.code === 'AltRight') {
    altLook = false
    setStreetControlsEnabled(true)
  }
}
const onBlurWindow = (): void => {
  keysDown.clear()
  altLook = false
  setStreetControlsEnabled(true)
}
const onMouseLook = (e: MouseEvent): void => {
  if (!altLook || !cesiumViewer) return
  // A few pixels of mouse turn into a few degrees of look — the
  // factor is what feels natural at eye height.
  const k = 0.0045
  cesiumViewer.camera.lookRight(e.movementX * k)
  cesiumViewer.camera.lookUp(e.movementY * k)
  // The walk is a WALK: clamp the pitch so the camera cannot flip
  // under the ground or into the sky.
  const pitch = cesiumViewer.camera.pitch
  const maxUp = 0.35
  const minDown = -Math.PI / 2 + 0.08
  if (pitch > maxUp) cesiumViewer.camera.lookUp(maxUp - pitch)
  if (pitch < minDown) cesiumViewer.camera.lookUp(minDown - pitch)
}

/** One frame of street walking: WASD relative to the look direction. */
const walkStreet = (dt: number): void => {
  if (!cesiumViewer || viewMode.value !== 'street' || world.rideVehicleId) return
  const speed = keysDown.has('ShiftLeft') || keysDown.has('ShiftRight') ? 6 : 2.5
  let moved = false
  if (keysDown.has('KeyW') || keysDown.has('ArrowUp')) {
    cesiumViewer.camera.moveForward(speed * dt)
    moved = true
  }
  if (keysDown.has('KeyS') || keysDown.has('ArrowDown')) {
    cesiumViewer.camera.moveBackward(speed * dt)
    moved = true
  }
  if (keysDown.has('KeyA') || keysDown.has('ArrowLeft')) {
    cesiumViewer.camera.moveLeft(speed * dt)
    moved = true
  }
  if (keysDown.has('KeyD') || keysDown.has('ArrowRight')) {
    cesiumViewer.camera.moveRight(speed * dt)
    moved = true
  }
  if (!moved) return
  // Pin the eye height: moveForward follows the look direction, and a
  // tilted look would walk the camera into the sky or under the map.
  const carto = cesiumViewer.camera.positionCartographic
  if (carto && Math.abs(carto.height - 1.7) > 0.05) {
    cesiumViewer.camera.position = Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      1.7,
    )
  }
}

/** Per-frame: apply the current owner's direction (Cesium → Three, or
 *  Three → Cesium in "free" mode). Exactly one direction runs per
 *  frame — see the ownership note in cameraSync.ts. */
const startCameraSync = (): void => {
  let last = performance.now()
  const tick = (): void => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (!cesiumViewer || !rendererRef.value) {
      syncRafId = requestAnimationFrame(tick)
      return
    }
    walkStreet(dt)
    // The cockpit's pedals: W/S held = throttle/brake. The intent goes
    // into the tick through `driverOverride`; letting go of both hands
    // the car straight back to its AI the very next tick.
    if (world.rideVehicleId && world.rideMode === 'cockpit') {
      world.setDriverInput(
        keysDown.has('KeyW') ? 'accel' : keysDown.has('KeyS') ? 'brake' : null,
      )
    } else if (world.driverInput !== null) {
      world.setDriverInput(null)
    }
    if (!cameraSync) {
      cameraSync = createCameraSync({
        cesiumViewer,
        threeCamera: rendererRef.value.getCamera(),
        tangent: tangent.value,
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
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onBlurWindow)
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointerup', onPointerUp)
  cesiumContainer.value?.removeEventListener('mousemove', onMouseLook)
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

/* ===== the cockpit cluster =====
   Above the ride banner (bottom 64px + its height), centred — the
   same place a car's instrument binnacle sits: low, central, and
   out of the road's way. */
.gauge {
  position: absolute;
  bottom: 150px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--dc-z-toast);
}

/* ===== the ride banner =====
   Bottom centre, above the event feed: who is tracked, which look is
   active, and the three actions. Glass like the panels. */
.ride-banner {
  position: absolute;
  bottom: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--dc-z-toast);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-radius: var(--dc-radius);
  background: var(--dc-chrome);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 32%, transparent);
  font-size: var(--dc-label-size);
  pointer-events: auto;
}
.ride-id {
  font-weight: 600;
  color: var(--dc-accent);
  font-variant-numeric: tabular-nums;
}
.ride-mode {
  color: var(--dc-text);
}
.ride-btn {
  padding: 3px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 40%, transparent);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  color: var(--dc-text);
  cursor: pointer;
  font-size: var(--dc-label-size);
}
.ride-btn:hover {
  background: color-mix(in srgb, var(--dc-accent) 24%, transparent);
}
.ride-exit {
  border-color: color-mix(in srgb, var(--dc-alert) 45%, transparent);
  color: color-mix(in srgb, var(--dc-alert) 80%, var(--dc-text));
}
.ride-hint {
  color: var(--dc-text-faint);
}
</style>

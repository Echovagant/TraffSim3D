<template>
  <main class="importer">
    <router-link to="/" class="back-link">← 返回首页</router-link>

    <header class="header">
      <span class="badge">OSM</span>
      <h1>MapLab</h1>
      <p class="sub">OSM 地图导入与路网生成</p>
    </header>

    <section class="card">
      <h2>① 在 Overpass Turbo 导出 .osm</h2>
      <p class="muted">
        打开
        <a href="https://overpass-turbo.eu" target="_blank" rel="noopener">overpass-turbo.eu</a>,
        粘贴下面任一查询(已限定 <code>highway</code> + 排除 <code>area=yes</code>), 点右上角
        <strong>Export → Raw OSM data</strong>,保存为 <code>.osm</code>。
      </p>
      <div class="overpass-tabs">
        <button
          v-for="(q, idx) in overpassQueries"
          :key="q.name"
          :class="['tab', overpassTab === idx ? 'tab-active' : '']"
          :data-testid="`overpass-tab-${idx}`"
          @click="overpassTab = idx"
        >
          {{ q.name }}
        </button>
      </div>
      <pre class="overpass-code" data-testid="overpass-code">{{
        overpassQueries[overpassTab]?.query
      }}</pre>
      <div class="overpass-actions">
        <button class="ghost" data-testid="overpass-copy-button" @click="onCopyOverpass">
          {{ overpassCopied ? '✓ 已复制' : '复制查询' }}
        </button>
        <button class="ghost" data-testid="overpass-open-button" @click="onOpenOverpass">
          在 Overpass Turbo 打开 ↗
        </button>
      </div>
      <p class="muted small">
        ⚠ 默认裁剪:不上传裁剪边界时,后端只保留距数据中心的 <code>0.5°</code>
        (~55 km) 内的节点 — 这是<b>内存安全上限</b>,不是按仿真区域裁剪。 要只加载一片区域,请在下方 ②
        填写裁剪边界(顺序 south, west, north, east)。
      </p>
    </section>

    <section class="card">
      <h2>② 上传 .osm 文件</h2>
      <p class="muted">
        选择刚才导出的 OpenStreetMap XML 文件 (.osm)，后端解析后直接载入到 SceneLab。 解析结果支持
        bridge/tunnel (level 标签)、oneway、traffic_signals 节点。
      </p>

      <div class="bbox-block" data-testid="osm-bbox-block">
        <label class="bbox-toggle">
          <input
            type="checkbox"
            data-testid="osm-bbox-toggle"
            :checked="bboxEnabled"
            @change="onBBoxToggle"
          />
          <span>启用裁剪 — 只加载仿真区域</span>
        </label>

        <div v-if="bboxEnabled" class="bbox-inputs">
          <label v-for="field in bboxFields" :key="field.key" class="bbox-field">
            <span class="bbox-field-label">{{ field.label }}</span>
            <input
              type="number"
              step="any"
              :data-testid="`osm-bbox-${field.key}`"
              :value="bboxInputs[field.key]"
              @input="onBBoxInput(field.key, $event)"
            />
          </label>
        </div>

        <p class="muted small" data-testid="osm-clip-status">{{ clipStatus }}</p>
        <p v-if="bboxError" class="bbox-error" data-testid="osm-bbox-error">{{ bboxError }}</p>
      </div>

      <div class="upload-row">
        <input
          ref="fileInput"
          type="file"
          accept=".osm,.osm.pbf,.xml,application/xml,application/octet-stream"
          data-testid="osm-file-input"
          @change="onFileSelected"
        />
        <button
          class="primary"
          :disabled="!file || uploading || bboxError !== null"
          data-testid="osm-upload-button"
          @click="onUpload"
        >
          {{ uploading ? '解析中…' : '上传并载入' }}
        </button>
      </div>

      <p v-if="lastResult" class="result" :class="lastResult.ok ? 'ok' : 'err'">
        {{ lastResult.message }}
      </p>

      <div v-if="lastResult?.stats" class="stats">
        <span>道路 {{ lastResult.stats.roads }}</span>
        <span>路口 {{ lastResult.stats.intersections }}</span>
        <span>红绿灯 {{ lastResult.stats.lights }}</span>
      </div>
      <p v-if="backendUrl" class="muted small">
        Backend: <code>{{ backendUrl }}</code>
        <span v-if="!backendUrl.startsWith('http')">(走 vite proxy → :{{ backendPort }})</span>
      </p>
    </section>

    <section class="card">
      <h2>示例 fixture</h2>
      <p class="muted">
        自带 <code>sample-4way.osm</code>（4 路口 + 1 高架桥段）位于
        <code>tests/e2e/fixtures/</code>。
      </p>
      <button class="ghost" data-testid="load-fixture-button" @click="loadFixture">
        载入示例 fixture
      </button>
    </section>

    <!--
      ODbL attribution footer (an acceptance criterion of the
      "OSM真实数据" addition).
      OSM data is © OpenStreetMap contributors, licensed under ODbL.
      Required for any UI displaying OSM-derived maps.
    -->
    <footer class="osm-attribution" data-testid="osm-attribution">
      路网数据 ©
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">
        OpenStreetMap 贡献者
      </a>
      · ODbL 协议 ·
      <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">
        许可详情
      </a>
    </footer>
  </main>
</template>

<script setup lang="ts">
/**
 * MapLab — OSM file importer.
 * Overpass query templates + backend port env var.
 *
 * The import flow:
 *   1. Copy an Overpass query from the templates below into
 *      https://overpass-turbo.eu, run it, click "Export → Raw OSM data",
 *      save the .osm file.
 *   2. Upload it here; the backend POSTs /api/v1/maps/parse-osm and
 *      returns a RoadNetwork-shaped dict. We feed it to
 *      worldStore.loadNetwork() before routing to the scene editor.
 *
 * Backend URL: vite proxy forwards `/api/*` → `localhost:VITE_BACKEND_PORT`
 * (default 8000). The frontend uses the same env var so direct fetches
 * (this upload) target the same port the proxy uses.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { showFlashMessage } from '@interfaces/composables/useFlashMessage'
import {
  OSM_UNSPECIFIED_CLIP_NOTE,
  describeOsmClip,
  normalizeOsmPayload,
  spawnImportedVehicles,
  validateOsmBBox,
  withOsmBBoxQuery,
  type OsmBBox,
} from '@infrastructure/api'
import { createRoadNetworkFrom } from '@domain/entities/RoadNetwork'
import { junctionRadius } from '@domain/services/junctionRadius'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'

const router = useRouter()
const world = useWorldStore()

/**
 * How many vehicles an imported OSM city starts with. The demo scenes
 * ship 6–8 cars; an imported district gets the same order of magnitude so
 * the scene reads as traffic rather than as an empty road network.
 */
const IMPORT_VEHICLE_COUNT = 8

const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const uploading = ref(false)

// --- bbox clipping (只加载仿真区域) --------------------------------
// Off by default so an untouched upload produces the exact same request URL
// as before the bbox wiring (e2e stubs match the bare parse-pbf URL).
// Inputs are kept as strings so a blank field reads as "unspecified" rather
// than silently coercing to 0.
type BBoxKey = keyof OsmBBox

const bboxFields: ReadonlyArray<{ key: BBoxKey; label: string }> = [
  { key: 'south', label: 'south 南' },
  { key: 'west', label: 'west 西' },
  { key: 'north', label: 'north 北' },
  { key: 'east', label: 'east 东' },
]

const bboxEnabled = ref(false)
const bboxInputs = ref<Record<BBoxKey, string>>({
  south: '',
  west: '',
  north: '',
  east: '',
})

const onBBoxToggle = (e: Event): void => {
  bboxEnabled.value = (e.target as HTMLInputElement).checked
}

const onBBoxInput = (key: BBoxKey, e: Event): void => {
  bboxInputs.value[key] = (e.target as HTMLInputElement).value
}

/** The box the user has typed, or null when disabled or still incomplete. */
const bboxDraft = computed<OsmBBox | null>(() => {
  if (!bboxEnabled.value) return null
  const raw = bboxFields.map((field) => bboxInputs.value[field.key].trim())
  if (raw.some((value) => value === '')) return null
  const [south, west, north, east] = raw.map(Number)
  if ([south, west, north, east].some((value) => !Number.isFinite(value))) return null
  return { south, west, north, east }
})

/** Non-null only when the box is safe to send; mirrors the backend rules. */
const bboxError = computed<string | null>(() => {
  if (!bboxEnabled.value) return null
  const draft = bboxDraft.value
  if (draft === null) return '裁剪边界需要填写完整的 4 个值 (south / west / north / east)'
  return validateOsmBBox(draft)
})

/** What actually goes on the wire: null keeps the historical uncropped call. */
const activeBBox = computed<OsmBBox | null>(() =>
  bboxError.value === null ? bboxDraft.value : null,
)

// Always state the clip in effect — a silent "nothing was cropped" is exactly
// the misunderstanding this panel exists to prevent.
const clipStatus = computed<string>(() =>
  bboxEnabled.value && bboxDraft.value !== null
    ? describeOsmClip(bboxDraft.value)
    : OSM_UNSPECIFIED_CLIP_NOTE,
)

interface UploadResult {
  ok: boolean
  message: string
  stats?: { roads: number; intersections: number; lights: number }
}

const lastResult = ref<UploadResult | null>(null)

// VITE_BACKEND_URL overrides the default port for users who
// run uvicorn on a non-default port (the proxy in vite.config.js reads
// the same env var). When VITE_BACKEND_URL is unset we use a relative
// URL ("") so the request goes through the vite proxy at /api/v1 —
// this avoids CORS preflights in dev.
const BACKEND_PORT = (import.meta.env.VITE_BACKEND_PORT as string | undefined) ?? '8000'
const BACKEND_URL_EXPLICIT = import.meta.env.VITE_BACKEND_URL as string | undefined
const backendUrl = computed(() => BACKEND_URL_EXPLICIT ?? `http://localhost:${BACKEND_PORT}`)
const backendPort = BACKEND_PORT

// Overpass Turbo query templates — copy-paste ready, excluding the
// bbox limits the TraffSim3D parser can handle (MAX_BBOX_DEG = 0.5).
// Overpass bbox order: (south, west, north, east).
interface OverpassQuery {
  name: string
  query: string
}

const overpassQueries: OverpassQuery[] = [
  {
    name: '天安门 (北京)',
    query: `[out:xml][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]
     ["area"!="yes"]
     (39.85, 116.30, 39.95, 116.45);
  node["highway"="traffic_signals"](39.85, 116.30, 39.95, 116.45);
);
(._; >;);
out body;`,
  },
  {
    name: '福田中心 (深圳)',
    query: `[out:xml][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]
     ["area"!="yes"]
     (22.49, 113.95, 22.59, 114.15);
  node["highway"="traffic_signals"](22.49, 113.95, 22.59, 114.15);
);
(._; >;);
out body;`,
  },
  {
    name: '南山 (深圳)',
    query: `[out:xml][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]
     ["area"!="yes"]
     (22.45, 113.85, 22.55, 114.00);
  node["highway"="traffic_signals"](22.45, 113.85, 22.55, 114.00);
);
(._; >;);
out body;`,
  },
  {
    name: '陆家嘴 (上海)',
    query: `[out:xml][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]
     ["area"!="yes"]
     (31.20, 121.48, 31.30, 121.58);
  node["highway"="traffic_signals"](31.20, 121.48, 31.30, 121.58);
);
(._; >;);
out body;`,
  },
]
const overpassTab = ref(0)
const overpassCopied = ref(false)

const onCopyOverpass = async (): Promise<void> => {
  const q = overpassQueries[overpassTab.value]?.query ?? ''
  try {
    await navigator.clipboard.writeText(q)
    overpassCopied.value = true
    showFlashMessage('Overpass 查询已复制', 'info')
    setTimeout(() => {
      overpassCopied.value = false
    }, 2000)
  } catch {
    showFlashMessage('复制失败 — 请手动选中查询文本', 'error')
  }
}

const onOpenOverpass = (): void => {
  // Overpass Turbo URL: ?Q=<encoded query> opens the editor with the
  // query preloaded (no auto-run). User clicks "Run" themselves.
  const q = overpassQueries[overpassTab.value]?.query ?? ''
  const url = `https://overpass-turbo.eu/?Q=${encodeURIComponent(q)}`
  window.open(url, '_blank', 'noopener')
}

const onFileSelected = (e: Event): void => {
  const target = e.target as HTMLInputElement
  file.value = target.files?.[0] ?? null
  lastResult.value = null
}

const onUpload = async (): Promise<void> => {
  if (!file.value) return
  if (bboxError.value !== null) {
    lastResult.value = { ok: false, message: `裁剪边界无效: ${bboxError.value}` }
    showFlashMessage('裁剪边界无效,已阻止上传', 'error')
    return
  }
  uploading.value = true
  lastResult.value = null
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    // Route to PBF or XML endpoint based on file extension.
    const isPbf = file.value.name.toLowerCase().endsWith('.pbf')
    const endpoint = isPbf
      ? `${backendUrl.value}/api/v1/maps/parse-pbf`
      : `${backendUrl.value}/api/v1/maps/parse-osm`
    // activeBBox is null unless the user enabled clipping and it validates,
    // so the default request URL is unchanged.
    const r = await fetch(withOsmBBoxQuery(endpoint, activeBBox.value), {
      method: 'POST',
      body: fd,
    })
    if (!r.ok) {
      const detail = await r.text()
      lastResult.value = { ok: false, message: `后端错误 ${r.status}: ${detail.slice(0, 200)}` }
      showFlashMessage('OSM 上传失败', 'error')
      return
    }
    const payload = (await r.json()) as unknown
    // The backend answers with ARRAYS (roads / intersections / vehicles /
    // spawnPoints) while the frontend network is record-shaped and looked
    // up by id. Normalizing here is what makes `network.road('w-201')`
    // work — the previous "assign the payload as-is" path keyed the
    // records by array index ("0", "1", …) and every id lookup missed.
    const normalized = normalizeOsmPayload(payload)
    const network = normalized.network
    // An imported city with zero cars is not a simulation. The spawn
    // path is the same one the editor toolbar uses; when the payload
    // carries no spawn points the adapter derives them from the roads.
    const spawned = spawnImportedVehicles(network, IMPORT_VEHICLE_COUNT)
    // Pass the source filename so the toolbar can show
    // "📂 福田.osm" instead of the generic scene-kind dropdown.
    // The second arg sets `currentSceneKind = 'imported'` and
    // bumps the camera fit tick (via replaceNetwork).
    world.loadNetwork(network, file.value.name)
    lastResult.value = {
      ok: true,
      message: `✓ 解析成功 — 已载入 SceneLab`,
      stats: {
        roads: normalized.stats.roads,
        intersections: normalized.stats.intersections,
        lights: normalized.stats.lights,
      },
    }
    showFlashMessage(
      spawned > 0
        ? `OSM 导入完成: ${normalized.stats.roads} 条道路 · ${spawned} 辆车`
        : `OSM 导入完成: ${normalized.stats.roads} 条道路 · 没有可用出生点`,
      'info',
    )
    // Navigate to scene editor to visualize.
    setTimeout(() => router.push('/scene-editor'), 800)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    lastResult.value = { ok: false, message: `网络错误: ${msg}` }
    showFlashMessage(`OSM 上传失败: ${msg}`, 'error')
  } finally {
    uploading.value = false
  }
}

/**
 * Load a hard-coded sample fixture directly into the world.
 * Useful when the backend isn't running (e.g. e2e stubbed via page.route).
 *
 * The fixture is already expressed in the app's world frame (north = -Z),
 * so it bypasses the OSM payload adapter (which exists to convert the
 * backend's north-positive-Z projection). It is a layout preview and
 * deliberately ships no vehicles — the "generate vehicles" button uses
 * the same back-compat lane scan as any legacy scene.
 */
const loadFixture = (): void => {
  // Minimal 4-way network with 1 bridge. Matches the backend fixture
  // semantics; rendered directly so the user can preview without
  // backend.
  const roads: Record<string, Road> = {
    'w-1': {
      id: 'w-1',
      startNode: { x: 0, y: 0, z: -100 },
      endNode: { x: 0, y: 0, z: 100 },
      waypoints: [
        { x: 0, y: 0, z: -100 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 100 },
      ],
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    },
    'w-2': {
      id: 'w-2',
      startNode: { x: -100, y: 0, z: 0 },
      endNode: { x: 0, y: 0, z: 0 },
      waypoints: [
        { x: -100, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    },
    'w-3': {
      id: 'w-3',
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 100, y: 4, z: 0 },
      waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 20, y: 0.8, z: 0 },
        { x: 40, y: 1.6, z: 0 },
        { x: 60, y: 2.4, z: 0 },
        { x: 80, y: 3.2, z: 0 },
        { x: 100, y: 4, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 13.89,
      level: 1,
    },
    'w-4': {
      id: 'w-4',
      startNode: { x: 100, y: 4, z: 0 },
      endNode: { x: 200, y: 4, z: 0 },
      waypoints: [
        { x: 100, y: 4, z: 0 },
        { x: 200, y: 4, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 13.89,
      level: 1,
    },
  }
  const intersections: Record<string, Intersection> = {
    'i-1': {
      id: 'i-1',
      position: { x: 0, y: 0, z: 0 },
      trafficLights: [
        {
          id: 'tl-1',
          position: { x: -3, y: 0, z: 0 },
          phase: 'green',
          phaseRemaining: 30,
          cycleSeconds: 63,
          axis: 'ns',
        },
      ],
      connectedRoads: ['w-1', 'w-2', 'w-3'],
      // The example's roads are 4-lane (half-width 7 m), and this junction
      // has a traffic light, so the rule gives 7 + 4.5 = 11.5 m — the same
      // number the built-in scenes and the imported maps derive.
      intersectionRadius: junctionRadius(4, true),
    },
  }
  const network = createRoadNetworkFrom({
    roads,
    intersections,
    vehicles: {},
    spawnPoints: {},
  })
  world.loadNetwork(network)
  showFlashMessage('OSM 示例载入完成 (4 道路 + 1 高架桥)', 'info')
  setTimeout(() => router.push('/scene-editor'), 600)
}
</script>

<style scoped>
.importer {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.back-link {
  color: #93c5fd;
  text-decoration: none;
  font-size: 13px;
}
.back-link:hover {
  text-decoration: underline;
}
.header {
  max-width: 880px;
  margin: 0 auto 20px;
}
.header h1 {
  margin: 8px 0 4px;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.sub {
  margin: 0;
  color: #94a3b8;
  font-size: 14px;
}
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
  font-weight: 600;
}
.card {
  max-width: 880px;
  margin: 0 auto 20px;
  padding: 24px 28px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
}
.card h2 {
  margin: 0 0 8px;
  font-size: 15px;
  color: #cbd5e1;
}
.card p {
  color: #cbd5e1;
  font-size: 14px;
  line-height: 1.7;
  margin: 0 0 12px;
}
.muted {
  color: #94a3b8 !important;
  font-size: 13px !important;
}
.muted.small {
  font-size: 11px !important;
}
.upload-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
}
input[type='file'] {
  flex: 1;
  min-width: 220px;
  font-size: 13px;
  color: #cbd5e1;
}
button.primary {
  background: #2563eb;
  color: white;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button.primary:hover:not(:disabled) {
  background: #1d4ed8;
}
button.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
button.ghost:hover {
  background: rgba(148, 163, 184, 0.08);
}
.result {
  padding: 8px 12px;
  border-radius: 6px;
  margin: 8px 0;
  font-size: 13px;
}
.result.ok {
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
}
.result.err {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
}
.stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #94a3b8;
  margin-top: 8px;
}

/* bbox clipping controls. */
.bbox-block {
  margin: 12px 0;
  padding: 12px 14px;
  background: rgba(30, 41, 59, 0.4);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
}
.bbox-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #cbd5e1;
  cursor: pointer;
}
.bbox-inputs {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 10px 0 6px;
}
.bbox-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbox-field-label {
  font-size: 11px;
  color: #94a3b8;
}
.bbox-field input {
  width: 120px;
  padding: 5px 8px;
  font-size: 12px;
  color: #e2e8f0;
  background: #0f172a;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 6px;
}
.bbox-error {
  margin: 4px 0 0;
  font-size: 12px;
  color: #fca5a5;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(2, 6, 23, 0.7);
  padding: 1px 6px;
  border-radius: 4px;
  color: #93c5fd;
}

/* Overpass query templates. */
.overpass-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.overpass-tabs .tab {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.2);
  color: #cbd5e1;
  padding: 5px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
}
.overpass-tabs .tab:hover {
  background: rgba(30, 41, 59, 0.9);
}
.overpass-tabs .tab-active {
  background: rgba(34, 197, 94, 0.2);
  border-color: rgba(34, 197, 94, 0.5);
  color: #86efac;
}
.overpass-code {
  background: #0f172a;
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 6px;
  padding: 12px 14px;
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre;
  margin: 8px 0;
}
.overpass-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.overpass-actions button {
  font-size: 12px;
}

/* ODbL attribution footer — required when displaying OSM-derived maps. */
.osm-attribution {
  max-width: 880px;
  margin: 24px auto 0;
  padding: 12px 20px;
  font-size: 12px;
  color: #94a3b8;
  text-align: center;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
}
.osm-attribution a {
  color: #93c5fd;
  text-decoration: underline;
  text-decoration-color: rgba(147, 197, 253, 0.4);
}
.osm-attribution a:hover {
  color: #bfdbfe;
}
</style>

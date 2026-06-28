<template>
  <main class="importer">
    <router-link to="/" class="back-link">← 返回首页</router-link>

    <header class="header">
      <span class="badge">M3 · 041</span>
      <h1>MapLab</h1>
      <p class="sub">OSM 地图导入与路网生成</p>
    </header>

    <section class="card">
      <h2>① 在 Overpass Turbo 导出 .osm</h2>
      <p class="muted">
        打开 <a href="https://overpass-turbo.eu" target="_blank" rel="noopener">overpass-turbo.eu</a>,
        粘贴下面任一查询(已限定 <code>highway</code> + 排除 <code>area=yes</code>),
        点右上角 <strong>Export → Raw OSM data</strong>,保存为 <code>.osm</code>。
      </p>
      <div class="overpass-tabs">
        <button
          v-for="(q, idx) in overpassQueries"
          :key="q.name"
          :class="['tab', overpassTab === idx ? 'tab-active' : '']"
          :data-testid="`overpass-tab-${idx}`"
          @click="overpassTab = idx"
        >{{ q.name }}</button>
      </div>
      <pre class="overpass-code" data-testid="overpass-code">{{ overpassQueries[overpassTab]?.query }}</pre>
      <div class="overpass-actions">
        <button
          class="ghost"
          data-testid="overpass-copy-button"
          @click="onCopyOverpass"
        >{{ overpassCopied ? '✓ 已复制' : '复制查询' }}</button>
        <button
          class="ghost"
          data-testid="overpass-open-button"
          @click="onOpenOverpass"
        >在 Overpass Turbo 打开 ↗</button>
      </div>
      <p class="muted small">
        ⚠ bbox 限制:TraffSim3D parser 只接受 <code>±0.5°</code> (~55 km) 以内的节点,大区会过滤远点。
        整个深圳市请分片区导(福田/南山/罗湖)。
      </p>
    </section>

    <section class="card">
      <h2>② 上传 .osm 文件</h2>
      <p class="muted">
        选择刚才导出的 OpenStreetMap XML 文件 (.osm)，后端解析后直接载入到 SceneLab。
        解析结果支持 bridge/tunnel (level 标签)、oneway、traffic_signals 节点。
      </p>

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
          :disabled="!file || uploading"
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
        Plan 041 自带 <code>sample-4way.osm</code>（4 路口 + 1 高架桥段）位于
        <code>tests/e2e/fixtures/</code>。
      </p>
      <button class="ghost" data-testid="load-fixture-button" @click="loadFixture">载入示例 fixture</button>
    </section>

    <!--
      ODbL attribution footer (Plan 041 acceptance criteria + 045
      follow-up "OSM真实数据" addition).
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
 * Plan 041: MapLab — OSM file importer.
 * Plan 052 follow-up: Overpass query templates + backend port env var.
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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { showFlashMessage } from '@interfaces/composables/useFlashMessage';

const router = useRouter();
const world = useWorldStore();

const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const uploading = ref(false);

interface UploadResult {
  ok: boolean;
  message: string;
  stats?: { roads: number; intersections: number; lights: number };
}

const lastResult = ref<UploadResult | null>(null);

// Plan 052: VITE_BACKEND_URL overrides the default port for users who
// run uvicorn on a non-default port (the proxy in vite.config.js reads
// the same env var). When VITE_BACKEND_URL is unset we use a relative
// URL ("") so the request goes through the vite proxy at /api/v1 —
// this avoids CORS preflights in dev.
const BACKEND_PORT = (import.meta.env.VITE_BACKEND_PORT as string | undefined) ?? '8000';
const BACKEND_URL_EXPLICIT = import.meta.env.VITE_BACKEND_URL as string | undefined;
const backendUrl = computed(() =>
  BACKEND_URL_EXPLICIT ?? `http://localhost:${BACKEND_PORT}`,
);
const backendPort = BACKEND_PORT;

// Overpass Turbo query templates — copy-paste ready, excluding the
// bbox limits the TraffSim3D parser can handle (MAX_BBOX_DEG = 0.5).
// Overpass bbox order: (south, west, north, east).
interface OverpassQuery { name: string; query: string; }

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
];
const overpassTab = ref(0);
const overpassCopied = ref(false);

const onCopyOverpass = async (): Promise<void> => {
  const q = overpassQueries[overpassTab.value]?.query ?? '';
  try {
    await navigator.clipboard.writeText(q);
    overpassCopied.value = true;
    showFlashMessage('Overpass 查询已复制', 'info');
    setTimeout(() => { overpassCopied.value = false; }, 2000);
  } catch {
    showFlashMessage('复制失败 — 请手动选中查询文本', 'error');
  }
};

const onOpenOverpass = (): void => {
  // Overpass Turbo URL: ?Q=<encoded query> opens the editor with the
  // query preloaded (no auto-run). User clicks "Run" themselves.
  const q = overpassQueries[overpassTab.value]?.query ?? '';
  const url = `https://overpass-turbo.eu/?Q=${encodeURIComponent(q)}`;
  window.open(url, '_blank', 'noopener');
};

const onFileSelected = (e: Event): void => {
  const target = e.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
  lastResult.value = null;
};

const onUpload = async (): Promise<void> => {
  if (!file.value) return;
  uploading.value = true;
  lastResult.value = null;
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    // Route to PBF or XML endpoint based on file extension.
    const isPbf = file.value.name.toLowerCase().endsWith('.pbf');
    const endpoint = isPbf
      ? `${backendUrl.value}/api/v1/maps/parse-pbf`
      : `${backendUrl.value}/api/v1/maps/parse-osm`;
    const r = await fetch(endpoint, {
      method: 'POST',
      body: fd,
    });
    if (!r.ok) {
      const detail = await r.text();
      lastResult.value = { ok: false, message: `后端错误 ${r.status}: ${detail.slice(0, 200)}` };
      showFlashMessage('OSM 上传失败', 'error');
      return;
    }
    const network = (await r.json()) as {
      roads: unknown[];
      intersections: { trafficLights: unknown[] }[];
    };
    // Plan 054: pass the source filename so the toolbar can show
    // "📂 福田.osm" instead of the generic scene-kind dropdown.
    // The second arg sets `currentSceneKind = 'imported'` and
    // bumps the camera fit tick (via replaceNetwork).
    world.loadNetwork(network as never, file.value.name);
    lastResult.value = {
      ok: true,
      message: `✓ 解析成功 — 已载入 SceneLab`,
      stats: {
        roads: network.roads.length,
        intersections: network.intersections.length,
        lights: network.intersections.reduce(
          (sum, i) => sum + i.trafficLights.length, 0,
        ),
      },
    };
    showFlashMessage(`OSM 导入完成: ${network.roads.length} 条道路`, 'info');
    // Navigate to scene editor to visualize.
    setTimeout(() => router.push('/scene-editor'), 800);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastResult.value = { ok: false, message: `网络错误: ${msg}` };
    showFlashMessage(`OSM 上传失败: ${msg}`, 'error');
  } finally {
    uploading.value = false;
  }
};

/**
 * Load a hard-coded sample fixture directly into the world.
 * Useful when the backend isn't running (e.g. e2e stubbed via page.route).
 */
const loadFixture = (): void => {
  // Minimal 4-way network with 1 bridge. Matches the backend fixture
  // semantics; rendered directly so the user can preview without
  // backend.
  const network = {
    roads: [
      { id: 'w-1', startNode: { x: 0, y: 0, z: -100 }, endNode: { x: 0, y: 0, z: 100 },
        waypoints: [{ x: 0, y: 0, z: -100 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 100 }],
        laneCount: 4, speedLimit: 16.67, level: 0 },
      { id: 'w-2', startNode: { x: -100, y: 0, z: 0 }, endNode: { x: 0, y: 0, z: 0 },
        waypoints: [{ x: -100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
        laneCount: 4, speedLimit: 16.67, level: 0 },
      { id: 'w-3', startNode: { x: 0, y: 0, z: 0 }, endNode: { x: 100, y: 4, z: 0 },
        waypoints: [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0.8, z: 0 }, { x: 40, y: 1.6, z: 0 },
                    { x: 60, y: 2.4, z: 0 }, { x: 80, y: 3.2, z: 0 }, { x: 100, y: 4, z: 0 }],
        laneCount: 4, speedLimit: 13.89, level: 1 },
      { id: 'w-4', startNode: { x: 100, y: 4, z: 0 }, endNode: { x: 200, y: 4, z: 0 },
        waypoints: [{ x: 100, y: 4, z: 0 }, { x: 200, y: 4, z: 0 }],
        laneCount: 4, speedLimit: 13.89, level: 1 },
    ],
    intersections: [
      { id: 'i-1', position: { x: 0, y: 0, z: 0 },
        trafficLights: [
          { id: 'tl-1', position: { x: -3, y: 0, z: 0 }, phase: 'green',
            phaseRemaining: 30, cycleSeconds: 63, axis: 'ns' },
        ],
        connectedRoads: ['w-1', 'w-2', 'w-3'], intersectionRadius: 8 },
    ],
    vehicles: [],
    spawnPoints: [],
  };
  world.loadNetwork(network as never);
  showFlashMessage('OSM 示例载入完成 (4 道路 + 1 高架桥)', 'info');
  setTimeout(() => router.push('/scene-editor'), 600);
};
</script>

<style scoped>
.importer {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.back-link { color: #93c5fd; text-decoration: none; font-size: 13px; }
.back-link:hover { text-decoration: underline; }
.header { max-width: 880px; margin: 0 auto 20px; }
.header h1 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.sub { margin: 0; color: #94a3b8; font-size: 14px; }
.badge { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 999px;
         background: rgba(34, 197, 94, 0.18); color: #86efac; font-weight: 600; }
.card { max-width: 880px; margin: 0 auto 20px; padding: 24px 28px;
        background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(148, 163, 184, 0.15);
        border-radius: 12px; }
.card h2 { margin: 0 0 8px; font-size: 15px; color: #cbd5e1; }
.card p { color: #cbd5e1; font-size: 14px; line-height: 1.7; margin: 0 0 12px; }
.muted { color: #94a3b8 !important; font-size: 13px !important; }
.muted.small { font-size: 11px !important; }
.upload-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
input[type="file"] { flex: 1; min-width: 220px; font-size: 13px; color: #cbd5e1; }
button.primary { background: #2563eb; color: white; padding: 8px 16px; border: none;
                 border-radius: 6px; cursor: pointer; font-size: 13px; }
button.primary:hover:not(:disabled) { background: #1d4ed8; }
button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
button.ghost { background: transparent; border: 1px solid rgba(148, 163, 184, 0.3);
               color: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
button.ghost:hover { background: rgba(148, 163, 184, 0.08); }
.result { padding: 8px 12px; border-radius: 6px; margin: 8px 0; font-size: 13px; }
.result.ok { background: rgba(34, 197, 94, 0.12); color: #86efac; }
.result.err { background: rgba(239, 68, 68, 0.12); color: #fca5a5; }
.stats { display: flex; gap: 16px; font-size: 12px; color: #94a3b8; margin-top: 8px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
       background: rgba(2, 6, 23, 0.7); padding: 1px 6px; border-radius: 4px; color: #93c5fd; }

/* Plan 052: Overpass query templates. */
.overpass-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.overpass-tabs .tab {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.2);
  color: #cbd5e1;
  padding: 5px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
}
.overpass-tabs .tab:hover { background: rgba(30, 41, 59, 0.9); }
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
.overpass-actions { display: flex; gap: 8px; margin-top: 4px; }
.overpass-actions button { font-size: 12px; }

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
.osm-attribution a:hover { color: #bfdbfe; }
</style>
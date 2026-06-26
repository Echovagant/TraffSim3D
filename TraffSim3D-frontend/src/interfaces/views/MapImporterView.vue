<template>
  <main class="importer">
    <router-link to="/" class="back-link">← 返回首页</router-link>

    <header class="header">
      <span class="badge">M3 · 041</span>
      <h1>MapLab</h1>
      <p class="sub">OSM 地图导入与路网生成</p>
    </header>

    <section class="card">
      <h2>上传 .osm 文件</h2>
      <p class="muted">
        选择 OpenStreetMap XML 文件 (.osm)，后端解析后直接载入到 SceneLab。
        解析结果支持 bridge/tunnel (level 标签)、oneway、traffic_signals 节点。
      </p>

      <div class="upload-row">
        <input
          ref="fileInput"
          type="file"
          accept=".osm,application/xml,text/xml"
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
    </section>

    <section class="card">
      <h2>示例 fixture</h2>
      <p class="muted">
        Plan 041 自带 <code>sample-4way.osm</code>（4 路口 + 1 高架桥段）位于
        <code>tests/e2e/fixtures/</code>。
      </p>
      <button class="ghost" @click="loadFixture">载入示例 fixture</button>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * Plan 041: MapLab — OSM file importer.
 *
 * Uploads an .osm XML file to POST /api/v1/maps/parse-osm,
 * receives a RoadNetwork-shaped dict, and feeds it to
 * worldStore.loadNetwork() before routing to the scene editor.
 *
 * Backend URL comes from VITE_BACKEND_URL (default http://localhost:8000).
 * The backend is optional — Playwright e2e can stub the response with
 * page.route() if running frontend-only.
 */
import { ref } from 'vue';
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

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';

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
    const r = await fetch(`${BACKEND_URL}/api/v1/maps/parse-osm`, {
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
    world.loadNetwork(network as never);
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
</style>
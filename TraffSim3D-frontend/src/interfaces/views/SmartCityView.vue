<template>
  <main class="smart-city">
    <!-- Plan 055: Cesium viewer container (basemap). Sits at z=0;
         Three.js canvas overlays at z=1. Both fill the viewport. -->
    <div ref="cesiumContainer" class="cesium-container" data-testid="cesium-container" />

    <!-- Three.js overlay: transparent background, vehicles + lights
         + LiDAR are drawn here. z=1 so it stacks above the basemap.
         Pointer events pass through to Cesium for camera control. -->
    <canvas
      ref="threeCanvas"
      data-testid="world-canvas"
      class="three-canvas"
    />

    <!-- Floating top dock (Plan 055: minimal toolbar — full UI
         redesign lives in Plan 057). -->
    <header class="dock-top">
      <router-link to="/" class="link-home" title="返回首页">← 首页</router-link>
      <button
        class="sim"
        :class="{ paused: !world.isRunning }"
        :title="world.isRunning ? '暂停 (Space)' : '播放 (Space)'"
        data-testid="pause-button"
        @click="world.togglePause()"
      >{{ world.isRunning ? '⏸ 暂停' : '▶ 播放' }}</button>
      <span class="sep" />
      <button
        title="重新框选整个场景 (F)"
        data-testid="fit-scene-button"
        @click="world.requestFit()"
      >🎯 适配场景</button>
      <label class="view-mode" title="Cesium 视图模式">
        <span class="view-mode-label">视图</span>
        <select
          v-model="viewMode"
          data-testid="view-mode-select"
        >
          <option value="bird">鸟瞰 (1500m)</option>
          <option value="street">平视 (1.7m)</option>
          <option value="free">自由</option>
        </select>
      </label>
      <span class="sep" />
      <span class="status" v-if="osmStats">
        <span data-testid="osm-road-count">{{ osmStats.roadCount }} 道路</span>
        <span data-testid="osm-building-count">{{ osmStats.buildingCount }} 建筑</span>
      </span>
    </header>

    <!-- Floating status panel (top-right) — simulation dashboard -->
    <aside class="status-panel" data-testid="status-panel">
      <div><span>帧率</span><strong>{{ world.fps }}</strong></div>
      <div><span>车辆数</span><strong data-testid="vehicle-count">{{ vehicleCount }}</strong></div>
      <div><span>灯数</span><strong>{{ lightCount }}</strong></div>
      <div><span>平均速度</span><strong>{{ avgSpeed.toFixed(1) }} m/s</strong></div>
      <div><span>信号控制</span><strong>{{ controllerLabel }}</strong></div>
      <div><span>仿真 tick</span><strong>{{ world.tickCount }}</strong></div>
      <div><span>仿真</span><strong>{{ world.isRunning ? '运行' : '暂停' }}</strong></div>
      <div v-if="world.replayActive" class="replay-indicator">
        <span>RL 回放</span><strong>活跃 (step {{ world.replayStep }})</strong>
      </div>
    </aside>

    <!-- Floating error / loading toast (replaces the editor's
         flash-message area while we wait for Cesium + OSM to load). -->
    <div v-if="status" class="status-toast" :class="status.kind" data-testid="status-toast">
      {{ status.text }}
    </div>
  </main>
</template>

<script setup lang="ts">
/**
 * Plan 055: Smart City view — Cesium basemap + Three.js overlay.
 *
 * Layering (z=0 below, z=1 above):
 *   z=0  Cesium Viewer  — Gaode imagery + 3D buildings + polylines
 *   z=1  Three.js canvas — vehicles + traffic lights + LiDAR
 *
 * The existing M4 simulation (Rapier physics, PPO replay, signal
 * controllers) is unchanged — it operates on the same Pinia
 * worldStore, just rendered through a transparent Three.js layer
 * on top of the Cesium basemap.
 *
 * Camera:
 *   - `bird`: Cesium camera at 1500m straight down (default).
 *   - `street`: Cesium camera at 1.7m, heading 0 (human eye level).
 *   - `free`: Three.js OrbitControls; Cesium camera paused at the
 *     last known position (follows Three.js via cameraSync).
 *
 * The full bidirectional Three.js ↔ Cesium camera sync (mouse
 * drag on the basemap drives Three.js camera) is Plan 056 — for
 * 055 the MVP is one-way: Cesium drives the position, Three.js
 * mirrors it. The render loop calls `syncThreeCameraToCesium`
 * every frame.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as Cesium from 'cesium';
import { useWorldSimulation } from '@interfaces/composables/useWorldSimulation';
import { useEditor } from '@interfaces/composables/useEditor';
import { useCameraControls } from '@interfaces/composables/useCameraControls';
import type { ThreeJSRenderer } from '@infrastructure/rendering';
import { useWorldStore } from '@interfaces/stores/worldStore';
import {
  createCesiumViewer,
  DEFAULT_TANGENT_ORIGIN,
  DEFAULT_IMAGERY,
} from '@infrastructure/cesium/viewer';
import {
  loadOSMScene,
  DEFAULT_BBOX,
  type LoadedOSMScene,
} from '@infrastructure/cesium/loadOSMScene';
import { syncThreeCameraToCesium } from '@infrastructure/cesium/cameraSync';

const cesiumContainer = ref<HTMLDivElement | null>(null);
const threeCanvas = ref<HTMLCanvasElement | null>(null);
const viewMode = ref<'bird' | 'street' | 'free'>('bird');
const status = ref<{ kind: 'info' | 'error'; text: string } | null>(null);
const osmStats = ref<{ roadCount: number; buildingCount: number } | null>(null);

const world = useWorldStore();

let cesiumViewer: Cesium.Viewer | null = null;
let syncRafId: number | null = null;

// Reuse the simulation tick so the simulation keeps running.
const { isReady, getRenderer } = useWorldSimulation(threeCanvas);
const rendererRef = ref<ThreeJSRenderer | null>(null);
watch(isReady, (ready) => {
  if (ready) {
    const r = getRenderer();
    if (!r) return;
    r.setRenderMode('smart-city');
    rendererRef.value = r;
  }
});
useCameraControls(threeCanvas, rendererRef as unknown as Parameters<typeof useCameraControls>[1]);
const { handleMouseDown, handleMouseMove, handleMouseUp } = useEditor(rendererRef as unknown as Parameters<typeof useEditor>[0]);

const vehicleCount = computed(() => Object.keys(world.network.vehicles).length);
const lightCount = computed(
  () => Object.values(world.network.intersections)
    .reduce((s, i) => s + i.trafficLights.length, 0),
);

const avgSpeed = computed(() => {
  const vehicles = Object.values(world.network.vehicles);
  if (vehicles.length === 0) return 0;
  const totalSpeed = vehicles.reduce((sum, v) => sum + v.speed, 0);
  return totalSpeed / vehicles.length;
});

const controllerLabel = computed(() => {
  const map: Record<string, string> = {
    'fixed-cycle': '固定',
    'actuated': '感应',
    'coordinated': '协调',
    'rl': 'RL (stub)',
  };
  return map[world.controllerKind] || world.controllerKind;
});

onMounted(async () => {
  if (!cesiumContainer.value) {
    status.value = { kind: 'error', text: 'Cesium 容器未挂载' };
    return;
  }
  // 1) Construct Cesium viewer (sync — the SDK init is fast).
  try {
    cesiumViewer = createCesiumViewer(cesiumContainer.value, {
      center: DEFAULT_TANGENT_ORIGIN,
      zoomLevel: 1500,
      imagery: DEFAULT_IMAGERY,
    });
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `Cesium 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
    };
    return;
  }

  // 2) Async load OSM buildings + roads.
  status.value = { kind: 'info', text: '正在从 Overpass 加载 OSM 数据...' };
  try {
    const loaded: LoadedOSMScene = await loadOSMScene(cesiumViewer, DEFAULT_BBOX);
    osmStats.value = {
      roadCount: loaded.roadCount,
      buildingCount: loaded.buildingCount,
    };
    status.value = {
      kind: 'info',
      text: `✓ 已加载 ${loaded.roadCount} 条道路 + ${loaded.buildingCount} 栋建筑`,
    };
    // Fade the toast after 3s.
    setTimeout(() => { status.value = null; }, 3000);
  } catch (e) {
    status.value = {
      kind: 'error',
      text: `OSM 加载失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 3) Start camera sync loop — Cesium → Three.js every frame.
  startCameraSync();
});

// View mode toggle: Cesium flyTo for bird/street; orbit controls
// for free. We watch viewMode and react.
watch(viewMode, (mode) => {
  if (!cesiumViewer) return;
  if (mode === 'bird') {
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        DEFAULT_TANGENT_ORIGIN.lng,
        DEFAULT_TANGENT_ORIGIN.lat,
        1500,
      ),
      duration: 2,
    });
  } else if (mode === 'street') {
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        DEFAULT_TANGENT_ORIGIN.lng,
        DEFAULT_TANGENT_ORIGIN.lat,
        1.7,
      ),
      orientation: { heading: 0, pitch: 0, roll: 0 },
      duration: 2,
    });
  }
  // 'free' mode is handled by OrbitControls directly (no Cesium change).
});

/** Per-frame: read Cesium camera, write to Three.js camera. */
const startCameraSync = (): void => {
  const tick = (): void => {
    if (!cesiumViewer || !rendererRef.value) {
      syncRafId = requestAnimationFrame(tick);
      return;
    }
    syncThreeCameraToCesium({
      cesiumViewer,
      threeCamera: rendererRef.value.getCamera(),
      tangent: DEFAULT_TANGENT_ORIGIN,
    });
    syncRafId = requestAnimationFrame(tick);
  };
  syncRafId = requestAnimationFrame(tick);
};

onBeforeUnmount(() => {
  if (syncRafId !== null) cancelAnimationFrame(syncRafId);
  cesiumViewer?.destroy();
  cesiumViewer = null;
});
</script>

<style scoped>
.smart-city {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #0b1220;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Cesium container fills the viewport (basemap). */
.cesium-container {
  position: absolute;
  inset: 0;
  z-index: 0;
}

/* Three.js canvas overlays the basemap. Transparent BG. */
.three-canvas {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  /* MVP (Plan 056 will refine): pointer events pass through to
     Cesium so the user can pan / zoom the basemap. Vehicle
     interaction (drag, inspector) routes through world-space
     raycasts triggered from the editor's own handlers. */
  pointer-events: none;
}

/* Floating top dock toolbar. */
.dock-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(15, 23, 42, 0.78);
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.dock-top button,
.dock-top select,
.dock-top a {
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(148, 163, 184, 0.25);
  color: #e2e8f0;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 13px;
  text-decoration: none;
}
.dock-top button:hover {
  background: rgba(30, 41, 59, 0.95);
}
.dock-top button.sim { font-weight: 600; }
.dock-top button.sim.paused { background: rgba(239, 68, 68, 0.25); }
.dock-top .sep {
  width: 1px;
  height: 22px;
  background: rgba(148, 163, 184, 0.2);
}
.dock-top .view-mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dock-top .view-mode-label {
  font-size: 12px;
  color: #94a3b8;
}
.dock-top .status {
  font-size: 12px;
  color: #94a3b8;
  display: inline-flex;
  gap: 12px;
}

/* Right-top status panel — same metrics as the editor's debug panel. */
.status-panel {
  position: absolute;
  top: 64px;
  right: 16px;
  z-index: 10;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  min-width: 140px;
}
.status-panel > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.status-panel span { color: #94a3b8; }
.status-panel strong { color: #f1f5f9; font-weight: 600; }

/* Bottom-center toast — replaces flash-message during initial load. */
.status-toast {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 10px 18px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.status-toast.info {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
  border: 1px solid rgba(34, 197, 94, 0.4);
}
.status-toast.error {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.replay-indicator {
  border-top: 1px solid rgba(148, 163, 184, 0.2);
  padding-top: 6px;
  margin-top: 4px;
}
.replay-indicator strong {
  color: #a78bfa;
}
</style>
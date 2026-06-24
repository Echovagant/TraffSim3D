<template>
  <main class="sim-lab">
    <header class="lab-header">
      <router-link to="/" class="back-link">← 返回首页</router-link>
      <div class="title-row">
        <span class="badge badge-active">M2 · Active</span>
        <h1>SimulationLab</h1>
        <p class="sub">M2 控制面板 — 物理 + 信号 + 传感器 (companion to SceneLab)</p>
      </div>
    </header>

    <div class="lab-grid">
      <!-- 1. 场景统计 -->
      <section class="card">
        <h2>1. 场景统计</h2>
        <div class="stat-grid">
          <div class="stat"><span>车辆</span><b>{{ vehicleCount }}</b></div>
          <div class="stat"><span>信号灯</span><b>{{ lightCount }}</b></div>
          <div class="stat"><span>交叉口</span><b>{{ intersectionCount }}</b></div>
          <div class="stat"><span>道路</span><b>{{ roadCount }}</b></div>
          <div class="stat"><span>NS 轴队列</span><b>{{ nsQueue }}</b></div>
          <div class="stat"><span>EW 轴队列</span><b>{{ ewQueue }}</b></div>
          <div class="stat">
            <span>变道中</span>
            <b :class="{ changing: changingCount > 0 }">{{ changingCount }}</b>
          </div>
          <div class="stat"><span>仿真 tick</span><b>{{ world.tickCount }}</b></div>
        </div>
      </section>

      <!-- 2. 信号控制面板 -->
      <section class="card">
        <h2>2. 信号控制</h2>
        <div class="ctrl-row">
          <label class="ctrl-kind">
            <span>控制器</span>
            <select :value="world.controllerKind" @change="onControllerKindChange">
              <option value="fixed-cycle">固定</option>
              <option value="actuated">感应</option>
              <option value="coordinated">协调 (绿波带)</option>
              <option value="rl">RL</option>
            </select>
          </label>
          <button
            class="btn"
            :disabled="world.controllerKind !== 'coordinated'"
            @click="showCoordinated = true"
          >⚙ 配置偏移</button>
          <button class="btn danger" @click="world.forceAllRed()">🚨 全红 3s</button>
        </div>
        <table class="phase-table">
          <thead>
            <tr>
              <th>灯</th>
              <th>轴</th>
              <th>phase</th>
              <th>剩余 (s)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in lightRows" :key="row.id">
              <td><code>{{ row.id }}</code></td>
              <td>{{ row.axis.toUpperCase() }}</td>
              <td><span :class="`phase phase-${row.phase}`">{{ row.phase }}</span></td>
              <td>{{ row.phaseRemaining.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 3. 传感器面板 -->
      <section class="card">
        <h2>3. 传感器</h2>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="world.lidarEnabled"
            @change="onLidarToggle"
          />
          <span>LiDAR (16线)</span>
          <b :class="world.lidarEnabled ? 'ok' : ''">{{ world.lidarFrameCount }} 帧</b>
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="world.lidarCloudsEnabled"
            @change="onLidarCloudsToggle"
          />
          <span>LiDAR 点云渲染</span>
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="world.cameraEnabled"
            @change="onCameraToggle"
          />
          <span>📷 Camera (PiP)</span>
          <b :class="world.cameraEnabled ? 'ok' : ''">{{ world.cameraFrameCount }} 帧</b>
        </label>
        <div class="traj-row">
          <span>Trajectory</span>
          <b>{{ world.trajectoryExporter.rowCount }} / {{ world.trajectoryExporter.maxBufferRows }} 行</b>
          <button class="btn" @click="exportTrajectoryCsv">⬇ CSV</button>
        </div>
      </section>

      <!-- 4. 性能指标 -->
      <section class="card">
        <h2>4. 性能</h2>
        <div class="stat-grid">
          <div class="stat" :class="{ warn: world.fps < M1_MIN_FPS }">
            <span>FPS</span><b>{{ world.fps }}</b>
          </div>
          <div class="stat"><span>帧 ms (avg)</span><b>{{ frameAvg.toFixed(1) }}</b></div>
          <div class="stat"><span>帧 ms (min)</span><b>{{ frameMin }}</b></div>
          <div class="stat"><span>帧 ms (max)</span><b>{{ frameMax }}</b></div>
          <div class="stat"><span>仿真速率</span><b>{{ formatRate(world.tickRate) }}</b></div>
          <div class="stat" :class="{ paused: !world.isRunning }">
            <span>状态</span><b>{{ world.isRunning ? '运行中' : '已暂停' }}</b>
          </div>
        </div>
      </section>
    </div>

    <footer class="lab-footer">
      <router-link to="/scene-editor" class="btn primary">→ 去 SceneLab 编辑场景</router-link>
      <router-link to="/" class="btn ghost">← 返回首页</router-link>
    </footer>

    <CoordinatedConfigModal v-model:open="showCoordinated" />
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { getAxisQueueLength } from '@application/services/signalController';
import { M1_MIN_FPS } from '@shared/constants/simulation';
import { CoordinatedConfigModal } from '@interfaces/components/editor';

const world = useWorldStore();
const showCoordinated = ref(false);

// 1. 场景统计
const vehicleCount = computed(() => Object.keys(world.network.vehicles).length);
const intersectionCount = computed(() => Object.keys(world.network.intersections).length);
const roadCount = computed(() => Object.keys(world.network.roads).length);
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0));

const lightRows = computed(() => {
  void world.tickCount;
  return Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .sort((a, b) => a.id.localeCompare(b.id));
});

// Queue length uses a synthesised light (only `axis` and `roadId` are
// read inside getAxisQueueLength — see signalController.ts).
const stubLight = (axis: 'ns' | 'ew'): never => ({
  id: `__queue_${axis}`,
  axis,
  phase: 0 as never,
  phaseRemaining: 0,
  position: { x: 0, y: 0, z: 0 },
  cycleSeconds: 63,
} as never);

const nsQueue = computed(() => {
  void world.tickCount;
  return getAxisQueueLength(stubLight('ns'), world.network);
});
const ewQueue = computed(() => {
  void world.tickCount;
  return getAxisQueueLength(stubLight('ew'), world.network);
});
const changingCount = computed(() => {
  void world.tickCount;
  return Object.values(world.network.vehicles).filter(v => v.desiredLaneIndex !== null).length;
});

// 2. 信号控制
const onControllerKindChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value;
  // world.setControllerKind 接受 ControllerKind union; 4 个 option 值都合法.
  (world.setControllerKind as (k: string) => void)(v);
};

// 3. 传感器
const onLidarToggle = (e: Event): void => world.setLidarEnabled((e.target as HTMLInputElement).checked);
const onLidarCloudsToggle = (e: Event): void => world.setLidarCloudsEnabled((e.target as HTMLInputElement).checked);
const onCameraToggle = (e: Event): void => world.setCameraEnabled((e.target as HTMLInputElement).checked);
const exportTrajectoryCsv = (): void => {
  const blob = world.trajectoryExporter.exportAsBlob({
    kind: 'csv',
    includeCrashed: true,
    sampleInterval: 0.1,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trajectory-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// 4. 性能
const frameMin = computed(() => (world.frameMsMin === Infinity ? 0 : world.frameMsMin.toFixed(1)));
const frameMax = computed(() => (world.frameMsMax === -Infinity ? 0 : world.frameMsMax.toFixed(1)));
const frameAvg = computed(() => world.frameMsAvg);
const formatRate = (r: number): string => `${Number(r.toFixed(2))}×`;
</script>

<style scoped>
.sim-lab {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
  padding: 32px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #93c5fd;
  text-decoration: none;
}
.back-link:hover { text-decoration: underline; }
.lab-header { max-width: 1100px; margin: 0 auto 24px; }
.title-row h1 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.title-row .sub { margin: 0; color: #94a3b8; font-size: 14px; }
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 600;
}
.badge-active { background: rgba(34, 197, 94, 0.2); color: #86efac; }

.lab-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-width: 1100px;
  margin: 0 auto;
}
@media (max-width: 900px) {
  .lab-grid { grid-template-columns: 1fr; }
}
.card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
  padding: 20px 24px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  color: #cbd5e1;
  letter-spacing: 0.01em;
  font-weight: 600;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(2, 6, 23, 0.7);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.stat span { color: #94a3b8; }
.stat b { font-weight: 600; color: #f1f5f9; }
.stat b.changing { color: #93c5fd; animation: changing-pulse 1s ease-in-out infinite; }
.stat.warn b { color: #fbbf24; }
.stat.paused b { color: #fde047; }
@keyframes changing-pulse {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

.ctrl-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.ctrl-kind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #cbd5e1;
}
.ctrl-kind select {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 4px;
  font-size: 12px;
}

.btn {
  display: inline-block;
  padding: 6px 12px;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  text-decoration: none;
  font-size: 12px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}
.btn:hover:not(:disabled) { background: #1d4ed8; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.primary { background: #2563eb; padding: 8px 16px; font-size: 13px; }
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
}
.btn.danger { background: #7f1d1d; }
.btn.danger:hover { background: #991b1b; }

.phase-table {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.phase-table th {
  color: #94a3b8;
  font-weight: 500;
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
}
.phase-table td {
  padding: 4px 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
}
.phase-table code {
  background: rgba(148, 163, 184, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
}
.phase-red { color: #fca5a5; }
.phase-yellow { color: #fde047; }
.phase-green { color: #86efac; }

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: rgba(2, 6, 23, 0.5);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.toggle input { cursor: pointer; }
.toggle b.ok { color: #22c55e; margin-left: auto; }

.traj-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(2, 6, 23, 0.5);
  border-radius: 4px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.traj-row b { color: #fbbf24; margin-left: auto; }
.traj-row .btn { margin-left: 8px; }

.lab-footer {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 32px;
  max-width: 1100px;
  margin-left: auto;
  margin-right: auto;
}
</style>
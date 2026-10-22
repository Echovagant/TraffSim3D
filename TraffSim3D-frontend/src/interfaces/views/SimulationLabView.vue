<template>
  <main class="sim-lab">
    <!--
      Live 3D stage.

      `WorldCanvas` owns the render loop that drives `world.step()`.
      Without it nothing on this page advances — every readout below
      would be a frozen number. It is mounted exactly the way
      SceneEditorView mounts it; because the SPA keeps a single route
      mounted at a time there is only ever ONE renderer and ONE rAF
      loop, so the simulation is never stepped twice.
    -->
    <section class="lab-stage" data-testid="sim-lab-stage">
      <WorldCanvas />
      <!--
        Mounted only while the camera sensor is enabled.

        `CameraView` starts its rAF loop in `onMounted` and that loop
        bails out (without rescheduling) while `world.cameraEnabled` is
        false — so a CameraView mounted while the camera is off never
        renders a single frame and `world.cameraFrameCount` stays at 0.
        Mounting it together with the toggle makes the PiP (and the
        frame counter) live on this page.
      -->
      <CameraView v-if="world.cameraEnabled" />
    </section>

    <div class="lab-panel" data-testid="sim-lab-panel">
      <header class="lab-header">
        <router-link to="/" class="back-link">← 返回首页</router-link>
        <div class="title-row">
          <span class="badge" :class="world.isRunning ? 'badge-active' : 'badge-paused'">
            {{ world.isRunning ? '运行中' : '已暂停' }}
          </span>
          <h1>SimulationLab</h1>
          <p class="sub">实时仿真面板 — 物理 + 信号 + 传感器 (companion to SceneLab)</p>
        </div>
      </header>

      <div class="lab-grid">
        <!-- 1. 场景统计 -->
        <section class="card">
          <h2>1. 场景统计</h2>
          <div class="scene-switcher">
            <label>
              <span>当前场景</span>
              <select
                :value="world.currentSceneKind"
                data-testid="scene-select"
                @change="onSceneChange"
              >
                <option value="cross">单路口 (cross)</option>
                <option value="corridor">走廊 (corridor)</option>
                <option value="t">T 型路口 (t)</option>
                <option value="loop">矩形环 (loop)</option>
                <option value="elevated">高架桥 (elevated)</option>
                <option v-if="world.currentSceneKind === 'imported'" value="imported" disabled>
                  已导入 ({{ world.currentSceneLabel }})
                </option>
              </select>
            </label>
          </div>
          <div class="stat-grid">
            <div class="stat">
              <span>车辆</span><b>{{ vehicleCount }}</b>
            </div>
            <div class="stat">
              <span>信号灯</span><b>{{ lightCount }}</b>
            </div>
            <div class="stat">
              <span>交叉口</span><b>{{ intersectionCount }}</b>
            </div>
            <div class="stat">
              <span>道路</span><b>{{ roadCount }}</b>
            </div>
            <div class="stat">
              <span>NS 轴队列</span><b>{{ nsQueue }}</b>
            </div>
            <div class="stat">
              <span>EW 轴队列</span><b>{{ ewQueue }}</b>
            </div>
            <div class="stat">
              <span>变道中</span>
              <b :class="{ changing: changingCount > 0 }">{{ changingCount }}</b>
            </div>
            <div class="stat" title="每个渲染帧 +1；store 变更通知也会 +1">
              <span>仿真 tick</span><b data-testid="sim-tick">{{ world.tickCount }}</b>
            </div>
          </div>
        </section>

        <!-- 2. 信号控制面板 -->
        <section class="card">
          <h2>2. 信号控制</h2>
          <div class="ctrl-row">
            <label class="ctrl-kind">
              <span>控制器</span>
              <select
                :value="world.controllerKind"
                data-testid="controller-select"
                @change="onControllerKindChange"
              >
                <option value="fixed-cycle">固定</option>
                <option value="actuated">感应</option>
                <option value="coordinated">协调 (绿波带)</option>
                <option value="rl">RL (未实装·回退固定周期)</option>
              </select>
            </label>
            <button
              class="btn"
              data-testid="coordinated-button"
              :disabled="world.controllerKind !== 'coordinated'"
              @click="showCoordinated = true"
            >
              ⚙ 配置偏移
            </button>
            <button class="btn danger" data-testid="force-all-red" @click="world.forceAllRed()">
              🚨 全红 3s
            </button>
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
                <td>
                  <code>{{ row.id }}</code>
                </td>
                <td>{{ row.axis.toUpperCase() }}</td>
                <td>
                  <span :class="`phase phase-${row.phase}`">{{ row.phase }}</span>
                </td>
                <td data-testid="phase-remaining">{{ row.phaseRemaining.toFixed(1) }}</td>
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
              data-testid="lidar-toggle"
              :checked="world.lidarEnabled"
              @change="onLidarToggle"
            />
            <span>LiDAR (16线)</span>
            <b :class="world.lidarEnabled ? 'ok' : ''" data-testid="lidar-frames">
              {{ world.lidarFrameCount }} 帧
            </b>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              data-testid="lidar-clouds-toggle"
              :checked="world.lidarCloudsEnabled"
              @change="onLidarCloudsToggle"
            />
            <span>LiDAR 点云渲染</span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              data-testid="camera-toggle"
              :checked="world.cameraEnabled"
              @change="onCameraToggle"
            />
            <span>📷 Camera (PiP)</span>
            <b :class="world.cameraEnabled ? 'ok' : ''" data-testid="camera-frames">
              {{ world.cameraFrameCount }} 帧
            </b>
          </label>
          <div class="traj-row">
            <span>Trajectory</span>
            <b data-testid="trajectory-rows"
              >{{ world.trajectoryExporter.rowCount }} /
              {{ world.trajectoryExporter.maxBufferRows }} 行</b
            >
            <button class="btn" data-testid="trajectory-csv" @click="exportTrajectoryCsv">
              ⬇ CSV
            </button>
          </div>
        </section>

        <!-- 4. 性能指标 -->
        <section class="card">
          <h2>4. 性能</h2>
          <p class="card-note" :class="{ paused: !world.isRunning }">
            {{
              world.isRunning
                ? '实时测量 — 渲染帧间隔 (wall clock)'
                : '已暂停 — 下列数值为暂停前的最后测量'
            }}
          </p>
          <div class="stat-grid">
            <div
              class="stat"
              :class="{ warn: world.fps > 0 && world.fps < M1_MIN_FPS }"
              title="最近 500 ms 的实际渲染帧率"
            >
              <span>FPS</span><b data-testid="fps">{{ fpsText }}</b>
            </div>
            <div class="stat" title="最近 30 帧的帧间隔均值">
              <span>帧 ms (avg)</span><b data-testid="frame-avg">{{ frameAvg }}</b>
            </div>
            <div class="stat" title="本次会话中最短的帧间隔">
              <span>帧 ms (min)</span><b data-testid="frame-min">{{ frameMin }}</b>
            </div>
            <div class="stat" title="本次会话中最长的帧间隔">
              <span>帧 ms (max)</span><b data-testid="frame-max">{{ frameMax }}</b>
            </div>
            <div class="stat">
              <span>仿真速率</span>
              <b class="rate-control">
                <button
                  class="rate-btn"
                  data-testid="tick-rate-down"
                  title="减速"
                  @click="world.cycleTickRate(-1)"
                >
                  −
                </button>
                <span class="rate-value" data-testid="tick-rate">{{
                  formatRate(world.tickRate)
                }}</span>
                <button
                  class="rate-btn"
                  data-testid="tick-rate-up"
                  title="加速"
                  @click="world.cycleTickRate(1)"
                >
                  +
                </button>
              </b>
            </div>
            <div class="stat" :class="{ paused: !world.isRunning }">
              <span>状态</span>
              <b>
                <button class="pause-btn" data-testid="pause-button" @click="world.togglePause()">
                  {{ world.isRunning ? '⏸ 暂停' : '▶ 播放' }}
                </button>
              </b>
            </div>
          </div>
        </section>
      </div>

      <footer class="lab-footer">
        <router-link to="/scene-editor" class="btn primary">→ 去 SceneLab 编辑场景</router-link>
        <router-link to="/" class="btn ghost">← 返回首页</router-link>
      </footer>
    </div>

    <CoordinatedConfigModal v-model:open="showCoordinated" />
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useWorldStore, type SceneKind } from '@interfaces/stores/worldStore'
import { getAxisQueueLength } from '@application/services/signalController'
import { M1_MIN_FPS } from '@shared/constants/simulation'
import { CoordinatedConfigModal } from '@interfaces/components/editor'
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'

const world = useWorldStore()
const showCoordinated = ref(false)

// The FPS / frame-time readouts are session-scoped. Reset them when
// this route mounts its own renderer so the numbers describe this
// page's run instead of the previous route's leftovers.
onMounted(() => {
  world.resetFrameStats()
})

// 1. 场景统计
const vehicleCount = computed(() => Object.keys(world.network.vehicles).length)
const intersectionCount = computed(() => Object.keys(world.network.intersections).length)
const roadCount = computed(() => Object.keys(world.network.roads).length)
const lightCount = computed(() =>
  Object.values(world.network.intersections).reduce((s, i) => s + i.trafficLights.length, 0),
)

const lightRows = computed(() => {
  void world.tickCount
  return Object.values(world.network.intersections)
    .flatMap((i) => i.trafficLights)
    .sort((a, b) => a.id.localeCompare(b.id))
})

// Queue length uses a synthesised light (only `axis` and `roadId` are
// read inside getAxisQueueLength — see signalController.ts).
const stubLight = (axis: 'ns' | 'ew'): never =>
  ({
    id: `__queue_${axis}`,
    axis,
    phase: 0 as never,
    phaseRemaining: 0,
    position: { x: 0, y: 0, z: 0 },
    cycleSeconds: 63,
  }) as never

const nsQueue = computed(() => {
  void world.tickCount
  return getAxisQueueLength(stubLight('ns'), world.network)
})
const ewQueue = computed(() => {
  void world.tickCount
  return getAxisQueueLength(stubLight('ew'), world.network)
})
const changingCount = computed(() => {
  void world.tickCount
  return Object.values(world.network.vehicles).filter((v) => v.desiredLaneIndex !== null).length
})

// 2. 信号控制
const onControllerKindChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value
  // world.setControllerKind 接受 ControllerKind union; 4 个 option 值都合法.
  ;(world.setControllerKind as (k: string) => void)(v)
}

// 1. 场景切换
const onSceneChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value
  world.switchScene(v as SceneKind)
}

// 3. 传感器
const onLidarToggle = (e: Event): void =>
  world.setLidarEnabled((e.target as HTMLInputElement).checked)
const onLidarCloudsToggle = (e: Event): void =>
  world.setLidarCloudsEnabled((e.target as HTMLInputElement).checked)
const onCameraToggle = (e: Event): void =>
  world.setCameraEnabled((e.target as HTMLInputElement).checked)
const exportTrajectoryCsv = (): void => {
  const blob = world.trajectoryExporter.exportAsBlob({
    kind: 'csv',
    includeCrashed: true,
    sampleInterval: 0.1,
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trajectory-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// 4. 性能
// `fps` is the real render rate measured from wall-clock frame
// intervals; 0 means "not measured yet" (no renderer / no frame).
const fpsText = computed(() => (world.fps > 0 ? String(world.fps) : '—'))
const frameMin = computed(() => (world.frameMsMin === Infinity ? '—' : world.frameMsMin.toFixed(1)))
const frameMax = computed(() =>
  world.frameMsMax === -Infinity ? '—' : world.frameMsMax.toFixed(1),
)
const frameAvg = computed(() => (world.frameMsAvg > 0 ? world.frameMsAvg.toFixed(1) : '—'))
const formatRate = (r: number): string => `${Number(r.toFixed(2))}×`
</script>

<style scoped>
.sim-lab {
  --panel-w: 480px;
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--panel-w);
  background: #0b1220;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  overflow: hidden;
}

/* The live 3D stage — left of the dashboard column. */
.lab-stage {
  position: relative;
  min-width: 0;
  background: #0b1220;
}

/* The dashboard column — scrolls independently of the stage. */
.lab-panel {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px 20px 40px;
  background: rgba(11, 18, 32, 0.96);
  border-left: 1px solid rgba(148, 163, 184, 0.18);
}

@media (max-width: 900px) {
  .sim-lab {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 45vh minmax(0, 1fr);
  }
  .lab-panel {
    border-left: none;
    border-top: 1px solid rgba(148, 163, 184, 0.18);
  }
}

.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #93c5fd;
  text-decoration: none;
}
.back-link:hover {
  text-decoration: underline;
}
.lab-header {
  margin: 0 0 20px;
}
.title-row h1 {
  margin: 8px 0 4px;
  font-size: 26px;
  letter-spacing: -0.01em;
}
.title-row .sub {
  margin: 0;
  color: #94a3b8;
  font-size: 13px;
}
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 600;
}
.badge-active {
  background: rgba(34, 197, 94, 0.2);
  color: #86efac;
}
.badge-paused {
  background: rgba(234, 179, 8, 0.2);
  color: #fde047;
}

.lab-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(0, 1fr);
}
.card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
  padding: 16px 18px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  color: #cbd5e1;
  letter-spacing: 0.01em;
  font-weight: 600;
}
.card-note {
  margin: -6px 0 10px;
  font-size: 11px;
  color: #94a3b8;
}
.card-note.paused {
  color: #fde047;
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
.stat span {
  color: #94a3b8;
}
.stat b {
  font-weight: 600;
  color: #f1f5f9;
}
.stat b.changing {
  color: #93c5fd;
  animation: changing-pulse 1s ease-in-out infinite;
}
.stat.warn b {
  color: #fbbf24;
}
.stat.paused b {
  color: #fde047;
}
@keyframes changing-pulse {
  0%,
  100% {
    opacity: 0.6;
  }
  50% {
    opacity: 1;
  }
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
.btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn.primary {
  background: #2563eb;
  padding: 8px 16px;
  font-size: 13px;
}
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
}
.btn.danger {
  background: #7f1d1d;
}
.btn.danger:hover {
  background: #991b1b;
}

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
.phase-red {
  color: #fca5a5;
}
.phase-yellow {
  color: #fde047;
}
.phase-green {
  color: #86efac;
}
.phase-allRed {
  color: #f9a8d4;
}

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
.toggle input {
  cursor: pointer;
}
.toggle b.ok {
  color: #22c55e;
  margin-left: auto;
}

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
.traj-row b {
  color: #fbbf24;
  margin-left: auto;
}
.traj-row .btn {
  margin-left: 8px;
}

.lab-footer {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 24px;
}

.rate-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.rate-btn {
  width: 22px;
  height: 22px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}
.rate-btn:hover {
  background: rgba(30, 41, 59, 0.8);
  border-color: rgba(148, 163, 184, 0.5);
}
.rate-value {
  min-width: 40px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pause-btn {
  padding: 4px 10px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.pause-btn:hover {
  background: rgba(30, 41, 59, 0.8);
  border-color: rgba(148, 163, 184, 0.5);
}
.scene-switcher {
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
}
.scene-switcher label {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #94a3b8;
}
.scene-switcher select {
  padding: 4px 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  font-size: 12px;
  cursor: pointer;
}
.scene-switcher select:hover {
  border-color: rgba(148, 163, 184, 0.5);
}
</style>

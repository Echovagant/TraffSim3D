<!--
  The sensor panel — SimulationLab's sensor card, re-homed into the
  scene editor's right column.

  Same controls, same testids, same numbers as the old page's card 3:
  the LiDAR toggle (with its live scan rate), the point-cloud toggle,
  the camera PiP (with its frame count) and the trajectory CSV export.
  Only the geometry changed — a narrow column instead of a 300px card.
-->
<script setup lang="ts">
import { useWorldStore } from '@interfaces/stores/worldStore'
import { showFlashMessage } from '@interfaces/composables/useFlashMessage'

const world = useWorldStore()

const droppedSamples = (): number => world.trajectoryExporter.droppedSampleCount
const recordedSamples = (): number => world.trajectoryExporter.rowCount
const totalSamples = (): number => recordedSamples() + droppedSamples()
const dropRateText = (): string =>
  totalSamples() > 0 ? `${((droppedSamples() / totalSamples()) * 100).toFixed(1)}%` : '—'

const onLidarToggle = (e: Event): void => {
  world.setLidarEnabled((e.target as HTMLInputElement).checked)
}
const onLidarCloudsToggle = (e: Event): void => {
  world.setLidarCloudsEnabled((e.target as HTMLInputElement).checked)
}
const onCameraToggle = (e: Event): void => {
  world.setCameraEnabled((e.target as HTMLInputElement).checked)
}
const exportTrajectoryCsv = (): void => {
  const dropped = droppedSamples()
  const recorded = recordedSamples()
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
  // Say it out loud when the file is missing rows: a lossy export the
  // user cannot see is a lossy export they train on by accident.
  if (dropped > 0) {
    showFlashMessage(
      `轨迹已导出 ${recorded} 行 — 脏数据过滤器丢弃了 ${dropped} 个样本（${(
        (dropped / (recorded + dropped)) *
        100
      ).toFixed(1)}%）`,
      'warn',
      5000,
    )
  }
}
</script>

<template>
  <div class="sensor-panel" data-testid="sensor-panel">
    <label class="row">
      <input
        type="checkbox"
        data-testid="lidar-toggle"
        :checked="world.lidarEnabled"
        @change="onLidarToggle"
      />
      <span>LiDAR (16线)</span>
      <b :class="world.lidarEnabled ? 'ok' : ''" data-testid="lidar-frames">
        {{ world.lidarScanRate }} 帧/s
      </b>
    </label>
    <label class="row">
      <input
        type="checkbox"
        data-testid="lidar-clouds-toggle"
        :checked="world.lidarCloudsEnabled"
        @change="onLidarCloudsToggle"
      />
      <span>点云渲染</span>
    </label>
    <label class="row">
      <input
        type="checkbox"
        data-testid="camera-toggle"
        :checked="world.cameraEnabled"
        @change="onCameraToggle"
      />
      <span>📷 Camera</span>
      <b :class="world.cameraEnabled ? 'ok' : ''" data-testid="camera-frames">
        {{ world.cameraFrameCount }} 帧
      </b>
    </label>
    <div class="traj">
      <span class="traj-title">Trajectory</span>
      <span class="traj-line">
        <b data-testid="trajectory-rows"
          >{{ world.trajectoryExporter.rowCount }} /
          {{ world.trajectoryExporter.maxBufferRows }} 行</b
        >
      </span>
      <span
        class="traj-line"
        data-testid="trajectory-dropped"
        :class="{ warn: droppedSamples() > 0 }"
        title="脏数据过滤器丢弃的样本数 / 全部样本数"
      >
        丢弃 {{ droppedSamples() }} / {{ totalSamples() }} ({{ dropRateText() }})
      </span>
      <button class="csv-btn" data-testid="trajectory-csv" @click="exportTrajectoryCsv">
        ⬇ 导出 CSV
      </button>
    </div>
  </div>
</template>

<style scoped>
.sensor-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--dc-label-size);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dc-text-dim);
  cursor: pointer;
}
.row span {
  flex: 1 1 auto;
}
.row b {
  font-weight: 600;
  color: var(--dc-text-faint);
  font-variant-numeric: tabular-nums;
}
.row b.ok {
  color: var(--dc-ok);
}
.traj {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--dc-accent) 16%, transparent);
}
.traj-title {
  font-size: 11px;
  color: var(--dc-text-faint);
  letter-spacing: 0.05em;
}
.traj-line {
  font-size: 11px;
  color: var(--dc-text-dim);
  font-variant-numeric: tabular-nums;
}
.traj-line b {
  color: var(--dc-text);
  font-weight: 500;
}
.traj-line.warn {
  color: var(--dc-warning);
}
.csv-btn {
  margin-top: 3px;
  padding: 3px 10px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 36%, transparent);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  color: var(--dc-text);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}
.csv-btn:hover {
  background: color-mix(in srgb, var(--dc-accent) 20%, transparent);
}
</style>

<template>
  <div class="toolbar">
    <router-link to="/" class="link-home" title="返回首页">← Home</router-link>

    <span class="sep" />

    <button
      class="sim"
      :class="{ paused: !world.isRunning }"
      :title="world.isRunning ? '暂停 (Space)' : '播放 (Space)'"
      @click="world.togglePause()"
    >
      {{ world.isRunning ? '⏸ Pause' : '▶ Play' }}
    </button>

    <div class="rate" title="仿真速率（+ / - 切换）">
      <button
        class="rate-btn"
        title="降低速率 (-)"
        :disabled="isMinRate"
        @click="world.cycleTickRate(-1)"
      >−</button>
      <span class="rate-value">{{ formatRate(world.tickRate) }}</span>
      <button
        class="rate-btn"
        title="提升速率 (+)"
        :disabled="isMaxRate"
        @click="world.cycleTickRate(1)"
      >+</button>
    </div>

    <span class="sep" />

    <button title="添加车辆" @click="onAddVehicle">+ Vehicle</button>
    <button title="添加信号灯" @click="world.addTrafficLight()">+ Light</button>
    <button title="强制所有信号灯全红 (3s)" @click="world.forceAllRed()">🚨 All Red</button>
    <button title="重置场景 (R)" @click="world.reset()">Reset</button>

    <label class="ctrl-kind" title="信号灯控制策略">
      <span class="ctrl-kind-label">控制</span>
      <select :value="world.controllerKind" @change="onControllerKindChange">
        <option value="fixed-cycle">固定</option>
        <option value="actuated">感应</option>
        <option value="coordinated">协调 (绿波带)</option>
        <option value="rl">RL</option>
      </select>
    </label>

    <button
      class="coord-btn"
      :disabled="!isCoordinatedKind"
      :title="isCoordinatedKind ? '配置协调偏移 (绿波带)' : '切换到协调控制器后可用'"
      @click="showCoordinated = true"
    >🚦 Coordinated</button>

    <button title="撤销 (Ctrl+Z)" :disabled="!world.canUndo()" @click="world.undo()">↶ Undo</button>
    <button title="重做 (Ctrl+Shift+Z)" :disabled="!world.canRedo()" @click="world.redo()">↷ Redo</button>

    <span class="sep" />

    <button title="保存到 LocalStorage" @click="io.save">💾 Save</button>
    <button title="从 LocalStorage 加载" @click="io.load">📂 Load</button>
    <button title="清除 LocalStorage 中的场景" @click="io.clear">🗑️ Clear</button>
    <button title="聚焦当前选中 (F)" @click="onFocusSelected">🎯 Focus</button>

    <button title="导出场景为 JSON 文件" @click="io.exportFile">⬇ Export</button>
    <button title="从 JSON 文件导入场景" @click="onImportFile">⬆ Import</button>
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      style="display: none"
      @change="onFileSelected"
    />

    <span class="sep" />

    <button title="下载轨迹 CSV (10Hz 采样)" @click="exportTrajectoryCsv">📥 Trajectory CSV</button>
    <label class="lidar-toggle" title="启用车载 16线 LiDAR (点云未渲染, 但 scan() 跑通; perf gate 验证)">
      <input type="checkbox" :checked="world.lidarEnabled" @change="onLidarToggle" />
      <span>LiDAR</span>
    </label>
    <label class="lidar-toggle" title="在 3D 场景中渲染 LiDAR 点云 (彩色, 按 intensity 渐变)">
      <input type="checkbox" :checked="world.lidarCloudsEnabled" @change="onLidarCloudsToggle" />
      <span>Clouds</span>
    </label>
    <label class="lidar-toggle" title="从选中车辆 POV 渲染 PiP 摄像头画面 (右下角)">
      <input type="checkbox" :checked="world.cameraEnabled" @change="onCameraToggle" />
      <span>📷 Camera</span>
    </label>

    <span class="sep" />
    <button
      class="help-btn"
      title="显示键盘快捷键 (?)"
      @click="showShortcuts = true"
    >?</button>

    <!-- Flash message: any code can call `showFlashMessage`; the
         toolbar always renders whatever's there for 3s. -->
    <span
      v-if="flash"
      class="flash"
      :class="`flash-${flash.level}`"
    >{{ flash.text }}</span>
    <span v-if="io.lastMessage.value" class="io-msg">{{ io.lastMessage.value }}</span>

    <KeyboardShortcutsModal v-model:open="showShortcuts" />
    <CoordinatedConfigModal v-model:open="showCoordinated" />
  </div>
</template>

<script setup lang="ts">
import { useEditor } from '@interfaces/composables/useEditor';
import { useSceneIO } from '@interfaces/composables/useSceneIO';
import { _flashMessageRef } from '@interfaces/composables/useFlashMessage';
import { focusOnSelection } from '@interfaces/composables/useCameraFocus';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import type { ControllerKind } from '@application/services/signalController';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { TICK_RATE_LADDER } from '@interfaces/stores/worldStore';
import KeyboardShortcutsModal from './KeyboardShortcutsModal.vue';
import CoordinatedConfigModal from './CoordinatedConfigModal.vue';

const { world } = useEditor(ref(null));
const io = useSceneIO();
const flash = _flashMessageRef;
const fileInput = ref<HTMLInputElement | null>(null);
const showShortcuts = ref(false);
const showCoordinated = ref(false);
const selection = useSelectionStore();

const onFocusSelected = (): void => {
  if (selection.kind && selection.id) {
    focusOnSelection(selection.kind, selection.id, world);
  }
};

// Bridge from the `?` key handler in `useEditorShortcuts` (which
// dispatches a window-level custom event so it doesn't need a direct
// ref into the toolbar) to the modal's `open` ref.
const onToggleShortcuts = (): void => {
  showShortcuts.value = !showShortcuts.value;
};
onMounted(() => window.addEventListener('traffsim3d:toggle-shortcuts', onToggleShortcuts));
onBeforeUnmount(() => window.removeEventListener('traffsim3d:toggle-shortcuts', onToggleShortcuts));

const onAddVehicle = (): void => {
  // `addVehicle` returns `{ ok, ... }` in M1.5; we don't need the
  // result here because failures surface via the flash channel.
  world.addVehicle();
};

const onControllerKindChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value as ControllerKind;
  world.setControllerKind(v);
};

const onLidarToggle = (e: Event): void => {
  world.setLidarEnabled((e.target as HTMLInputElement).checked);
};

const onLidarCloudsToggle = (e: Event): void => {
  world.setLidarCloudsEnabled((e.target as HTMLInputElement).checked);
};

const onCameraToggle = (e: Event): void => {
  world.setCameraEnabled((e.target as HTMLInputElement).checked);
};

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

/**
 * Trigger the hidden file input so the browser opens its native
 * file picker. The actual read happens in `onFileSelected`.
 */
const onImportFile = (): void => {
  fileInput.value?.click();
};

/**
 * Read the user-selected file and forward to `useSceneIO.importFile`,
 * which parses + validates + loads it. Reset `target.value` so the
 * same file can be re-selected (browsers cache the previous selection
 * and won't fire `change` again otherwise).
 */
const onFileSelected = async (e: Event): Promise<void> => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  await io.importFile(file);
  // Reset the input so re-selecting the same file fires `change` again.
  target.value = '';
};

const formatRate = (r: number): string => {
  // 0.25 → "0.25×", 1 → "1×", 2 → "2×", 4 → "4×".
  // `.toString()` gives us a stable representation; trim trailing zeros for clean look.
  return `${Number(r.toFixed(2))}×`;
};

const isMinRate = computed(() => world.tickRate === TICK_RATE_LADDER[0]);
const isMaxRate = computed(() => world.tickRate === TICK_RATE_LADDER[TICK_RATE_LADDER.length - 1]);
const isCoordinatedKind = computed(() => world.controllerKind === 'coordinated');
</script>

<style scoped>
.toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  background: rgba(15, 23, 42, 0.7);
  border-radius: 6px;
  /* Cap width so a tall toolbar wraps cleanly when the window is narrow. */
  max-width: calc(100vw - 24px);
  flex-wrap: wrap;
}
.sep {
  width: 1px;
  height: 20px;
  background: rgba(148, 163, 184, 0.25);
  margin: 0 2px;
}
button, .link-home {
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: #1e293b;
  color: #f1f5f9;
  cursor: pointer;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
button:hover:not(:disabled), .link-home:hover { background: #334155; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.sim.paused { background: #b45309; }
button.sim.paused:hover { background: #d97706; }
button.danger { background: #7f1d1d; }
button.danger:hover { background: #991b1b; }
.link-home { background: #0f172a; }

/* Coordinated config button: gated to the coordinated controller kind. */
.coord-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.coord-btn:not(:disabled) { background: #1e3a8a; }
.coord-btn:not(:disabled):hover { background: #1d4ed8; }

/* Rate cluster: [−] [1.00×] [+] sits flush together. */
.rate {
  display: inline-flex;
  align-items: center;
  background: #0f172a;
  border-radius: 4px;
  overflow: hidden;
}
.rate-btn {
  padding: 6px 8px;
  background: transparent;
  border-radius: 0;
  font-size: 14px;
  min-width: 26px;
  justify-content: center;
}
.rate-btn:hover:not(:disabled) { background: #334155; }
.rate-value {
  padding: 0 8px;
  font-size: 12px;
  min-width: 44px;
  text-align: center;
  color: #fbbf24;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Controller-kind dropdown sits next to the Reset button. */
.ctrl-kind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px 0 8px;
  background: #0f172a;
  border-radius: 4px;
  font-size: 12px;
  color: #cbd5e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ctrl-kind-label { opacity: 0.7; }
.ctrl-kind select {
  background: transparent;
  color: #fbbf24;
  border: none;
  font-family: inherit;
  font-size: 12px;
  padding: 6px 4px;
  cursor: pointer;
}
.ctrl-kind select:focus { outline: 1px solid #475569; }

/* LiDAR toggle: a checkbox + label, sits next to the Trajectory CSV button. */
.lidar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: #1e293b;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #cbd5e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.lidar-toggle input { cursor: pointer; }
.lidar-toggle:hover { background: #334155; }

.io-msg {
  margin-left: 6px;
  font-size: 11px;
  color: #fbbf24;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.flash {
  margin-left: 6px;
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  /* Subtle pulse so the eye notices it without being annoying. */
  animation: flash-in 240ms ease-out;
}
.flash-info { background: #1e3a8a; color: #dbeafe; border: 1px solid #3b82f6; }
.flash-warn { background: #78350f; color: #fef3c7; border: 1px solid #d97706; }
.flash-error { background: #7f1d1d; color: #fee2e2; border: 1px solid #ef4444; }

@keyframes flash-in {
  from { opacity: 0; transform: translateX(4px); }
  to { opacity: 1; transform: translateX(0); }
}
</style>

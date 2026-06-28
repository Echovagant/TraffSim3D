<template>
  <button
    v-if="toolbarCollapsed"
    class="toolbar-toggle-collapsed"
    title="展开工具栏"
    @click="toolbarCollapsed = false"
  >⇱ 工具栏</button>
  <div v-else class="toolbar">
    <router-link to="/" class="link-home" title="返回首页">← 首页</router-link>

    <span class="sep" />

    <button
      class="sim"
      :class="{ paused: !world.isRunning }"
      :title="world.isRunning ? '暂停 (Space)' : '播放 (Space)'"
      @click="world.togglePause()"
    >
      {{ world.isRunning ? '⏸ 暂停' : '▶ 播放' }}
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

    <button title="添加车辆" @click="onAddVehicle">+ 车辆</button>
    <button title="一键生成 50 辆车演示 Rapier 碰撞 (M2)" @click="onSpawnMany(50)">🚗 +50 车辆</button>
    <button title="添加信号灯" @click="world.addTrafficLight()">+ 信号灯</button>
    <button title="强制所有信号灯全红 (3s)" @click="world.forceAllRed()">🚨 全红</button>
    <button title="重置场景 (R)" data-testid="reset-button" @click="world.reset()">重置</button>

    <label class="ctrl-kind" title="信号灯控制策略">
      <span class="ctrl-kind-label">控制</span>
      <select :value="world.controllerKind" @change="onControllerKindChange">
        <option value="fixed-cycle">固定</option>
        <option value="actuated">感应</option>
        <option value="coordinated">协调 (绿波带)</option>
        <option value="rl">RL</option>
      </select>
    </label>

    <label class="ctrl-kind scene-kind" title="演示场景 (M2 道路几何)">
      <span class="ctrl-kind-label">场景</span>
      <!-- Plan 054: for imported OSM/PBF scenes, show a read-only
           label with the file name instead of the dropdown. The
           user can still switch to a built-in scene to abandon
           the import via the dropdown menu of the next built-in
           scene (we keep the select available, just disabled). -->
      <select
        v-if="world.currentSceneKind !== 'imported'"
        :value="world.currentSceneKind"
        @change="onSceneKindChange"
        data-testid="scene-kind-select"
      >
        <option value="cross">十字路口</option>
        <option value="t">T 路口</option>
        <option value="loop">矩形环</option>
        <option value="elevated">高架桥</option>
        <option value="corridor">多路口走廊</option>
      </select>
      <span
        v-else
        class="scene-label-imported"
        :title="`已导入: ${world.currentSceneLabel}`"
        data-testid="scene-label-imported"
      >📂 {{ world.currentSceneLabel }}</span>
    </label>

    <button
      class="coord-btn"
      :disabled="!isCoordinatedKind"
      :title="isCoordinatedKind ? '配置协调偏移 (绿波带)' : '切换到协调控制器后可用'"
      @click="showCoordinated = true"
    >🚦 协调配置</button>

    <button title="撤销 (Ctrl+Z)" :disabled="!world.canUndo()" @click="world.undo()">↶ 撤销</button>
    <button title="重做 (Ctrl+Shift+Z)" :disabled="!world.canRedo()" @click="world.redo()">↷ 重做</button>
    <!-- Plan 053: manual camera-fit. Useful after the user has
         panned / orbited far from the network and wants to recover,
         or after importing a new OSM region that auto-fit missed. -->
    <button
      title="重新框选整个场景 (F)"
      data-testid="fit-scene-button"
      @click="onFitScene"
    >🎯 适配场景</button>

    <span class="sep" />

    <button title="保存到 LocalStorage" @click="io.save">💾 保存</button>
    <button title="从 LocalStorage 加载" @click="io.load">📂 加载</button>
    <button title="清除 LocalStorage 中的场景" @click="io.clear">🗑️ 清除</button>
    <button title="聚焦当前选中 (F)" @click="onFocusSelected">🎯 聚焦</button>

    <button title="导出场景为 JSON 文件" @click="io.exportFile">⬇ 导出</button>
    <button title="从 JSON 文件导入场景" @click="onImportFile">⬆ 导入</button>
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      style="display: none"
      @change="onFileSelected"
    />

    <span class="sep" />

    <button title="下载轨迹 CSV (10Hz 采样)" @click="exportTrajectoryCsv">📥 轨迹 CSV</button>
    <label class="lidar-toggle" title="启用车载 16线 LiDAR (点云未渲染, 但 scan() 跑通; perf gate 验证)">
      <input type="checkbox" :checked="world.lidarEnabled" @change="onLidarToggle" />
      <span>LiDAR (雷达)</span>
    </label>
    <label class="lidar-toggle" title="在 3D 场景中渲染 LiDAR 点云 (彩色, 按 intensity 渐变)">
      <input type="checkbox" :checked="world.lidarCloudsEnabled" @change="onLidarCloudsToggle" />
      <span>点云</span>
    </label>
    <label class="lidar-toggle" title="从选中车辆 POV 渲染 PiP 摄像头画面 (右下角)">
      <input type="checkbox" :checked="world.cameraEnabled" @change="onCameraToggle" />
      <span>📷 摄像头</span>
    </label>

    <span class="sep" />
    <button
      class="help-btn"
      title="显示键盘快捷键 (?)"
      @click="showShortcuts = true"
    >?</button>
    <button
      class="toolbar-collapse"
      title="折叠工具栏"
      @click="toolbarCollapsed = true"
    >⇲</button>

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
import { _flashMessageRef, showFlashMessage } from '@interfaces/composables/useFlashMessage';
import { focusOnSelection } from '@interfaces/composables/useCameraFocus';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import type { ControllerKind } from '@application/services/signalController';
import type { SceneKind } from '@interfaces/stores/worldStore';
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
const toolbarCollapsed = ref(false);
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

/** Plan 031: 一键生成 N 辆车演示 Rapier 碰撞. */
const onSpawnMany = (count: number): void => {
  const ok = world.spawnMany(count);
  if (ok === 0) {
    showFlashMessage('车道已满, 无法添加车辆', 'warn');
  } else if (ok < count) {
    showFlashMessage(`已添加 ${ok}/${count} 辆车 (车道已满)`, 'warn');
  } else {
    showFlashMessage(`已添加 ${ok} 辆车 — 看 Rapier 碰撞!`, 'info');
  }
};

const onControllerKindChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value as ControllerKind;
  world.setControllerKind(v);
};

const onSceneKindChange = (e: Event): void => {
  const v = (e.target as HTMLSelectElement).value as SceneKind;
  world.switchScene(v);
  showFlashMessage(`已切换场景: ${sceneLabel(v)}`, 'info');
};

/** Plan 053: manual re-fit trigger. Bumps `worldStore.fitRequestTick`,
 *  which `WorldCanvas` watches and forwards to `requestFitToNetwork`.
 *  Useful when the user has panned/orbited far from the network
 *  (e.g. after dragging to inspect a corner) and wants to recover. */
const onFitScene = (): void => {
  world.requestFit();
};

const sceneLabel = (k: SceneKind): string => {
  switch (k) {
    case 'cross':    return '十字路口';
    case 't':        return 'T 路口';
    case 'loop':     return '矩形环';
    case 'elevated': return '高架桥';
    case 'corridor': return '多路口走廊';
  }
  return k; // fallback for imported scenes (Plan 054)
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
  z-index: 5;
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

/* Toolbar collapse button: lives at the end of the toolbar row. */
.toolbar-collapse {
  padding: 6px 8px;
  background: transparent;
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.toolbar-collapse:hover { background: rgba(148, 163, 184, 0.15); color: #f1f5f9; }

/* Collapsed toolbar pill: replaces the full toolbar when folded. */
.toolbar-toggle-collapsed {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 6px 12px;
  background: rgba(15, 23, 42, 0.7);
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  z-index: 5;
}
.toolbar-toggle-collapsed:hover { background: rgba(15, 23, 42, 0.9); color: #f1f5f9; }

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

/* Scene-kind dropdown: same shell as ctrl-kind but visually distinct so
   the user can tell them apart at a glance. */
.scene-kind { background: #1e293b; }
.scene-kind select { color: #34d399; }

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

/* Plan 054: read-only label shown in the toolbar when an OSM/PBF
   scene is loaded (replaces the scene-kind dropdown). */
.scene-label-imported {
  display: inline-block;
  background: rgba(168, 85, 247, 0.18);
  color: #d8b4fe;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
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

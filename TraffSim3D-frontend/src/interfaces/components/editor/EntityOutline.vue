<template>
  <div class="outline">
    <header class="head">
      <span class="title">场景大纲</span>
      <span class="counts">
        <span title="车辆">🚗 {{ vehicleCount }}</span>
        <span title="信号灯">🚦 {{ lightCount }}</span>
      </span>
    </header>

    <div class="body">
      <section v-if="vehicleCount > 0" class="group">
        <button
          class="group-head"
          :aria-expanded="!vehiclesCollapsed"
          @click="vehiclesCollapsed = !vehiclesCollapsed"
        >
          <span class="caret">{{ vehiclesCollapsed ? '▸' : '▾' }}</span>
          <span class="group-label">Vehicles</span>
          <span class="group-count">{{ vehicleCount }}</span>
        </button>
        <ul v-show="!vehiclesCollapsed" class="rows">
          <li
            v-for="v in vehicleRows"
            :key="v.id"
            class="row"
            :class="{
              active: isSelected('vehicle', v.id),
              crashed: v.status === 'crashed',
            }"
            :style="{ borderLeftColor: v.status === 'crashed' ? '#ef4444' : v.color }"
            @click="onSelect('vehicle', v.id)"
          >
            <span class="row-id">{{ v.id }}</span>
            <span class="row-type">{{ v.type }}</span>
            <span class="row-lane" :title="`lane ${v.laneIndex}`">L{{ v.laneIndex }}</span>
            <span class="row-status" :title="`status: ${v.status}`">
              {{ statusIcon(v.status) }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="lightCount > 0" class="group">
        <button
          class="group-head"
          :aria-expanded="!lightsCollapsed"
          @click="lightsCollapsed = !lightsCollapsed"
        >
          <span class="caret">{{ lightsCollapsed ? '▸' : '▾' }}</span>
          <span class="group-label">Lights</span>
          <span class="group-count">{{ lightCount }}</span>
        </button>
        <ul v-show="!lightsCollapsed" class="rows">
          <li
            v-for="l in lightRows"
            :key="l.id"
            class="row"
            :class="{ active: isSelected('light', l.id), [l.phase]: true }"
            @click="onSelect('light', l.id)"
          >
            <span class="row-id">{{ l.id }}</span>
            <span class="row-type">{{ l.axis.toUpperCase() }}</span>
            <span class="row-status">{{ l.phase }}</span>
          </li>
        </ul>
      </section>

      <p v-if="vehicleCount === 0 && lightCount === 0" class="empty">
        场景为空 — 在顶部点 <code>+ Vehicle</code> / <code>+ Light</code>，或 <code>Load</code> 之前保存的场景。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEditor } from '@interfaces/composables/useEditor';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { focusOnSelection } from '@interfaces/composables/useCameraFocus';

const { world } = useEditor(ref(null));
const selection = useSelectionStore();

// `world.network` is a plain object mutated in place by the store
// (add/remove/reset/hydrate). To make the computed list re-evaluate when
// the network changes, every mutation path bumps `tickCount`, so we
// read it inside the computeds — that flips the dep and Vue re-runs
// `Object.values` against the new state.
const vehicles = computed(() => {
  void world.tickCount;
  return Object.values(world.network.vehicles);
});
const lights = computed(() => {
  void world.tickCount;
  return Object.values(world.network.intersections).flatMap((i) => i.trafficLights);
});
const vehicleRows = computed(() => [...vehicles.value].sort((a, b) => a.id.localeCompare(b.id)));
const lightRows = computed(() => [...lights.value].sort((a, b) => a.id.localeCompare(b.id)));
const vehicleCount = computed(() => vehicleRows.value.length);
const lightCount = computed(() => lightRows.value.length);

const vehiclesCollapsed = ref(false);
const lightsCollapsed = ref(false);

const isSelected = (kind: 'vehicle' | 'light', id: string): boolean =>
  selection.kind === kind && selection.id === id;

const onSelect = (kind: 'vehicle' | 'light', id: string): void => {
  selection.select(kind, id);
  // Fly the camera to the picked entity. No-op if the controls haven't
  // attached yet (e.g. HMR teardown).
  focusOnSelection(kind, id, world);
};

const statusIcon = (s: 'driving' | 'waiting' | 'crashed'): string => {
  if (s === 'driving') return '▶';
  if (s === 'waiting') return '⏸';
  if (s === 'crashed') return '💥';
  return '?';
};
</script>

<style scoped>
.outline {
  position: absolute;
  bottom: 12px;
  left: 12px;
  width: 240px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow: hidden;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
  flex-shrink: 0;
}
.head .title { font-weight: 600; }
.head .counts { display: flex; gap: 8px; opacity: 0.7; font-size: 11px; }

.body { overflow-y: auto; padding: 4px 0; }

.group { margin-bottom: 2px; }
.group-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: none;
  color: #cbd5e1;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.group-head:hover { background: rgba(148, 163, 184, 0.08); }
.group-head .caret { width: 10px; opacity: 0.7; }
.group-head .group-label { flex: 1; text-align: left; }
.group-head .group-count { opacity: 0.5; }

.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 14px;
  border-left: 3px solid transparent;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
}
.row:hover { background: rgba(148, 163, 184, 0.08); }
.row.active {
  background: rgba(59, 130, 246, 0.18);
  color: #f8fafc;
}
.row-id { flex: 1; }
.row-type {
  font-size: 10px;
  opacity: 0.7;
  text-transform: uppercase;
}
.row-lane {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(148, 163, 184, 0.15);
  color: #cbd5e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.row-status {
  font-size: 10px;
  opacity: 0.7;
  text-transform: uppercase;
  min-width: 38px;
  text-align: right;
}

/* Phase color hints so a green/red row is visible at a glance. */
.row.red .row-status { color: #fca5a5; }
.row.yellow .row-status { color: #fde047; }
.row.green .row-status { color: #86efac; }

/* Crashed vehicles: red border, slightly darker row, pulsing crash icon. */
.row.crashed {
  background: rgba(239, 68, 68, 0.18);
  animation: crash-pulse 1.2s ease-in-out infinite;
}
.row.crashed .row-status {
  color: #ef4444;
  font-size: 12px;
  filter: drop-shadow(0 0 4px rgba(239, 68, 68, 0.7));
}
.row.crashed .row-id { color: #fecaca; }
@keyframes crash-pulse {
  0%, 100% { background: rgba(239, 68, 68, 0.10); }
  50%      { background: rgba(239, 68, 68, 0.30); }
}

.empty {
  margin: 0;
  padding: 12px 10px;
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.5;
}
.empty code {
  background: rgba(148, 163, 184, 0.12);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
</style>

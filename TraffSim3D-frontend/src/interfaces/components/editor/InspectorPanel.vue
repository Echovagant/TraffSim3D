<template>
  <div v-if="entity" class="inspector">
    <header>
      <span class="kind">{{ selection.kind }}</span>
      <span class="id">#{{ selection.id }}</span>
      <button class="ghost" title="取消选中 (Esc)" @click="deselect">✕</button>
      <button class="danger" title="删除实体 (Delete)" @click="deleteSelected">🗑</button>
    </header>
    <div v-if="selection.kind === 'vehicle'">
      <label>Color <input type="color" :value="(entity as Vehicle).color" @change="updateColor(($event.target as HTMLInputElement).value)" /></label>
      <label>Type
        <select :value="(entity as Vehicle).type" @change="updateType(($event.target as HTMLSelectElement).value as 'car' | 'truck' | 'bus')">
          <option value="car">car</option>
          <option value="truck">truck</option>
          <option value="bus">bus</option>
        </select>
      </label>
      <label>Speed (km/h) <input type="number" :value="Speed.toKmh((entity as Vehicle).speed).toFixed(0)" min="0" max="120" @change="updateSpeed(Number(($event.target as HTMLInputElement).value))" /></label>
    </div>
    <div v-else-if="selection.kind === 'light'">
      <label>Phase
        <select :value="(entity as TrafficLight).phase" @change="updatePhase(($event.target as HTMLSelectElement).value)">
          <option value="red">red</option>
          <option value="yellow">yellow</option>
          <option value="green">green</option>
        </select>
      </label>
      <label>Axis
        <select :value="(entity as TrafficLight).axis" @change="updateAxis(($event.target as HTMLSelectElement).value as 'ns' | 'ew')">
          <option value="ns">ns</option>
          <option value="ew">ew</option>
        </select>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEditor } from '@interfaces/composables/useEditor';
import { Speed } from '@domain/value-objects/Speed';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';

const { world, selection } = useEditor(ref(null));

const entity = computed(() => {
  // Read tickCount so this computed re-evaluates after any worldStore mutation.
  void world.tickCount;
  if (!selection.id || !selection.kind) return null;
  if (selection.kind === 'vehicle') return world.network.vehicles[selection.id] ?? null;
  if (selection.kind === 'light') {
    for (const inter of Object.values(world.network.intersections)) {
      const found = inter.trafficLights.find((l) => l.id === selection.id);
      if (found) return found;
    }
  }
  return null;
});

const deselect = (): void => {
  selection.clear();
};

const updateColor = (color: string) => {
  if (selection.kind === 'vehicle' && entity.value && 'color' in entity.value) {
    (entity.value as { color: string }).color = color;
    world.notifyChange();
  }
};
const updateType = (type: 'car' | 'truck' | 'bus') => {
  if (selection.kind === 'vehicle' && entity.value) {
    const v = entity.value as Vehicle;
    if (v.type === type) return;
    world.updateVehicleType(v.id, type);
    world.notifyChange();
  }
};
const updateSpeed = (kmh: number) => {
  if (selection.kind === 'vehicle' && entity.value) {
    const v = entity.value as Vehicle;
    world.setVehicleSpeed(v.id, kmh);
    world.notifyChange();
  }
};
const updatePhase = (phase: string) => {
  if (selection.kind === 'light' && entity.value) {
    (entity.value as { phase: string }).phase = phase;
    world.notifyChange();
  }
};
const updateAxis = (axis: 'ns' | 'ew') => {
  if (selection.kind === 'light' && entity.value) {
    (entity.value as { axis: 'ns' | 'ew' }).axis = axis;
    world.notifyChange();
  }
};
const deleteSelected = () => {
  if (selection.kind === 'vehicle' && selection.id) world.removeVehicle(selection.id);
  else if (selection.kind === 'light' && selection.id) world.removeTrafficLight(selection.id);
  selection.clear();
};
</script>

<style scoped>
.inspector {
  /* Right column, below the DebugPanel. The DebugPanel is ~140px tall;
   * this offset is its top (12) + height + 16 gap, rounded. */
  position: absolute;
  top: 168px;
  right: 12px;
  width: 240px;
  padding: 10px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.inspector header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.inspector .kind { text-transform: uppercase; font-size: 10px; opacity: 0.7; }
.inspector .id { flex: 1; font-weight: 600; }
.inspector label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; }
.inspector input, .inspector select { background: #1e293b; color: #f1f5f9; border: 1px solid #334155; border-radius: 4px; padding: 2px 4px; font-family: inherit; font-size: 11px; }
.inspector button {
  padding: 3px 6px;
  background: #1e293b;
  color: #f1f5f9;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
}
.inspector button.ghost { background: transparent; opacity: 0.6; }
.inspector button.ghost:hover { background: rgba(148, 163, 184, 0.15); opacity: 1; }
.inspector button.danger { background: #7f1d1d; }
.inspector button.danger:hover { background: #991b1b; }
</style>

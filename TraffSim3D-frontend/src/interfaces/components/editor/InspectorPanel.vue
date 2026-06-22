<template>
  <div v-if="entity" class="inspector">
    <header>
      <span class="kind">{{ selection.kind }}</span>
      <span class="id">#{{ selection.id }}</span>
      <button class="danger" @click="deleteSelected">Delete</button>
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

const updateColor = (color: string) => {
  if (selection.kind === 'vehicle' && entity.value && 'color' in entity.value) {
    (entity.value as { color: string }).color = color;
    world.notifyChange();
  }
};
const updateType = (type: 'car' | 'truck' | 'bus') => {
  if (selection.kind === 'vehicle' && entity.value) {
    (entity.value as { type: 'car' | 'truck' | 'bus' }).type = type;
    world.notifyChange();
  }
};
const updateSpeed = (kmh: number) => {
  if (selection.kind === 'vehicle' && entity.value) {
    (entity.value as { speed: number }).speed = Speed.fromKmh(kmh);
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
  position: absolute;
  top: 60px;
  left: 12px;
  width: 240px;
  padding: 10px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.inspector header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.inspector .kind { text-transform: uppercase; font-size: 11px; opacity: 0.7; }
.inspector .id { flex: 1; }
.inspector label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.inspector input, .inspector select { background: #1e293b; color: #f1f5f9; border: 1px solid #334155; border-radius: 4px; padding: 2px 4px; }
.inspector button.danger { padding: 4px 8px; background: #7f1d1d; color: #f1f5f9; border: none; border-radius: 4px; cursor: pointer; }
</style>

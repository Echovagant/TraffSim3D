<template>
  <div class="toolbar">
    <button @click="addVehicle">+ Vehicle</button>
    <button @click="addLight">+ Light</button>
    <button class="danger" @click="reset">Reset</button>
  </div>
</template>

<script setup lang="ts">
import { useEditor } from '@interfaces/composables/useEditor';
import { ref } from 'vue';

const { world } = useEditor(ref(null));
const addVehicle = () => world.addVehicle();
const addLight = () => world.addTrafficLight();
const reset = () => world.reset();
</script>

<style scoped>
.toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 8px;
  padding: 6px;
  background: rgba(15, 23, 42, 0.6);
  border-radius: 6px;
}
button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: #1e293b;
  color: #f1f5f9;
  cursor: pointer;
  font-size: 13px;
}
button:hover { background: #334155; }
button.danger { background: #7f1d1d; }
button.danger:hover { background: #991b1b; }
</style>

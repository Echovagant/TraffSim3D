<template>
  <div class="io-buttons">
    <button @click="save">💾 Save</button>
    <button @click="load">📂 Load</button>
    <button @click="clear">🗑️ Clear</button>
    <span v-if="lastMessage" class="msg">{{ lastMessage }}</span>
  </div>
</template>

<script setup lang="ts">
import { useSceneIO } from '@interfaces/composables/useSceneIO';
const { save, load, clear, lastMessage } = useSceneIO();
</script>

<style scoped>
.io-buttons {
  position: absolute;
  top: 12px;
  left: 280px;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px;
  background: rgba(15, 23, 42, 0.6);
  border-radius: 6px;
}
.io-buttons button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: #1e293b;
  color: #f1f5f9;
  cursor: pointer;
  font-size: 13px;
}
.io-buttons button:hover { background: #334155; }
.io-buttons .msg {
  margin-left: 8px;
  font-size: 12px;
  color: #fbbf24;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>

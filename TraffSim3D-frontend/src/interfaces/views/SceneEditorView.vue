<template>
  <div class="scene-editor">
    <WorldCanvas />
    <WorldHUD />
  </div>
</template>

<script setup lang="ts">
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue';
import WorldHUD from '@interfaces/components/scene/WorldHUD.vue';
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
</style>

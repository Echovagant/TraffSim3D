<template>
  <div class="scene-editor">
    <WorldCanvas />
    <WorldHUD />
    <EditorToolbar />
    <InspectorPanel />
  </div>
</template>

<script setup lang="ts">
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue';
import WorldHUD from '@interfaces/components/scene/WorldHUD.vue';
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue';
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue';
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
</style>

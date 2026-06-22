<template>
  <div class="scene-editor">
    <WorldCanvas />
    <DebugPanel />
    <EditorToolbar />
    <SceneIOButtons />
    <InspectorPanel />
  </div>
</template>

<script setup lang="ts">
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue';
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue';
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue';
import SceneIOButtons from '@interfaces/components/editor/SceneIOButtons.vue';
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue';
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
</style>

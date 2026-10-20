<template>
  <div class="scene-editor" data-testid="scene-canvas">
    <WorldCanvas />
    <DebugPanel />
    <EditorToolbar />
    <EntityOutline />
    <InspectorPanel />
    <CameraView />
  </div>
</template>

<script setup lang="ts">
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue'
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue'
import EntityOutline from '@interfaces/components/editor/EntityOutline.vue'
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'
import { useEditorShortcuts } from '@interfaces/composables/useEditorShortcuts'

useEditorShortcuts()
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
</style>

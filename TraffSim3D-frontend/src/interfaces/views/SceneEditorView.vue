<template>
  <div class="scene-editor" data-testid="scene-canvas">
    <!--
      PROTOTYPE (2026-11-07): the layout prototype lives behind
      `?variant=A|B|C`. Without the param the view renders EXACTLY as
      before — the e2e visual baselines and every existing spec are
      unaffected. Delete this block (and components/prototype/) once a
      layout wins.
    -->
    <template v-if="prototypeVariant">
      <VariantAWorkbench v-if="prototypeVariant === 'A'" />
      <VariantBColumns v-else-if="prototypeVariant === 'B'" />
      <VariantCFocus v-else />
      <PrototypeSwitcher />
    </template>
    <template v-else>
      <WorldCanvas />
      <DebugPanel />
      <EditorToolbar />
      <RoutePanel />
      <PoiPanel />
      <EntityOutline />
      <InspectorPanel />
      <CameraView />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue'
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue'
import RoutePanel from '@interfaces/components/editor/RoutePanel.vue'
import PoiPanel from '@interfaces/components/editor/PoiPanel.vue'
import EntityOutline from '@interfaces/components/editor/EntityOutline.vue'
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'
// PROTOTYPE — layout variants (throwaway; see components/prototype/).
import VariantAWorkbench from '@interfaces/components/prototype/VariantAWorkbench.vue'
import VariantBColumns from '@interfaces/components/prototype/VariantBColumns.vue'
import VariantCFocus from '@interfaces/components/prototype/VariantCFocus.vue'
import PrototypeSwitcher from '@interfaces/components/prototype/PrototypeSwitcher.vue'
import { useEditorShortcuts } from '@interfaces/composables/useEditorShortcuts'

useEditorShortcuts()

const route = useRoute()
/** `?variant=A|B|C` → the prototype layout; absent → today's layout. */
const prototypeVariant = computed(() => {
  const raw = route.query.variant
  const key = Array.isArray(raw) ? raw[0] : raw
  return key === 'A' || key === 'B' || key === 'C' ? key : null
})
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
</style>

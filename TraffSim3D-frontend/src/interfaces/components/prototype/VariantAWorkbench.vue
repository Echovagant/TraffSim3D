<!--
  PROTOTYPE — throwaway. SceneLab layout prototype, variant A.

  "工作台" (workbench): horizontal bands.
    ┌──────────────────────────────────────────┐
    │ 工具条 (整宽)                             │
    ├───────────────┬──────────────────────────┤
    │ 面板组(可滚)  │  3D 画布      │ 调试 HUD  │
    │ 大纲/路线/POI/│              │ (浮在画布)  │
    │ 属性          │              │            │
    ├───────────────┴──────────────────────────┤
    │ 仿真读数条 (SimulationLab 的内容落在这里)  │
    └──────────────────────────────────────────┘

  The readouts land in a full-width bottom band — the most "instrument
  panel" reading of the merge.
-->
<script setup lang="ts">
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue'
import RoutePanel from '@interfaces/components/editor/RoutePanel.vue'
import PoiPanel from '@interfaces/components/editor/PoiPanel.vue'
import EntityOutline from '@interfaces/components/editor/EntityOutline.vue'
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue'
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue'
import SimReadoutStrip from './SimReadoutStrip.vue'
</script>

<template>
  <div class="workbench">
    <header class="band-top">
      <EditorToolbar />
    </header>

    <div class="band-middle">
      <aside class="rail">
        <EntityOutline />
        <RoutePanel />
        <PoiPanel />
        <InspectorPanel />
      </aside>

      <div class="stage">
        <WorldCanvas />
        <DebugPanel class="hud" />
      </div>
    </div>

    <footer class="band-bottom">
      <SimReadoutStrip />
    </footer>
  </div>
</template>

<style scoped>
.workbench {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: #0b1220;
}
.band-top {
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(15, 23, 42, 0.7);
}
.band-middle {
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 0;
}
.rail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  border-right: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(11, 18, 32, 0.55);
}
.stage {
  position: relative;
  min-width: 0;
  min-height: 0;
}
.band-bottom {
  /* The bottom strip leaves room for the prototype switcher, so the
     switcher never covers the readout it is meant to help judge. */
  padding: 6px 8px 34px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(15, 23, 42, 0.7);
}

/* The scene panels are absolutely positioned for the current layout;
   in this band layout they have to flow instead. */
.band-top :deep(.toolbar) {
  position: relative;
  top: auto;
  left: auto;
}
.rail :deep(.outline),
.rail :deep(.route-panel),
.rail :deep(.poi-panel),
.rail :deep(.inspector) {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
  width: auto;
  max-height: none;
}
.hud :deep(.debug) {
  position: absolute;
  top: 8px;
  right: 8px;
}
</style>

<!--
  PROTOTYPE — throwaway. SceneLab layout prototype, variant B.

  "双列检查器" (IDE columns): a slim icon rail, one tabbed panel column
  on the left, the canvas in the middle, and an inspector column on the
  right that carries the debug HUD, the camera and the simulation
  readouts.

    ┌────┬──────────────┬───────────────┬──────────────┐
    │ ▣▤ │ [大纲|路线|   │               │  调试 HUD     │
    │ ▥▦ │  POI|属性]    │   3D 画布     │  相机         │
    │    │              │               │  仿真读数(竖) │
    └────┴──────────────┴───────────────┴──────────────┘

  Here the SimulationLab content becomes the RIGHT inspector column —
  the "make the simulator one workspace" reading of the merge.
-->
<script setup lang="ts">
import { ref } from 'vue'
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue'
import RoutePanel from '@interfaces/components/editor/RoutePanel.vue'
import PoiPanel from '@interfaces/components/editor/PoiPanel.vue'
import EntityOutline from '@interfaces/components/editor/EntityOutline.vue'
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue'
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'
import SimReadoutStrip from './SimReadoutStrip.vue'

type LeftTab = 'outline' | 'route' | 'poi' | 'inspector'
const tab = ref<LeftTab>('outline')
const tabs: Array<{ key: LeftTab; label: string }> = [
  { key: 'outline', label: '大纲' },
  { key: 'route', label: '路线' },
  { key: 'poi', label: 'POI' },
  { key: 'inspector', label: '属性' },
]
</script>

<template>
  <div class="ide">
    <nav class="rail">
      <span
        v-for="t in tabs"
        :key="t.key"
        class="rail-btn"
        :class="{ on: tab === t.key }"
        :title="t.label"
        @click="tab = t.key"
      >
        {{ t.label.slice(0, 1) }}
      </span>
    </nav>

    <aside class="left">
      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="left-body">
        <EntityOutline v-show="tab === 'outline'" />
        <RoutePanel v-show="tab === 'route'" />
        <PoiPanel v-show="tab === 'poi'" />
        <InspectorPanel v-show="tab === 'inspector'" />
      </div>
    </aside>

    <main class="stage">
      <EditorToolbar />
      <WorldCanvas />
    </main>

    <aside class="right">
      <DebugPanel />
      <CameraView />
      <div class="readout-vert">
        <SimReadoutStrip />
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ide {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: 44px 300px 1fr 300px;
  background: var(--dc-screen);
}
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  background: color-mix(in srgb, var(--dc-panel) 90%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--dc-text-dim) 15%, transparent);
}
.rail-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  cursor: pointer;
  color: var(--dc-text-dim);
  font-size: 12px;
  background: color-mix(in srgb, var(--dc-text-dim) 10%, transparent);
}
.rail-btn.on {
  background: rgba(59, 130, 246, 0.28);
  color: #bfdbfe;
}
.left {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid color-mix(in srgb, var(--dc-text-dim) 15%, transparent);
  background: rgba(11, 18, 32, 0.6);
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 6px 6px 0;
}
.tab {
  flex: 1;
  padding: 5px 0;
  border: none;
  border-radius: 5px 5px 0 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--dc-text-dim);
  background: transparent;
}
.tab.on {
  color: var(--dc-text);
  background: color-mix(in srgb, var(--dc-text-dim) 15%, transparent);
}
.left-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
.stage {
  position: relative;
  min-width: 0;
  min-height: 0;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  border-left: 1px solid color-mix(in srgb, var(--dc-text-dim) 15%, transparent);
  background: rgba(11, 18, 32, 0.6);
}
.readout-vert :deep(.readout) {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.readout-vert :deep(.stats) {
  /* The narrow column has to wrap the stat row instead of clipping it. */
  flex-wrap: wrap;
  row-gap: 4px;
}

/* Absolute positioning → flow inside the columns. */
.left-body :deep(.outline),
.left-body :deep(.route-panel),
.left-body :deep(.poi-panel),
.left-body :deep(.inspector) {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
  width: auto;
  max-height: none;
}
.stage :deep(.toolbar) {
  position: absolute;
  top: 8px;
  left: 8px;
  right: auto;
}
.right :deep(.debug),
.right :deep(.camera-view) {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
}
</style>

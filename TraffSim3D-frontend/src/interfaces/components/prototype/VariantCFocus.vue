<!--
  PROTOTYPE — throwaway. SceneLab layout prototype, variant C.

  "专注画布" (focus canvas): the map owns the screen; every panel is a
  floating glass card that can be toggled off.

    ┌──────────────────────────────────────────┐
    │        [悬浮工具条]        [调试卡]      │
    │   [大纲卡]                                 │
    │   [属性卡]              3D 画布            │
    │                                          │
    │        [悬浮读数坞 (可收起)]              │
    └──────────────────────────────────────────┘

  The most canvas-forward reading: the readouts become a floating dock
  that can collapse to a single line.
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
import SimReadoutStrip from './SimReadoutStrip.vue'

const showOutline = ref(true)
const showInspector = ref(false)
const showRoute = ref(false)
const showPoi = ref(false)
const showDebug = ref(true)
const dockOpen = ref(true)
</script>

<template>
  <div class="focus">
    <WorldCanvas />

    <div class="glass toolbar-card">
      <EditorToolbar />
    </div>

    <div class="glass debug-card" :class="{ off: !showDebug }">
      <button class="toggle" @click="showDebug = !showDebug">调试</button>
      <DebugPanel v-show="showDebug" />
    </div>

    <div class="glass left-card">
      <div class="chips">
        <button class="chip" :class="{ on: showOutline }" @click="showOutline = !showOutline">
          大纲
        </button>
        <button class="chip" :class="{ on: showRoute }" @click="showRoute = !showRoute">
          路线
        </button>
        <button class="chip" :class="{ on: showPoi }" @click="showPoi = !showPoi">POI</button>
        <button class="chip" :class="{ on: showInspector }" @click="showInspector = !showInspector">
          属性
        </button>
      </div>
      <EntityOutline v-show="showOutline" />
      <RoutePanel v-show="showRoute" />
      <PoiPanel v-show="showPoi" />
      <InspectorPanel v-show="showInspector" />
    </div>

    <div class="glass dock" :class="{ closed: !dockOpen }">
      <button class="dock-handle" @click="dockOpen = !dockOpen">
        {{ dockOpen ? '▾ 收起读数' : '▸ 读数' }}
      </button>
      <SimReadoutStrip v-show="dockOpen" />
    </div>
  </div>
</template>

<style scoped>
.focus {
  position: fixed;
  inset: 0;
  background: #0b1220;
}
.glass {
  background: rgba(15, 23, 42, 0.72);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(2, 6, 23, 0.45);
}
.toolbar-card {
  position: absolute;
  /* Anchored right after the left card instead of centred — centred it
     slid under the debug card at 1280 px. The right edge stops short of
     the debug card, so the toolbar wraps instead of running under it. */
  top: 10px;
  left: 270px;
  right: 384px;
  overflow-x: auto;
  padding: 4px 6px;
}
.debug-card {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 6px 8px;
}
.left-card {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 250px;
  max-height: calc(100% - 140px);
  overflow-y: auto;
  padding: 8px;
}
.chips {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.chip {
  flex: 1;
  padding: 3px 0;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11px;
  color: #94a3b8;
  background: rgba(148, 163, 184, 0.1);
}
.chip.on {
  color: #bfdbfe;
  background: rgba(59, 130, 246, 0.28);
}
.dock {
  position: absolute;
  /* Clear of the prototype switcher at the very bottom. */
  bottom: 44px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(1100px, calc(100% - 40px));
  padding: 6px 8px;
}
.dock-handle {
  display: block;
  margin: 0 auto 4px;
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  cursor: pointer;
}
.dock.closed {
  padding: 4px 8px;
}
.toggle {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  cursor: pointer;
  padding: 0 0 4px;
  display: block;
}

/* Floating cards keep their own look but lose the hardcoded anchors. */
.toolbar-card :deep(.toolbar) {
  position: relative;
  top: auto;
  left: auto;
}
.debug-card :deep(.debug) {
  position: relative;
  top: auto;
  right: auto;
}
.left-card :deep(.outline),
.left-card :deep(.route-panel),
.left-card :deep(.poi-panel),
.left-card :deep(.inspector) {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
  width: auto;
  max-height: none;
  margin-bottom: 8px;
}
</style>

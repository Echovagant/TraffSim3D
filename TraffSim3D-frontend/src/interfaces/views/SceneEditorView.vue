<template>
  <div class="scene-editor" data-testid="scene-canvas">
    <!--
      The layout (2026-11-07 grid rework; 2026-11-09 merge).

      Before this, eight panels were absolutely positioned with
      hand-written offsets (POI at `top: 300px`, the inspector at
      `top: 168px`, the outline at `bottom: 12px` …). Two of them
      overlapped the moment the viewport got short, five of them had
      NO z-index at all (the DOM order decided who covered whom), and
      the offsets broke the moment a panel's content grew.

      Now the screen is a GRID: the canvas owns the middle, the panels
      live in two columns that cannot overlap, and every panel can be
      folded away — on a narrow viewport the columns fold themselves.
    -->
    <ShowcaseNav variant="minimal" />
    <WorldCanvas />

    <header class="deck-top">
      <EditorToolbar />
    </header>

    <aside class="deck-col deck-left" data-testid="deck-left">
      <div class="slot" :class="{ 'is-folded': !outlineOpen }">
        <button
          class="slot-fold"
          :title="outlineOpen ? '收起 场景大纲' : '展开 场景大纲'"
          :aria-expanded="outlineOpen"
          @click="outlineOpen = !outlineOpen"
        >
          {{ outlineOpen ? '◀' : '▶' }}
        </button>
        <EntityOutline v-show="outlineOpen" />
      </div>

      <div class="slot" :class="{ 'is-folded': !routeOpen }">
        <button
          class="slot-fold"
          :title="routeOpen ? '收起 路线规划' : '展开 路线规划'"
          :aria-expanded="routeOpen"
          @click="routeOpen = !routeOpen"
        >
          {{ routeOpen ? '◀' : '▶' }}
        </button>
        <RoutePanel v-show="routeOpen" />
      </div>

      <div class="slot" :class="{ 'is-folded': !poiOpen }">
        <button
          class="slot-fold"
          :title="poiOpen ? '收起 兴趣点' : '展开 兴趣点'"
          :aria-expanded="poiOpen"
          @click="poiOpen = !poiOpen"
        >
          {{ poiOpen ? '◀' : '▶' }}
        </button>
        <PoiPanel v-show="poiOpen" />
      </div>
    </aside>

    <aside class="deck-col deck-right" data-testid="deck-right">
      <div class="slot" :class="{ 'is-folded': !debugOpen }">
        <button
          class="slot-fold"
          :title="debugOpen ? '收起 调试' : '展开 调试'"
          :aria-expanded="debugOpen"
          @click="debugOpen = !debugOpen"
        >
          {{ debugOpen ? '▶' : '◀' }}
        </button>
        <DebugPanel v-show="debugOpen" />
      </div>

      <div class="slot" :class="{ 'is-folded': !cameraOpen }">
        <button
          class="slot-fold"
          :title="cameraOpen ? '收起 相机' : '展开 相机'"
          :aria-expanded="cameraOpen"
          @click="cameraOpen = !cameraOpen"
        >
          {{ cameraOpen ? '▶' : '◀' }}
        </button>
        <CameraView v-show="cameraOpen" />
      </div>

      <div class="slot" :class="{ 'is-folded': !inspectorOpen }">
        <button
          class="slot-fold"
          :title="inspectorOpen ? '收起 属性' : '展开 属性'"
          :aria-expanded="inspectorOpen"
          @click="inspectorOpen = !inspectorOpen"
        >
          {{ inspectorOpen ? '▶' : '◀' }}
        </button>
        <InspectorPanel v-show="inspectorOpen" />
      </div>

      <div class="slot" :class="{ 'is-folded': !sensorOpen }">
        <button
          class="slot-fold"
          :title="sensorOpen ? '收起 传感器' : '展开 传感器'"
          :aria-expanded="sensorOpen"
          @click="sensorOpen = !sensorOpen"
        >
          {{ sensorOpen ? '▶' : '◀' }}
        </button>
        <SensorPanel v-show="sensorOpen" />
      </div>
    </aside>

    <!--
        The simulation drawer — the bottom strip.

        SimulationLab was a whole page for these three cards; they live
        here now (the merge of 2026-11-09). It folds to a slim rail so
        the map can take the full height when the readouts are not
        wanted.
      -->
    <footer class="deck-drawer" :class="{ 'is-folded': !drawerOpen }" data-testid="sim-drawer">
      <button
        class="drawer-fold"
        :title="drawerOpen ? '收起 仿真读数' : '展开 仿真读数'"
        :aria-expanded="drawerOpen"
        data-testid="drawer-toggle"
        @click="drawerOpen = !drawerOpen"
      >
        {{ drawerOpen ? '▼ 仿真读数' : '▲ 仿真读数' }}
      </button>
      <SimReadoutDrawer v-show="drawerOpen" class="drawer-body" />
    </footer>

    <!-- The map gets a click back when both columns are folded. -->
    <button
      v-if="bothColumnsFolded"
      class="deck-restore"
      title="展开两侧面板"
      data-testid="deck-restore"
      @click="restorePanels"
    >
      ⟩ 面板
    </button>
  </div>
</template>

<script setup lang="ts">
import { ShowcaseNav } from '@interfaces/components/showcase'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import WorldCanvas from '@interfaces/components/scene/WorldCanvas.vue'
import DebugPanel from '@interfaces/components/debug/DebugPanel.vue'
import EditorToolbar from '@interfaces/components/editor/EditorToolbar.vue'
import RoutePanel from '@interfaces/components/editor/RoutePanel.vue'
import PoiPanel from '@interfaces/components/editor/PoiPanel.vue'
import EntityOutline from '@interfaces/components/editor/EntityOutline.vue'
import InspectorPanel from '@interfaces/components/editor/InspectorPanel.vue'
import SensorPanel from '@interfaces/components/editor/SensorPanel.vue'
import SimReadoutDrawer from '@interfaces/components/editor/SimReadoutDrawer.vue'
import CameraView from '@interfaces/components/debug/CameraView.vue'
import { useEditorShortcuts } from '@interfaces/composables/useEditorShortcuts'

useEditorShortcuts()

// ===== the foldable panels =====
//
// Each panel folds on its own; a narrow viewport folds the columns
// themselves (see the media queries). `foldAll` is the "give the map
// the whole screen" state, reachable from any column.
const outlineOpen = ref(true)
const routeOpen = ref(true)
const poiOpen = ref(true)
const debugOpen = ref(true)
const cameraOpen = ref(true)
const inspectorOpen = ref(true)
const sensorOpen = ref(true)
const drawerOpen = ref(true)

const bothColumnsFolded = computed(
  () =>
    !outlineOpen.value &&
    !routeOpen.value &&
    !poiOpen.value &&
    !debugOpen.value &&
    !cameraOpen.value &&
    !inspectorOpen.value &&
    !sensorOpen.value,
)

const restorePanels = (): void => {
  outlineOpen.value = true
  routeOpen.value = true
  poiOpen.value = true
  debugOpen.value = true
  cameraOpen.value = true
  inspectorOpen.value = true
  sensorOpen.value = true
  drawerOpen.value = true
}
</script>

<style scoped>
.scene-editor {
  position: fixed;
  inset: 0;
  background: var(--dc-screen);
  color: var(--dc-text);
  /* The grid: toolbar on top, two panel columns, the canvas in the
     middle. The canvas is the middle cell — the panels can never
     cover it, whatever their content height. */
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) 292px;
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'top   top   top'
    'left  .     right'
    'drawer drawer drawer';
  gap: var(--dc-gap);
  padding: var(--dc-gap);
}

/* The canvas fills the whole viewport (it is a WebGL surface with its
   own camera); the grid cell only decides where the panels sit. */
.scene-editor :deep(.world-canvas) {
  z-index: var(--dc-z-canvas);
}

.deck-top {
  grid-area: top;
  z-index: var(--dc-z-panel);
  min-width: 0;
}
.deck-col {
  display: flex;
  flex-direction: column;
  gap: var(--dc-gap);
  min-height: 0;
  /* A grid item's default `min-width: auto` lets its content push it
     past the track — the debug panel's long lane readout stretched the
     right column off the viewport. */
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  z-index: var(--dc-z-panel);
}
.deck-left {
  grid-area: left;
}
.deck-right {
  grid-area: right;
}

/* The simulation drawer: a horizontal strip under the map. Folded, it
   collapses to its rail so the map takes the full height. */
.deck-drawer {
  grid-area: drawer;
  z-index: var(--dc-z-panel);
  min-width: 0;
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 26%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.drawer-fold {
  align-self: flex-start;
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: var(--dc-text-dim);
  font-size: 12px;
  letter-spacing: 0.05em;
  cursor: pointer;
}
.drawer-fold:hover {
  color: var(--dc-text);
}
.drawer-body {
  flex: 1 1 auto;
  min-height: 0;
}
.deck-drawer.is-folded .drawer-body {
  display: none;
}

/* A slot holds one panel plus its fold button. Folded, the panel is
   hidden and only the button remains — a 22 px tab on the column's
   inner edge, so a folded column still says what is in it. */
/* A slot holds one panel plus its fold control. The control lives in a
   GUTTER beside the panel (never on top of it — it used to cover the
   panel's own header controls and read as a stray glyph), and folding
   the panel leaves the gutter behind, so the column still says what is
   inside it. */
.slot {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 4px;
  flex: 0 0 auto;
}
.slot-body {
  min-width: 0;
}
.slot-fold {
  width: 18px;
  height: 22px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--dc-radius);
  background: transparent;
  color: var(--dc-text-faint);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    color var(--ds-dur-fast) var(--ds-ease-out),
    background var(--ds-dur-fast) var(--ds-ease-out),
    border-color var(--ds-dur-fast) var(--ds-ease-out);
}
.slot:hover .slot-fold {
  color: var(--dc-text-dim);
  background: color-mix(in srgb, var(--dc-panel-2) 70%, transparent);
}
.slot-fold:hover {
  color: var(--dc-flow);
  border-color: color-mix(in srgb, var(--dc-flow) 45%, transparent);
}
/* Folded: the gutter is the only thing left — a thin rail of tabs. */
.slot.is-folded {
  grid-template-columns: 18px;
}
.slot.is-folded .slot-fold {
  color: var(--dc-text-dim);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  border-color: var(--dc-hairline);
}

.deck-left:has(.slot.is-folded) .slot.is-folded,
.deck-right:has(.slot.is-folded) .slot.is-folded {
  display: flex;
  justify-content: flex-start;
}

/* The "give the map the whole screen" button. */
.deck-restore {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: var(--dc-z-popover);
  padding: 10px 18px;
  border: 1px solid color-mix(in srgb, var(--dc-flow) 55%, transparent);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 92%, transparent);
  color: var(--dc-flow);
  font-size: 13px;
  letter-spacing: 0.12em;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

/* ===== responsive =====
   The columns are the first thing to go: on a narrow screen the map
   matters more than the readouts. The panels keep their fold buttons
   so the operator can bring them back. */
@media (max-width: 1500px) {
  .scene-editor {
    grid-template-columns: 232px minmax(0, 1fr) 252px;
  }
}
@media (max-width: 1180px) {
  .scene-editor {
    grid-template-columns: 0 minmax(0, 1fr) 0;
    gap: 0;
  }
  .deck-left,
  .deck-right {
    display: none;
  }
  /* The drawer's three panes stack; the drawer scrolls internally. */
  .deck-drawer :deep(.drawer) {
    grid-template-columns: 1fr;
  }
}
</style>

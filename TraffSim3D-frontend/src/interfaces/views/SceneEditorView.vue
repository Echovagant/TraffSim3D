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

    <!--
      The real layout (2026-11-07).

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
    <template v-else>
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
      </aside>

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
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
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

const bothColumnsFolded = computed(
  () =>
    !outlineOpen.value &&
    !routeOpen.value &&
    !poiOpen.value &&
    !debugOpen.value &&
    !cameraOpen.value &&
    !inspectorOpen.value,
)

const restorePanels = (): void => {
  outlineOpen.value = true
  routeOpen.value = true
  poiOpen.value = true
  debugOpen.value = true
  cameraOpen.value = true
  inspectorOpen.value = true
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
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    'top   top   top'
    'left  .     right';
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

/* A slot holds one panel plus its fold button. Folded, the panel is
   hidden and only the button remains — a 22 px tab on the column's
   inner edge, so a folded column still says what is in it. */
.slot {
  position: relative;
  flex: 0 0 auto;
}
.slot-fold {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 40%, transparent);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel-2) 90%, transparent);
  color: var(--dc-text-dim);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s ease, color 0.15s ease;
}
.slot:hover .slot-fold {
  opacity: 1;
}
.slot-fold:hover {
  color: var(--dc-flow);
  border-color: var(--dc-flow);
}
.slot.is-folded .slot-fold {
  position: static;
  opacity: 1;
}

/* A folded column collapses to a thin strip of fold buttons. */
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
}
</style>

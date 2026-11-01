<template>
  <div class="poi-panel" data-testid="poi-panel">
    <div class="head">
      <span>兴趣点 (POI)</span>
      <button
        v-if="store.pois.length > 0"
        class="ghost"
        data-testid="poi-clear-button"
        @click="store.clearPois()"
      >
        清除
      </button>
    </div>

    <div class="actions">
      <button
        class="primary"
        :disabled="store.poisLoading"
        data-testid="poi-load-button"
        @click="load"
      >
        {{ store.poisLoading ? '加载中…' : '加载兴趣点' }}
      </button>
    </div>

    <p v-if="store.pois.length === 0 && !store.poisLoading" class="muted small hint">
      来自 OpenStreetMap，无需 Key；首次加载约一分钟（之后走缓存）。
    </p>

    <p v-if="store.poiError" class="err" data-testid="poi-error">{{ store.poiError }}</p>

    <p v-else-if="store.pois.length > 0" class="muted small" data-testid="poi-count">
      {{ store.pois.length }} 个兴趣点
    </p>

    <ul v-if="store.pois.length > 0" class="poi-list" data-testid="poi-list">
      <li
        v-for="entry in store.pois"
        :key="entry.id"
        :class="{ selected: entry.id === store.poiSelectedId }"
        :data-testid="POI_ITEM_TESTID"
        @click="store.selectPoi(entry.id === store.poiSelectedId ? null : entry.id)"
      >
        <span class="dot" :style="{ background: colorOf(entry.category) }" />
        <span class="name">{{ entry.name || '(无名)' }}</span>
        <span class="cat">{{ entry.category }}</span>
      </li>
    </ul>

    <p v-if="selectedPoi" class="detail" data-testid="poi-detail">
      <b>{{ selectedPoi.name }}</b>
      <span class="muted small">{{ selectedPoi.address || '无地址' }}</span>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { poiColor } from '@infrastructure/rendering/PoiLayer'

/**
 * The POI panel.
 *
 * There is nothing to configure: the POIs come from OpenStreetMap,
 * which needs no key and no account. The source is a public service
 * and it is slow the first time — the backend caches the answer, so
 * the second load of the same rectangle is instant.
 */
const store = useWorldStore()

/** The list item's test id — bound, because `poi-item` in an attribute
 *  position is parsed as an expression by the template compiler. */
const POI_ITEM_TESTID = 'poi-item'

const load = async (): Promise<void> => {
  await store.loadPois()
}

const selectedPoi = computed(() => store.pois.find((poi) => poi.id === store.poiSelectedId) ?? null)

const colorOf = (category: string): string => `#${poiColor(category).toString(16).padStart(6, '0')}`
</script>

<style scoped>
.poi-panel {
  /* The RIGHT side, below the debug panel (top right) — the left side
     already carries the route panel (top) and the scene outline
     (bottom), and a third panel there would cover the outline's
     buttons. */
  position: absolute;
  top: 300px;
  right: 12px;
  min-width: 240px;
  max-width: 320px;
  max-height: 40vh;
  overflow-y: auto;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.poi-panel .head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 6px;
}
.poi-panel .ctrl {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: #cbd5e1;
}
.poi-panel .ctrl input {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 4px;
  padding: 3px 5px;
  font-size: 12px;
}
.poi-panel .actions {
  margin-top: 6px;
}
.poi-panel button.primary {
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  background: #2563eb;
  color: #f8fafc;
  font-size: 12px;
  cursor: pointer;
}
.poi-panel button.primary:disabled {
  background: #334155;
  cursor: not-allowed;
}
.poi-panel button.ghost {
  padding: 2px 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  background: transparent;
  color: #cbd5e1;
  font-size: 11px;
  cursor: pointer;
}
.poi-panel .err {
  color: #f87171;
  margin: 6px 0 0;
}
.poi-panel .muted {
  color: #94a3b8;
}
.poi-panel .small {
  font-size: 11px;
}
/* The hint's own width cap.
   The panel is absolutely positioned, so its width is shrink-to-fit: a
   long sentence would push the panel to its max-width (320 px) and
   cover more of the scene. Capping the paragraph keeps the panel at
   its min-width (measured: 344 px → 264 px). */
.poi-panel .hint {
  max-width: 240px;
  margin: 6px 0 0;
}
.poi-panel .poi-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}
.poi-panel .poi-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
}
.poi-panel .poi-list li:hover {
  background: rgba(148, 163, 184, 0.12);
}
.poi-panel .poi-list li.selected {
  background: rgba(37, 99, 235, 0.28);
}
.poi-panel .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.poi-panel .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poi-panel .cat {
  color: #94a3b8;
  flex: none;
}
.poi-panel .detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}
</style>

<!--
  The command-centre panel — the shared shell of every card on the
  Smart City screen.

  Grammar (from the user's own 智慧城市 project): a title in the "flow"
  colour with wide letter-spacing, an optional badge, a hairline rule
  that fades out to the right, and a body. Every colour comes from the
  `--dc-*` tokens, so a theme switch moves the whole screen at once.

  NEW in this repo's version: the panel can COLLAPSE. On a dense
  command screen the operator needs the map more than the readouts
  half the time — so the header is a button that folds the body away,
  and the collapsed card keeps just its title (so the screen never
  loses the map).
-->
<script setup lang="ts">
import { ref } from 'vue'

withDefaults(
  defineProps<{
    title: string
    /** Right-hand corner label (e.g. "实测", "12 条"). */
    badge?: string
    /** Start collapsed? */
    collapsed?: boolean
    /** Allow folding at all. */
    collapsible?: boolean
  }>(),
  { badge: '', collapsed: false, collapsible: true },
)

const isCollapsed = ref(false)
</script>

<template>
  <section class="dc-panel" :class="{ 'is-collapsed': isCollapsed }">
    <header class="dc-panel-head">
      <button
        v-if="collapsible"
        class="dc-panel-fold"
        :aria-expanded="!isCollapsed"
        :title="isCollapsed ? '展开' : '收起'"
        @click="isCollapsed = !isCollapsed"
      >
        {{ isCollapsed ? '▸' : '▾' }}
      </button>
      <h2 class="dc-panel-title">{{ title }}</h2>
      <span v-if="badge" class="dc-panel-badge">{{ badge }}</span>
      <span class="dc-panel-rule" aria-hidden="true"></span>
    </header>
    <div v-show="!isCollapsed" class="dc-panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.dc-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--dc-panel-padding);
  background: color-mix(in srgb, var(--dc-panel) 84%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 32%, transparent);
  border-radius: var(--dc-radius);
  color: var(--dc-text);
  box-shadow: 0 0 18px color-mix(in srgb, var(--dc-accent) 12%, transparent);
}
.dc-panel.is-collapsed {
  padding-bottom: 8px;
}
.dc-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.dc-panel.is-collapsed .dc-panel-head {
  margin-bottom: 0;
}
.dc-panel-fold {
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  background: color-mix(in srgb, var(--dc-accent) 30%, transparent);
  color: var(--dc-flow);
  font-size: 9px;
  line-height: 1;
}
.dc-panel-fold:hover {
  background: color-mix(in srgb, var(--dc-flow) 40%, transparent);
}
.dc-panel-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--dc-flow);
  white-space: nowrap;
}
.dc-panel-badge {
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--dc-flow) 50%, transparent);
  border-radius: var(--dc-radius);
  font-size: var(--dc-small-size);
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--dc-flow) 85%, var(--dc-panel));
  white-space: nowrap;
}
/* The hairline after the title: separates title from content without a
   background block. */
.dc-panel-rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--dc-accent) 55%, transparent),
    transparent
  );
}
.dc-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
</style>

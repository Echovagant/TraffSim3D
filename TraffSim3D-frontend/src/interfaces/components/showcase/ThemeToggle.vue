<!--
  The theme toggle — present on EVERY screen (it lives in the shared
  nav, so it is there by construction).

  One button, two states: the current theme's mark (a moon for the dark
  themes, a sun for the paper one). Clicking it switches to the other
  family and hands the click's coordinates to the theme controller, so
  the new theme is revealed with a circular wipe FROM the button — the
  interaction that makes a theme change read as a physical action.

  The heavy routes are warmed while the wipe runs, so the screen the
  user opens next is already built (SmartCity pulls a 5.3 MB Cesium
  runtime).
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@interfaces/composables/useTheme'

const { themeId, themes, setTheme } = useTheme()

/** The next theme in the rotation: the paper theme and the night ones
 *  take turns, so the button always does something visible. */
const next = computed(() => {
  const isPaper = themeId.value === 'paper'
  return isPaper ? themes.find((t) => t.id === 'deep-space') : themes.find((t) => t.id === 'paper')
})

const onToggle = (event: MouseEvent): void => {
  const target = next.value
  if (!target) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  setTheme(target.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
}
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    :title="`切换到「${next?.label ?? '浅色'}」主题`"
    :aria-label="`切换到「${next?.label ?? '浅色'}」主题`"
    data-testid="theme-toggle"
    @click="onToggle"
  >
    <svg v-if="themeId === 'paper'" viewBox="0 0 24 24" width="15" height="15" fill="none">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
        <path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
      </g>
    </svg>
    <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none">
      <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2Z" fill="currentColor" />
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  border: 1px solid var(--dc-hairline);
  background: rgba(255, 255, 255, 0.06);
  color: var(--dc-text-dim);
  cursor: pointer;
  transition:
    transform var(--ds-dur-fast) var(--ds-ease-spring),
    background var(--ds-dur-fast) var(--ds-ease-out),
    color var(--ds-dur-fast) var(--ds-ease-out),
    border-color var(--ds-dur-fast) var(--ds-ease-out);
}
.theme-toggle:hover {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--dc-hairline-strong);
}
.theme-toggle:active {
  transform: scale(0.9) rotate(-18deg);
}
/* The light theme's chrome is white, so the button's own fill has to
   follow — the rule lives in theme/panels.css, because a scoped
   `:global(:root[...])` selector compiles to a rule on the ROOT
   element itself (measured 2026-11-07: it painted the whole page
   8% black). */
</style>

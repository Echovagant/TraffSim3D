<!--
  PROTOTYPE — throwaway. The floating variant switcher (the skill's
  "floating bottom bar"): ← / label / →, keyboard ←/→, writes the
  `?variant=` URL param so a variant is shareable and reload-stable.

  Dev-only: `import.meta.env.DEV` gates it, so a stray merge can never
  ship the bar to users.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const VARIANTS = [
  { key: 'A', name: '工作台（横带）' },
  { key: 'B', name: '双列检查器' },
  { key: 'C', name: '专注画布' },
] as const

const route = useRoute()
const router = useRouter()

/** Dev-only: `import.meta` is not allowed in a template expression. */
const isDev = import.meta.env.DEV

const current = computed(() => {
  const raw = route.query.variant
  const key = Array.isArray(raw) ? raw[0] : raw
  return VARIANTS.find((v) => v.key === key)?.key ?? 'A'
})
const currentName = computed(() => VARIANTS.find((v) => v.key === current.value)?.name ?? '')

const go = (delta: number): void => {
  const i = VARIANTS.findIndex((v) => v.key === current.value)
  const next = VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length]!
  void router.replace({ query: { ...route.query, variant: next.key } })
}

const onKey = (e: KeyboardEvent): void => {
  const target = e.target as HTMLElement | null
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return
  }
  if (e.key === 'ArrowLeft') go(-1)
  if (e.key === 'ArrowRight') go(1)
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="isDev" class="switcher" data-testid="prototype-switcher">
    <button class="arrow" title="上一个变体（←）" @click="go(-1)">←</button>
    <span class="label">
      <b>{{ current }}</b>
      <span>{{ currentName }}</span>
    </span>
    <button class="arrow" title="下一个变体（→）" @click="go(1)">→</button>
  </div>
</template>

<style scoped>
.switcher {
  position: fixed;
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--dc-text);
  color: var(--dc-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.arrow {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  background: var(--dc-text);
  color: var(--dc-panel);
  font-size: 13px;
}
.arrow:hover {
  background: var(--dc-text-dim);
}
.label {
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 150px;
  justify-content: center;
}
.label b {
  font-size: 13px;
}
</style>

<!--
  A compact line chart (SVG, no chart library). Plots one or more
  series over the last N samples, with the min/max labelled — the
  "is the traffic slowing down?" readout a command screen needs.
-->
<script setup lang="ts">
import { computed } from 'vue'

export interface LineSeries {
  label: string
  values: readonly number[]
  color?: string
}

const props = withDefaults(
  defineProps<{
    series: readonly LineSeries[]
    width?: number
    height?: number
    /** Show the value range under the chart. */
    showRange?: boolean
  }>(),
  { width: 260, height: 72, showRange: true },
)

const SERIES_COLORS = [
  'var(--dc-series-3)',
  'var(--dc-series-5)',
  'var(--dc-series-2)',
  'var(--dc-series-6)',
]

const PAD = 4

const bounds = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const s of props.series) {
    for (const v of s.values) {
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 }
  if (min === max) return { min: min - 1, max: max + 1 }
  return { min, max }
})

const pathFor = (values: readonly number[]): string => {
  if (values.length < 2) return ''
  const { min, max } = bounds.value
  const span = max - min
  const stepX = (props.width - PAD * 2) / (values.length - 1)
  return values
    .map((v, i) => {
      const x = PAD + i * stepX
      const y = props.height - PAD - ((v - min) / span) * (props.height - PAD * 2)
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

const lines = computed(() =>
  props.series.map((s, i) => ({
    label: s.label,
    d: pathFor(s.values),
    color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]!,
    last: s.values.length ? s.values[s.values.length - 1]! : null,
  })),
)
</script>

<template>
  <div class="line">
    <svg :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height" role="img">
      <line
        :x1="PAD"
        :y1="height - PAD"
        :x2="width - PAD"
        :y2="height - PAD"
        stroke="color-mix(in srgb, var(--dc-accent) 30%, transparent)"
        stroke-width="1"
      />
      <path
        v-for="l in lines"
        :key="l.label"
        :d="l.d"
        fill="none"
        :stroke="l.color"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
    <div class="line-foot">
      <span v-for="l in lines" :key="l.label" class="line-item">
        <span class="dot" :style="{ background: l.color }"></span>
        <span class="name">{{ l.label }}</span>
        <b class="dc-num">{{ l.last === null ? '—' : l.last.toFixed(1) }}</b>
      </span>
      <span v-if="showRange" class="range dc-num">
        {{ bounds.min.toFixed(1) }}–{{ bounds.max.toFixed(1) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.line {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.line svg {
  width: 100%;
  height: auto;
  overflow: visible;
}
.line-foot {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: var(--dc-small-size);
  color: var(--dc-text-dim);
  flex-wrap: wrap;
}
.line-item {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
}
.line-item b {
  color: var(--dc-text);
  font-weight: 600;
}
.range {
  margin-left: auto;
  color: var(--dc-text-faint);
}
</style>

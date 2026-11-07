<!--
  A small donut chart (SVG, no chart library — the repo has none and
  does not need one for four slices). Segments carry their own value;
  the legend lives beside it.
-->
<script setup lang="ts">
import { computed } from 'vue'

export interface DonutSlice {
  label: string
  value: number
  color?: string
}

const props = withDefaults(
  defineProps<{
    slices: readonly DonutSlice[]
    size?: number
    thickness?: number
    /** Centre label (the total). */
    caption?: string
  }>(),
  { size: 92, thickness: 13, caption: '' },
)

const SERIES = [
  'var(--dc-series-1)',
  'var(--dc-series-2)',
  'var(--dc-series-3)',
  'var(--dc-series-4)',
  'var(--dc-series-5)',
  'var(--dc-series-6)',
]

const total = computed(() => props.slices.reduce((n, s) => n + Math.max(0, s.value), 0))

/** Dash offsets per slice (the stroke-dash trick: each arc is the full
 *  circle, trimmed to its share and offset around the ring). */
const dash = computed(() => {
  const r = (props.size - props.thickness) / 2
  const circumference = 2 * Math.PI * r
  const sum = total.value
  if (sum <= 0) return []
  let acc = 0
  return props.slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / sum) * circumference
      const out = { len, offset: acc, color: '' }
      acc += len
      return out
    })
})

const legend = computed(() => {
  const sum = total.value
  return props.slices.map((s, i) => ({
    label: s.label,
    value: s.value,
    pct: sum > 0 ? Math.round((s.value / sum) * 100) : 0,
    color: s.color ?? SERIES[i % SERIES.length]!,
  }))
})
</script>

<template>
  <div class="donut">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img">
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="(size - thickness) / 2"
        fill="none"
        :stroke="`color-mix(in srgb, var(--dc-accent) 22%, transparent)`"
        :stroke-width="thickness"
      />
      <circle
        v-for="(d, i) in dash"
        :key="i"
        :cx="size / 2"
        :cy="size / 2"
        :r="(size - thickness) / 2"
        fill="none"
        :stroke="legend[i]?.color"
        :stroke-width="thickness"
        :stroke-dasharray="`${d.len} ${(2 * Math.PI * (size - thickness)) / 2 - d.len}`"
        :stroke-dashoffset="-d.offset"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        stroke-linecap="butt"
      />
      <text
        v-if="caption"
        :x="size / 2"
        :y="size / 2 + 4"
        text-anchor="middle"
        class="donut-caption"
      >
        {{ caption }}
      </text>
    </svg>
    <ul class="legend">
      <li v-for="l in legend" :key="l.label">
        <span class="swatch" :style="{ background: l.color }"></span>
        <span class="name">{{ l.label }}</span>
        <b class="dc-num">{{ l.value }}</b>
        <em class="dc-num">{{ l.pct }}%</em>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.donut {
  display: flex;
  align-items: center;
  gap: 12px;
}
.donut-caption {
  fill: var(--dc-text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}
.legend li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
}
.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
.name {
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.legend b {
  color: var(--dc-text);
  font-weight: 600;
}
.legend em {
  font-style: normal;
  color: var(--dc-text-faint);
  min-width: 30px;
  text-align: right;
}
</style>

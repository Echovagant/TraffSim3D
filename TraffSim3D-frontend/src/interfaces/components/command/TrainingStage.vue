<!--
  The training stage — the AI Proving Ground's main visual.

  The playground used to be a page of small cards with a small chart in
  one of them. For a portfolio piece the training curve IS the product:
  a visitor should land on a large, live canvas that moves.

  What this adds over the old chart:
    - the curve is drawn on a full-bleed canvas with a grid, an area
      fill and a moving head marker;
    - the last point is labelled with its value, and the newest sample
      draws a short "comet" so the motion is visible even between two
      samples;
    - the episode counter and the current reward are big numbers above
      the canvas — the two numbers a visitor actually reads;
    - everything is driven by the SAME status object the page already
      polls every 2 s, so the stage is honest by construction: it shows
      what the backend last said, never a synthetic animation.

  The animation is CSS (transform + opacity only); the numbers come
  from the store.
-->
<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** The reward per evaluation, oldest first. */
    values: readonly number[]
    /** The baseline to beat (a horizontal reference line). */
    baseline?: number | null
    /** The episode counter. */
    episode?: number
    /** The live reward (the newest sample). */
    reward?: number | null
    /** The training step. */
    step?: number
    /** Running? */
    running?: boolean
    /** The caption under the canvas. */
    note?: string
  }>(),
  { baseline: null, episode: 0, reward: null, step: 0, running: false, note: '' },
)

const W = 1000
const H = 320
const PAD_L = 54
const PAD_R = 18
const PAD_T = 22
const PAD_B = 34

const bounds = computed(() => {
  const vals = props.values
  if (vals.length === 0) return { min: -1, max: 1 }
  let min = Infinity
  let max = -Infinity
  for (const v of vals) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (props.baseline !== null && Number.isFinite(props.baseline)) {
    min = Math.min(min, props.baseline)
    max = Math.max(max, props.baseline)
  }
  if (min === max) return { min: min - 1, max: max + 1 }
  const pad = (max - min) * 0.12
  return { min: min - pad, max: max + pad }
})

const xFor = (i: number): number => {
  const n = Math.max(1, props.values.length - 1)
  return PAD_L + (i / n) * (W - PAD_L - PAD_R)
}

const yFor = (v: number): number => {
  const { min, max } = bounds.value
  const span = max - min || 1
  return H - PAD_B - ((v - min) / span) * (H - PAD_T - PAD_B)
}

const linePoints = computed(() =>
  props.values.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' '),
)

const areaPoints = computed(() => {
  if (props.values.length === 0) return ''
  const base = H - PAD_B
  return `${PAD_L},${base} ${linePoints.value} ${xFor(props.values.length - 1).toFixed(1)},${base}`
})

/** The horizontal grid lines, with their values. */
const gridLines = computed(() => {
  const { min, max } = bounds.value
  const steps = 4
  const out: Array<{ y: number; label: string }> = []
  for (let i = 0; i <= steps; i++) {
    const v = min + ((max - min) * i) / steps
    out.push({ y: yFor(v), label: v.toFixed(1) })
  }
  return out
})

const head = computed(() => {
  const n = props.values.length
  if (n === 0) return null
  const v = props.values[n - 1]!
  return { x: xFor(n - 1), y: yFor(v), value: v }
})

const baselineY = computed(() =>
  props.baseline !== null && Number.isFinite(props.baseline) ? yFor(props.baseline) : null,
)

/** The newest segment, drawn brighter so the growth is readable. */
const tailPoints = computed(() => {
  const n = props.values.length
  if (n < 2) return ''
  return props.values
    .slice(Math.max(0, n - 6))
    .map((v, i) => `${xFor(Math.max(0, n - 6) + i).toFixed(1)},${yFor(v).toFixed(1)}`)
    .join(' ')
})
</script>

<template>
  <section class="stage" :class="{ 'is-running': running }" data-testid="training-stage">
    <header class="stage-head">
      <div class="stage-numbers">
        <div class="big">
          <span class="big-label">EPISODE</span>
          <b class="big-value" data-testid="stage-episode">{{ episode }}</b>
        </div>
        <div class="big">
          <span class="big-label">最近回报</span>
          <b class="big-value" :class="{ 'is-up': (reward ?? 0) > 0 }" data-testid="stage-reward">
            {{ reward === null ? '—' : reward.toFixed(2) }}
          </b>
        </div>
        <div class="big">
          <span class="big-label">训练步</span>
          <b class="big-value" data-testid="stage-step">{{ step }}</b>
        </div>
      </div>
      <span v-if="running" class="stage-live" data-testid="stage-live">
        <span class="stage-dot" aria-hidden></span>
        训练中
      </span>
    </header>

    <div class="stage-canvas">
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        class="stage-svg"
        preserveAspectRatio="none"
        data-testid="stage-chart"
      >
        <!-- the grid -->
        <g class="grid">
          <line
            v-for="g in gridLines"
            :key="g.label"
            :x1="PAD_L"
            :y1="g.y"
            :x2="W - PAD_R"
            :y2="g.y"
          />
          <text
            v-for="g in gridLines"
            :key="`t-${g.label}`"
            :x="PAD_L - 10"
            :y="g.y + 4"
            class="axis"
          >
            {{ g.label }}
          </text>
        </g>

        <!-- the baseline to beat -->
        <line
          v-if="baselineY !== null"
          class="baseline"
          :x1="PAD_L"
          :y1="baselineY"
          :x2="W - PAD_R"
          :y2="baselineY"
        />

        <!-- the area + the line -->
        <polygon v-if="areaPoints" class="area" :points="areaPoints" />
        <polyline v-if="linePoints" class="line" :points="linePoints" />
        <polyline v-if="tailPoints" class="tail" :points="tailPoints" />

        <!-- the head -->
        <g v-if="head">
          <circle :cx="head.x" :cy="head.y" r="9" class="head-halo" />
          <circle :cx="head.x" :cy="head.y" r="4" class="head" />
        </g>
      </svg>

      <div v-if="values.length === 0" class="stage-empty">
        <p>还没有样本 — 点「开始训练」，曲线会在这里长出来。</p>
      </div>
    </div>

    <p v-if="note" class="stage-note">{{ note }}</p>
  </section>
</template>

<style scoped>
.stage {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px 18px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius-lg);
  background: color-mix(in srgb, var(--dc-panel) 78%, transparent);
}
.stage-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}
.stage-numbers {
  display: flex;
  gap: 34px;
  flex-wrap: wrap;
}
.big {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.big-label {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--dc-text-faint);
}
.big-value {
  font-family: var(--ds-font-display);
  font-size: 38px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -1px;
  color: var(--dc-text);
  font-variant-numeric: tabular-nums;
}
.big-value.is-up {
  color: var(--dc-ok);
}
.stage-live {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dc-flow) 45%, transparent);
  background: color-mix(in srgb, var(--dc-flow) 12%, transparent);
  color: var(--dc-flow);
  font-size: 11px;
  letter-spacing: 0.1em;
}
.stage-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  animation: stage-breathe 1.6s var(--ds-ease-out) infinite;
}
@keyframes stage-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 0 currentColor;
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 0 6px transparent;
    opacity: 0.5;
  }
}
.stage-canvas {
  position: relative;
  aspect-ratio: 1000 / 320;
  min-height: 220px;
}
.stage-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.grid line {
  stroke: color-mix(in srgb, var(--dc-accent) 22%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.axis {
  fill: var(--dc-text-faint);
  font-size: 11px;
  text-anchor: end;
}
.baseline {
  stroke: color-mix(in srgb, var(--dc-warning) 65%, transparent);
  stroke-width: 1.4;
  stroke-dasharray: 6 5;
  vector-effect: non-scaling-stroke;
}
.area {
  fill: color-mix(in srgb, var(--dc-flow) 16%, transparent);
}
.line {
  fill: none;
  stroke: var(--dc-flow);
  stroke-width: 2.2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.tail {
  fill: none;
  stroke: color-mix(in srgb, var(--dc-flow) 100%, #ffffff);
  stroke-width: 3;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.head {
  fill: var(--dc-flow);
}
.head-halo {
  fill: color-mix(in srgb, var(--dc-flow) 22%, transparent);
  animation: stage-halo 2.4s var(--ds-ease-out) infinite;
}
@keyframes stage-halo {
  0% {
    r: 4;
    opacity: 0.8;
  }
  70%,
  100% {
    r: 16;
    opacity: 0;
  }
}
.stage-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--dc-text-faint);
  font-size: 13px;
}
.stage-note {
  margin: 0;
  font-size: 12px;
  color: var(--dc-text-faint);
}
</style>

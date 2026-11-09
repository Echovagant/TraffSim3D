<!--
  The driving cluster — the cockpit's instrument panel.

  Hand-drawn SVG (the repo has no chart library and needs none for a
  dial). It answers, in one glance, the three questions a driver asks
  while driving:

    how fast am I going (the dial, with the road's limit marked),
    what is the car doing (the gear ladder: parked / held / forward),
    what am I asking it to do (the two pedal bars).

  The gear ladder is NOT a gearbox — the simulation has none, and a
  fake gear would be a lie about the model. It maps the states the
  simulation actually has: P (parked), N (held — a red light or a
  queue), D (forward). The pedals are the real intent: they are the
  same pedal the tick reads.
-->
<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** The vehicle's speed, m/s. */
    speedMps: number
    /** The road's speed limit, m/s (the dial's marked ceiling). */
    limitMps: number
    /** The pedal the driver is holding, or null for hands-off. */
    pedal?: 'accel' | 'brake' | null
    /** The vehicle's traffic state. */
    status?: 'driving' | 'waiting' | 'crashed'
    /** The signal ahead: its phase name, the seconds left, and the
     *  metres to it. Null when the road ahead has no light. */
    signal?: { label: string; remainingS: number; distanceM: number; tone: 'go' | 'warn' | 'stop' } | null
    /** The steering angle in degrees — how far the car points away
     *  from its lane. Positive is a right turn. */
    steerDeg?: number
    size?: number
  }>(),
  { pedal: null, status: 'driving', signal: null, steerDeg: 0, size: 104 },
)

// The dial's geometry: a 270° sweep from the lower left, clockwise
// through the top, to the lower right.
const CX = 50
const CY = 50
const R = 38
const START = 225
const SWEEP = 270

/** The dial's full scale: the road limit, with 40% of headroom so the
 *  needle still has somewhere to go when a car overspeeds. */
const maxMps = computed(() => Math.max(8, props.limitMps * 1.4))

const polar = (angleDeg: number, radius: number): { x: number; y: number } => {
  const a = ((angleDeg - 90) * Math.PI) / 180
  return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) }
}

const describeArc = (from: number, to: number, radius: number): string => {
  const p1 = polar(from, radius)
  const p2 = polar(to, radius)
  const largeArc = to - from > 180 ? 1 : 0
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
}

const ratio = computed(() => Math.max(0, Math.min(1.08, props.speedMps / maxMps.value)))
const valueAngle = computed(() => START + SWEEP * ratio.value)
const limitAngle = computed(() => START + SWEEP * Math.min(1, props.limitMps / maxMps.value))

const valueArc = computed(() =>
  props.speedMps <= 0.2 ? '' : describeArc(START, valueAngle.value, R),
)

const needle = computed(() => {
  const tip = polar(valueAngle.value, R - 7)
  return { x: tip.x.toFixed(2), y: tip.y.toFixed(2) }
})

const limitTick = computed(() => {
  const a = polar(limitAngle.value, R + 5)
  const b = polar(limitAngle.value, R + 9)
  return { x1: a.x.toFixed(2), y1: a.y.toFixed(2), x2: b.x.toFixed(2), y2: b.y.toFixed(2) }
})

const speedKmh = computed(() => Math.round(Math.abs(props.speedMps) * 3.6))
const limitKmh = computed(() => Math.round(props.limitMps * 3.6))
const overLimit = computed(() => props.speedMps > props.limitMps + 0.5)

/** The gear ladder: the simulation's three driving states. */
const gear = computed(() => {
  if (props.status === 'crashed') return 'D'
  if (Math.abs(props.speedMps) < 0.5) return 'P'
  if (props.status === 'waiting') return 'N'
  return 'D'
})

const stateLabel = computed(() => {
  if (props.status === 'crashed') return '碰撞'
  if (Math.abs(props.speedMps) < 0.5) return '停车'
  if (props.status === 'waiting') return '等待'
  return '行驶'
})

const stateKind = computed(() => {
  if (props.status === 'crashed') return 'alert'
  if (props.status === 'waiting') return 'warn'
  return 'ok'
})

/** The signal's countdown, in whole seconds. */
const signalSeconds = computed(() =>
  props.signal ? Math.max(0, Math.round(props.signal.remainingS)) : 0,
)

/**
 * The steering wheel's angle.
 *
 * The wheel turns by the car's heading error against its lane — the
 * same cross-track the lane guard watches. A cap keeps it a wheel and
 * not a spinner: a real steering wheel travels about 500° lock to
 * lock, and the model's lane-keeping never asks for more than a
 * fraction of that.
 */
const steerRotation = computed(() => {
  const deg = Math.max(-140, Math.min(140, props.steerDeg))
  return deg.toFixed(1)
})
</script>

<template>
  <div class="gauge" data-testid="drive-gauge">
    <svg :width="size" :height="size" viewBox="0 0 100 100" role="img" aria-label="车速表">
      <!-- the track -->
      <path
        :d="describeArc(START, START + SWEEP, R)"
        fill="none"
        stroke="color-mix(in srgb, var(--dc-accent) 20%, transparent)"
        stroke-width="7"
        stroke-linecap="round"
      />
      <!-- the value -->
      <path
        v-if="valueArc"
        :d="valueArc"
        fill="none"
        :stroke="overLimit ? 'var(--dc-alert)' : 'var(--dc-accent)'"
        stroke-width="7"
        stroke-linecap="round"
      />
      <!-- the road limit -->
      <line
        :x1="limitTick.x1"
        :y1="limitTick.y1"
        :x2="limitTick.x2"
        :y2="limitTick.y2"
        stroke="var(--dc-warning)"
        stroke-width="2.4"
        stroke-linecap="round"
      />
      <!-- the needle -->
      <line
        :x1="CX"
        :y1="CY"
        :x2="needle.x"
        :y2="needle.y"
        :stroke="overLimit ? 'var(--dc-alert)' : 'var(--dc-text)'"
        stroke-width="2"
        stroke-linecap="round"
      />
      <circle :cx="CX" :cy="CY" r="3.2" fill="var(--dc-text)" />
    </svg>

    <div class="readout">
      <div class="speed">
        <b class="dc-num" data-testid="gauge-speed">{{ speedKmh }}</b>
        <span>km/h</span>
      </div>
      <div class="meta">
        <span class="state" :class="stateKind" data-testid="gauge-state">{{ stateLabel }}</span>
        <span class="limit">限速 <b class="dc-num">{{ limitKmh }}</b></span>
      </div>
    </div>

    <div class="signal" :class="signal?.tone ?? 'none'" data-testid="gauge-signal">
      <span class="lamp"></span>
      <template v-if="signal">
        <b>{{ signal.label }}</b>
        <span class="count dc-num">{{ signalSeconds }}s</span>
        <span class="dist dc-num">{{ Math.round(signal.distanceM) }}m</span>
      </template>
      <template v-else>
        <b>无信号</b>
      </template>
    </div>

    <!-- The steering wheel: it turns by the car's heading error
         against its lane — the same quantity the lane guard watches. -->
    <svg class="wheel" viewBox="0 0 60 60" role="img" aria-label="方向盘">
      <circle cx="30" cy="30" r="25" fill="none" stroke="currentColor" stroke-width="3.4" />
      <circle cx="30" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="3" />
      <g :transform="`rotate(${steerRotation} 30 30)`">
        <line x1="30" y1="30" x2="30" y2="8" stroke="currentColor" stroke-width="3" />
        <line x1="30" y1="30" x2="14" y2="44" stroke="currentColor" stroke-width="3" />
        <line x1="30" y1="30" x2="46" y2="44" stroke="currentColor" stroke-width="3" />
      </g>
    </svg>

    <div class="gears" aria-label="档位">
      <span v-for="g in ['P', 'N', 'D']" :key="g" class="gear" :class="{ on: gear === g }">
        {{ g }}
      </span>
    </div>

    <div class="pedals">
      <div class="pedal" :class="{ on: pedal === 'accel' }" data-testid="gauge-accel">加速</div>
      <div class="pedal brake" :class="{ on: pedal === 'brake' }" data-testid="gauge-brake">刹车</div>
    </div>
  </div>
</template>

<style scoped>
.gauge {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--dc-radius);
  background: var(--dc-chrome);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 30%, transparent);
  pointer-events: auto;
}
.readout {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 92px;
}
.speed {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.speed b {
  font-size: 26px;
  font-weight: 650;
  line-height: 1;
  color: var(--dc-text);
}
.speed span {
  font-size: 11px;
  color: var(--dc-text-faint);
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--dc-label-size);
  color: var(--dc-text-dim);
}
.state {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
}
.state.ok {
  color: var(--dc-ok);
  background: color-mix(in srgb, var(--dc-ok) 16%, transparent);
}
.state.warn {
  color: var(--dc-warning);
  background: color-mix(in srgb, var(--dc-warning) 16%, transparent);
}
.state.alert {
  color: var(--dc-alert);
  background: color-mix(in srgb, var(--dc-alert) 16%, transparent);
}
.limit b {
  color: var(--dc-text);
  font-weight: 600;
}
.signal {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--dc-text-faint);
  min-width: 78px;
}
.signal b {
  font-weight: 600;
}
.signal .count {
  color: var(--dc-text);
}
.signal .dist {
  color: var(--dc-text-faint);
}
.signal .lamp {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--dc-text-faint) 40%, transparent);
}
.signal.go {
  color: var(--dc-ok);
}
.signal.go .lamp {
  background: var(--dc-ok);
  box-shadow: 0 0 7px color-mix(in srgb, var(--dc-ok) 70%, transparent);
}
.signal.warn {
  color: var(--dc-warning);
}
.signal.warn .lamp {
  background: var(--dc-warning);
  box-shadow: 0 0 7px color-mix(in srgb, var(--dc-warning) 70%, transparent);
}
.signal.stop {
  color: var(--dc-alert);
}
.signal.stop .lamp {
  background: var(--dc-alert);
  box-shadow: 0 0 7px color-mix(in srgb, var(--dc-alert) 70%, transparent);
}
.wheel {
  width: 46px;
  height: 46px;
  color: var(--dc-text-dim);
  flex-shrink: 0;
}
.gears {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 22%, transparent);
}
.gear {
  width: 22px;
  height: 17px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dc-text-faint);
}
.gear.on {
  color: var(--dc-screen);
  background: var(--dc-accent);
}
/* The pedals: the bars grow with the intent. */
.pedals {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 54px;
}
.pedal {
  height: 17px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--dc-text-faint);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 22%, transparent);
  transition:
    background 120ms ease,
    color 120ms ease;
}
.pedal.on {
  color: var(--dc-screen);
  background: var(--dc-ok);
  border-color: transparent;
}
.pedal.brake.on {
  background: var(--dc-alert);
}
</style>

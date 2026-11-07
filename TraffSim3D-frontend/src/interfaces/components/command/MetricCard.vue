<!--
  A single metric: label + value + unit. The number is tabular so the
  readout does not jitter while it ticks.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    value: string | number
    unit?: string
    /** Small note under the value ("实测", "较上帧 +2"). */
    hint?: string
    /** Emphasise the value (live data). */
    live?: boolean
  }>(),
  { unit: '', hint: '', live: false },
)
</script>

<template>
  <div class="metric">
    <span class="metric-label">{{ label }}</span>
    <span class="metric-value" :class="{ live }">
      {{ value }}<em v-if="unit">{{ unit }}</em>
    </span>
    <span v-if="hint" class="metric-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 22%, transparent);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel-2) 70%, transparent);
}
.metric-label {
  font-size: var(--dc-small-size);
  letter-spacing: 0.1em;
  color: var(--dc-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metric-value {
  font-size: var(--dc-metric-size);
  font-weight: 600;
  line-height: 1.15;
  color: var(--dc-text);
  font-variant-numeric: tabular-nums;
}
.metric-value.live {
  color: var(--dc-flow);
  text-shadow: 0 0 14px color-mix(in srgb, var(--dc-flow) 35%, transparent);
}
.metric-value em {
  margin-left: 3px;
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  color: var(--dc-text-dim);
}
.metric-hint {
  font-size: var(--dc-small-size);
  color: var(--dc-text-faint);
}
</style>

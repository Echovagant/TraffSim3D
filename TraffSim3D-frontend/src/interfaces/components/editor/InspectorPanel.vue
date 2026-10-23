<template>
  <div v-if="entity" class="inspector">
    <header>
      <span class="kind">{{ selection.kind }}</span>
      <span class="id">#{{ selection.id }}</span>
      <button class="ghost" title="取消选中 (Esc)" @click="deselect">✕</button>
      <button class="danger" title="删除实体 (Delete)" @click="deleteSelected">🗑</button>
    </header>
    <div v-if="selection.kind === 'vehicle'">
      <label
        >Color
        <input
          type="color"
          :value="(entity as Vehicle).color"
          @change="updateColor(($event.target as HTMLInputElement).value)"
      /></label>
      <label
        >Type
        <select
          :value="(entity as Vehicle).type"
          @change="
            updateType(($event.target as HTMLSelectElement).value as 'car' | 'truck' | 'bus')
          "
        >
          <option value="car">car</option>
          <option value="truck">truck</option>
          <option value="bus">bus</option>
        </select>
      </label>
      <label
        >Speed (km/h)
        <input
          type="number"
          :value="Speed.toKmh((entity as Vehicle).speed).toFixed(0)"
          min="0"
          max="120"
          :disabled="speedOwnedByReplay"
          :title="speedTitle"
          data-testid="speed-input"
          @change="updateSpeed(Number(($event.target as HTMLInputElement).value))"
      /></label>
      <!--
        A pinned speed survives ticks (the store re-applies it after
        every `tick()`), so the Inspector says so explicitly instead of
        letting the user believe the number is a momentary nudge.
      -->
      <div v-if="hasSpeedOverride" class="override-row" data-testid="speed-override">
        <span>已锁定 {{ overrideKmh }} km/h（不受信号灯约束）</span>
        <button class="ghost" title="解除速度锁定" @click="releaseSpeed">解除</button>
      </div>
      <label
        >Lane <b>{{ laneDisplay }}</b></label
      >
      <div class="lane-actions">
        <button
          class="ghost"
          :disabled="!canChangeLaneLeft"
          :title="canChangeLaneLeft ? '向左变道' : '已在最左道'"
          @click="onChangeLane('left')"
        >
          ◀ Change Lane
        </button>
        <button
          class="ghost"
          :disabled="!canChangeLaneRight"
          :title="canChangeLaneRight ? '向右变道' : '已在最右道'"
          @click="onChangeLane('right')"
        >
          Change Lane ▶
        </button>
      </div>
    </div>
    <div v-else-if="selection.kind === 'light'">
      <!--
        The phase is **owned by the signal controller**: `tick()` runs
        the per-light controller every frame and overwrites whatever
        was written here. Editing it was a one-frame lie (the light
        went back to red within ~2 s), so the field is read-only and
        says who owns it. The toolbar's 全红 button is the supported
        way to override the signals.
      -->
      <label
        >Phase <b class="readonly" data-testid="phase-readonly">{{ phaseLabel }}</b></label
      >
      <p class="hint">相位由信号控制器决定，编辑器不可直接改写。</p>
      <label
        >Axis
        <select
          :value="(entity as TrafficLight).axis"
          @change="updateAxis(($event.target as HTMLSelectElement).value as 'ns' | 'ew')"
        >
          <option value="ns">ns</option>
          <option value="ew">ew</option>
        </select>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditor } from '@interfaces/composables/useEditor'
import { Speed } from '@domain/value-objects/Speed'
import { _flashMessageRef } from '@interfaces/composables/useFlashMessage'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { TrafficLight } from '@domain/entities/TrafficLight'

const { world, selection } = useEditor(ref(null))

const entity = computed(() => {
  // Read tickCount so this computed re-evaluates after any worldStore mutation.
  void world.tickCount
  if (!selection.id || !selection.kind) return null
  if (selection.kind === 'vehicle') return world.network.vehicles[selection.id] ?? null
  if (selection.kind === 'light') {
    for (const inter of Object.values(world.network.intersections)) {
      const found = inter.trafficLights.find((l) => l.id === selection.id)
      if (found) return found
    }
  }
  return null
})

const laneDisplay = computed(() => {
  if (selection.kind !== 'vehicle' || !entity.value) return '—'
  const v = entity.value as Vehicle
  const road = world.network.roads[v.roadId]
  if (!road) return `${v.laneIndex}`
  return `${v.laneIndex} / 0–${road.laneCount - 1}`
})

const canChangeLaneLeft = computed(() => {
  if (selection.kind !== 'vehicle' || !entity.value) return false
  const v = entity.value as Vehicle
  // Lane 0 is the rightmost (slow) lane by convention (see
  // laneGeometry.ts: laneForwardSign). "Left" = higher index
  // (toward center of road). UI here is informal; a real action
  // will replace it.
  return v.laneIndex > 0
})
const canChangeLaneRight = computed(() => {
  if (selection.kind !== 'vehicle' || !entity.value) return false
  const v = entity.value as Vehicle
  const road = world.network.roads[v.roadId]
  if (!road) return false
  return v.laneIndex < road.laneCount - 1
})

const flash = _flashMessageRef
const onChangeLane = (dir: 'left' | 'right'): void => {
  if (selection.kind === 'vehicle' && selection.id) {
    const r = world.requestLaneChange(selection.id, dir)
    if (r.ok) {
      flash.value = { text: `变道: ${dir === 'left' ? '左' : '右'}`, level: 'info', ts: Date.now() }
    } else {
      flash.value = { text: `变道拒绝: ${r.reason ?? 'unknown'}`, level: 'error', ts: Date.now() }
    }
  }
}

/**
 * The pinned speed of the selected vehicle (m/s) — `null` when the
 * vehicle is not pinned. Read from the store on every tick so the
 * "已锁定" badge appears / disappears with the pin.
 */
const speedOverrideMps = computed(() => {
  void world.tickCount
  if (selection.kind !== 'vehicle' || !selection.id) return null
  return world.getVehicleSpeedOverride(selection.id)
})
const hasSpeedOverride = computed(() => speedOverrideMps.value !== null)
const overrideKmh = computed(() =>
  speedOverrideMps.value === null ? '—' : String(Math.round(Speed.toKmh(speedOverrideMps.value))),
)

/**
 * While a policy replay is running the replay target's speed belongs
 * to the policy (the Python contract compares that state bit-for-bit),
 * so the field is disabled instead of silently doing nothing.
 */
const speedOwnedByReplay = computed(() => world.replayActive)

const speedTitle = computed(() =>
  speedOwnedByReplay.value
    ? '重放中：速度由 policy 决定，不能改写'
    : hasSpeedOverride.value
      ? '锁定速度：车辆保持该速度，直到点「解除」'
      : '设定速度（车辆将被锁定在该速度）',
)

const deselect = (): void => {
  selection.clear()
}

const updateColor = (color: string) => {
  if (selection.kind === 'vehicle' && entity.value && 'color' in entity.value) {
    ;(entity.value as { color: string }).color = color
    world.notifyChange()
  }
}
const updateType = (type: 'car' | 'truck' | 'bus') => {
  if (selection.kind === 'vehicle' && entity.value) {
    const v = entity.value as Vehicle
    if (v.type === type) return
    world.updateVehicleType(v.id, type)
    world.notifyChange()
  }
}
const updateSpeed = (kmh: number) => {
  if (selection.kind === 'vehicle' && entity.value) {
    const v = entity.value as Vehicle
    world.setVehicleSpeed(v.id, kmh)
    world.notifyChange()
  }
}

/** Release the speed pin — the vehicle returns to the road's limit. */
const releaseSpeed = (): void => {
  if (selection.kind === 'vehicle' && selection.id) {
    world.clearVehicleSpeedOverride(selection.id)
    world.notifyChange()
  }
}

/** The phase of the selected light, as a readable label. */
const phaseLabel = computed(() => {
  if (selection.kind !== 'light' || !entity.value) return '—'
  return (entity.value as TrafficLight).phase
})
const updateAxis = (axis: 'ns' | 'ew') => {
  if (selection.kind === 'light' && entity.value) {
    ;(entity.value as { axis: 'ns' | 'ew' }).axis = axis
    world.notifyChange()
  }
}
const deleteSelected = () => {
  if (selection.kind === 'vehicle' && selection.id) world.removeVehicle(selection.id)
  else if (selection.kind === 'light' && selection.id) world.removeTrafficLight(selection.id)
  selection.clear()
}
</script>

<style scoped>
.inspector {
  /* Right column, below the DebugPanel. The DebugPanel is ~140px tall;
   * this offset is its top (12) + height + 16 gap, rounded. */
  position: absolute;
  top: 168px;
  right: 12px;
  width: 240px;
  padding: 10px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.inspector header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.inspector .kind {
  text-transform: uppercase;
  font-size: 10px;
  opacity: 0.7;
}
.inspector .id {
  flex: 1;
  font-weight: 600;
}
.inspector label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
}
.inspector input,
.inspector select {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 11px;
}
.inspector .lane-actions {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
.inspector .lane-actions button {
  flex: 1;
}
/* Speed-pin badge: the vehicle is pinned at this speed until the
 * user releases it. */
.inspector .override-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin: -2px 0 6px;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(180, 83, 9, 0.25);
  border: 1px solid #b45309;
  color: #fde68a;
  font-size: 10px;
}
.inspector .override-row button {
  padding: 1px 5px;
  background: #1e293b;
}
/* Read-only value (the signal controller owns the phase). */
.inspector .readonly {
  color: #94a3b8;
  font-weight: 600;
  text-transform: none;
}
.inspector .hint {
  margin: -2px 0 6px;
  font-size: 10px;
  opacity: 0.65;
  line-height: 1.4;
}
.inspector button {
  padding: 3px 6px;
  background: #1e293b;
  color: #f1f5f9;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
}
.inspector button.ghost {
  background: transparent;
  opacity: 0.6;
}
.inspector button.ghost:hover {
  background: rgba(148, 163, 184, 0.15);
  opacity: 1;
}
.inspector button.danger {
  background: #7f1d1d;
}
.inspector button.danger:hover {
  background: #991b1b;
}
</style>

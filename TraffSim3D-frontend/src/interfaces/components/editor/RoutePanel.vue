<template>
  <div class="route-panel" data-testid="route-panel">
    <div class="head">
      <span>路线规划</span>
      <button
        v-if="store.plannedRoute"
        class="ghost"
        data-testid="clear-route-button"
        @click="store.clearRoute()"
      >
        清除
      </button>
    </div>

    <label class="ctrl">
      起点车辆
      <select v-model="startVehicleId" data-testid="route-start-vehicle">
        <option v-for="v in vehicles" :key="v.id" :value="v.id">{{ v.id }} · {{ v.roadId }}</option>
      </select>
    </label>

    <label class="ctrl">
      终点路口
      <select v-model="endJunctionId" data-testid="route-end-junction">
        <option v-for="j in junctions" :key="j.id" :value="j.id">{{ j.id }}</option>
      </select>
    </label>

    <div class="actions">
      <button
        class="primary"
        :disabled="planning || !startVehicleId || !endJunctionId"
        data-testid="plan-route-button"
        @click="plan"
      >
        {{ planning ? '规划中…' : '规划路线' }}
      </button>
    </div>

    <p v-if="error" class="err" data-testid="route-error">{{ error }}</p>

    <!-- Scene 4: the unsignalised junction's negotiation. Only on its
         own scene — the policy's drivers, routes and conflict point are
         that scenario's. -->
    <div v-if="isJunctionScene" class="hud" data-testid="drive-policy-panel">
      <div class="head">
        <span>无信号协商</span>
      </div>
      <label class="ctrl toggle">
        <input
          type="checkbox"
          data-testid="drive-policy-checkbox"
          :checked="store.driveEnabled"
          @change="onToggleDrive"
        />
        RL 驾驶（3 辆协商）
      </label>
      <div v-if="store.driveEnabled" class="rows">
        <div v-for="entry in driveReadout" :key="entry.id" class="row">
          <span>{{ entry.id }}</span>
          <b :class="{ arrived: entry.arrived }" data-testid="drive-driver">{{ entry.label }}</b>
        </div>
      </div>
    </div>

    <!-- The driving readout. It is here, and not in the toolbar, because
         in the first-person camera this panel IS the instrument panel. -->
    <div v-if="store.plannedRoute" class="hud" data-testid="route-hud">
      <div class="row">
        <span>目标</span>
        <b>{{ store.plannedRoute.destinationJunctionId }}</b>
      </div>
      <div class="row">
        <span>速度</span>
        <b data-testid="route-hud-speed">{{ speedKmh }} km/h</b>
      </div>
      <div class="row">
        <span>进度</span>
        <b data-testid="route-hud-progress">{{ Math.round(progress * 100) }} %</b>
      </div>
      <div class="row">
        <span>下一段</span>
        <b data-testid="route-hud-next">{{ nextRoad ?? '已到达' }}</b>
      </div>
      <label class="ctrl toggle">
        <input
          v-model="followCamera"
          type="checkbox"
          data-testid="follow-camera-checkbox"
          @change="onToggleFollow"
        />
        第一人称视角
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { showFlashMessage } from '@interfaces/composables/useFlashMessage'

/**
 * The route planner.
 *
 * A route is planned for **one** vehicle: the vehicle drives the
 * route's roads in order, and the camera can ride with it. Every other
 * vehicle keeps the ordinary turn rule, so the traffic around the
 * follower behaves the way the RL environment models it.
 */
const store = useWorldStore()

const startVehicleId = ref('')
const endJunctionId = ref('')
const planning = ref(false)
const error = ref<string | null>(null)

const vehicles = computed(() =>
  Object.values(store.network.vehicles)
    .map((v) => ({ id: v.id, roadId: v.roadId }))
    .sort((a, b) => a.id.localeCompare(b.id)),
)

const junctions = computed(() =>
  Object.values(store.network.intersections)
    .map((i) => ({ id: i.id }))
    .sort((a, b) => a.id.localeCompare(b.id)),
)

// Default the pickers as soon as the scene has something to pick.
watch(
  [vehicles, junctions],
  () => {
    if (!startVehicleId.value && vehicles.value.length > 0) {
      startVehicleId.value = vehicles.value[0]!.id
    }
    if (!endJunctionId.value && junctions.value.length > 0) {
      endJunctionId.value = junctions.value[junctions.value.length - 1]!.id
    }
  },
  { immediate: true },
)

const plan = async (): Promise<void> => {
  error.value = null
  planning.value = true
  try {
    const result = await store.planRoute(startVehicleId.value, endJunctionId.value)
    if (!result.ok) {
      error.value = result.reason
      return
    }
  } finally {
    planning.value = false
  }
}

/** The junction scenario is the only one the drive policy drives. */
const isJunctionScene = computed(
  () => store.currentSceneKind === 'junction' || store.currentSceneKind === 'junction-grid',
)

const onToggleDrive = (event: Event): void => {
  const checked = (event.target as HTMLInputElement).checked
  if (checked) {
    store.enableDrivePolicy()
    showFlashMessage('RL 正在驾驶路口协商', 'info')
  } else {
    store.disableDrivePolicy()
    showFlashMessage('协商车辆回到普通规则', 'info')
  }
}

/** Per-driver readout: speed, or "through" once it is on its out-road. */
const driveReadout = computed(() => {
  if (!store.driveEnabled) return []
  return Object.keys(store.driveRoutes ?? {}).map((id) => {
    const vehicle = store.network.vehicles[id]
    const route = store.driveRoutes?.[id] ?? []
    const arrived = vehicle ? route.length > 1 && vehicle.roadId === route[route.length - 1] : false
    const speed = vehicle ? Math.round(vehicle.speed * 3.6) : 0
    return {
      id,
      arrived,
      label: !vehicle ? '—' : arrived ? '已通过' : `${speed} km/h`,
    }
  })
})

const followCamera = computed({
  get: () => store.followCamera,
  set: (value: boolean) => {
    store.followCamera = value
  },
})

const onToggleFollow = (): void => {
  store.followCamera = followCamera.value
}

/** The follower's speed, in km/h. */
const speedKmh = computed(() => {
  const id = store.routeFollowerId
  const vehicle = id ? store.network.vehicles[id] : undefined
  return vehicle ? Math.round(vehicle.speed * 3.6) : 0
})

/** How far along the route the follower is, in [0, 1]. */
const progress = computed(() => store.routeProgress())

/** The road the follower takes next (null at the end of the route). */
const nextRoad = computed(() => {
  const route = store.plannedRoute
  const id = store.routeFollowerId
  if (!route || !id) return null
  const vehicle = store.network.vehicles[id]
  if (!vehicle) return null
  const index = route.roads.indexOf(vehicle.roadId)
  if (index < 0) return null
  return route.roads[index + 1] ?? null
})
</script>

<style scoped>
.route-panel {
  position: absolute;
  top: 12px;
  left: 12px;
  min-width: 240px;
  max-width: 300px;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.85);
  color: #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.route-panel .head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 6px;
}
.route-panel .ctrl {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  color: #cbd5e1;
}
.route-panel .ctrl select {
  flex: 1;
  min-width: 0;
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 12px;
}
.route-panel .actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.route-panel button.primary {
  flex: 1;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  background: #2563eb;
  color: #f8fafc;
  font-size: 12px;
  cursor: pointer;
}
.route-panel button.primary:disabled {
  background: #334155;
  cursor: not-allowed;
}
.route-panel button.ghost {
  padding: 2px 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  background: transparent;
  color: #cbd5e1;
  font-size: 11px;
  cursor: pointer;
}
.route-panel .err {
  color: #f87171;
  margin: 6px 0 0;
}
.route-panel .hud {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}
.route-panel .hud .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.route-panel .hud .row b {
  font-weight: 600;
  color: #fbbf24;
}
.route-panel .toggle {
  margin-top: 6px;
}
.route-panel .rows {
  margin-top: 4px;
}
.route-panel .rows .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.route-panel .rows .row b {
  font-weight: 600;
  color: #e2e8f0;
}
.route-panel .rows .row b.arrived {
  color: #22c55e;
}
</style>

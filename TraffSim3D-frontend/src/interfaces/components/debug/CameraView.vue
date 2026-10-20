<template>
  <div v-if="world.cameraEnabled" class="camera-view">
    <header>
      <span>📷 {{ hostLabel }}</span>
      <span class="meta">{{ width }}×{{ height }} · {{ cameraFrameCount }} frames</span>
    </header>
    <canvas ref="canvasRef" :width="width" :height="height" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { useSelectionStore } from '@interfaces/stores/selectionStore'
import { getMainRenderer } from '@interfaces/composables/rendererRegistry'
import {
  CAMERA_DEFAULT_WIDTH,
  CAMERA_DEFAULT_HEIGHT,
  CAMERA_SAMPLE_INTERVAL,
} from '@shared/constants/simulation'

const world = useWorldStore()
const selection = useSelectionStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const width = CAMERA_DEFAULT_WIDTH
const height = CAMERA_DEFAULT_HEIGHT
const cameraFrameCount = ref(0)
let lastSampleSimTime = -Infinity
let localRenderer: THREE.WebGLRenderer | null = null
let rafId: number | null = null

const hostLabel = computed(() => {
  if (selection.kind === 'vehicle' && selection.id) return selection.id
  const first = Object.keys(world.network.vehicles)[0]
  return first ?? 'no-host'
})

const renderOnce = (): void => {
  if (!world.cameraEnabled) return
  const now = performance.now() / 1000
  if (now - lastSampleSimTime < CAMERA_SAMPLE_INTERVAL) return
  const cs = world.getCameraSensor()
  if (!cs || !canvasRef.value) return
  const renderer = getMainRenderer()
  if (!renderer) return
  const hostId = hostLabel.value
  const v = world.network.vehicles[hostId]
  if (!v) return
  cs.render(renderer.getGl(), renderer.getScene(), now, {
    position: v.position,
    heading: v.heading,
  })
  cameraFrameCount.value += 1
  world.cameraFrameCount += 1
  lastSampleSimTime = now
}

const startLoop = (): void => {
  const tick = (): void => {
    if (!world.cameraEnabled) return
    renderOnce()
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

const stopLoop = (): void => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

watch([canvasRef, () => world.cameraSensor], ([canvas, cs]) => {
  if (!canvas || !cs) return
  if (!localRenderer) {
    localRenderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    localRenderer.setSize(width, height, false)
  }
  ;(cs as unknown as { externalRenderer: THREE.WebGLRenderer }).externalRenderer = localRenderer
})

onMounted(() => {
  startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  localRenderer?.dispose()
  localRenderer = null
})
</script>

<style scoped>
.camera-view {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: rgba(15, 23, 42, 0.85);
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #f1f5f9;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  z-index: 5;
}
.camera-view header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  gap: 8px;
}
.camera-view .meta {
  opacity: 0.6;
}
.camera-view canvas {
  display: block;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 4px;
}
</style>

<template>
  <div class="minimap-card" data-testid="minimap">
    <canvas ref="canvasRef" class="minimap-canvas" :width="W" :height="H"></canvas>
    <span class="minimap-caption">{{ caption }}</span>
  </div>
</template>

<script setup lang="ts">
// The navigation mini-map: a small top-down canvas of the simulated
// road network with the fleet as dots and the user's camera as a view
// cone — the "navigation window" of the navigation-style street view
// (the main picture drops the raster basemap there, P5).
//
// Everything is drawn from the SIMULATION's own network in its own
// local metric frame — same waypoints, same vehicle positions — so the
// mini-map cannot disagree with the main picture: there is no second
// source of truth to drift.
//
// Performance: the road network never changes between scene loads, so
// it is pre-rendered ONCE into an offscreen canvas; each refresh (the
// store's 10 Hz uiTick, the same readout trigger every panel uses)
// blits that cache and draws only the dynamic layer (fleet dots + the
// view cone) on top.
import { ref, watchEffect } from 'vue'
import * as THREE from 'three'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { computeNetworkBounds, type NetworkBounds } from '@domain/services/networkBounds'
import {
  createMinimapTransform,
  minimapHeading,
  type MinimapTransform,
} from '@domain/services/minimap'
import { getMainRenderer } from '@interfaces/composables/rendererRegistry'

const W = 190
const H = 130

const world = useWorldStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const caption = ref('城市路网')

/** The bounds the offscreen cache was built for — rebuilt when a scene
 *  load replaces the network (identity comparison, the same pattern the
 *  renderer's rebuild uses). */
let cachedFor: unknown = null
let cachedBounds: NetworkBounds | null = null
let cachedTransform: MinimapTransform | null = null
const offscreen = document.createElement('canvas')
const offCtx = offscreen.getContext('2d')!

const buildOffscreen = (): void => {
  const network = world.network
  cachedBounds = computeNetworkBounds(network)
  cachedTransform = createMinimapTransform(cachedBounds, W, H)
  offscreen.width = W
  offscreen.height = H
  // Panel glass, then the road grid as hairlines. The road colour is
  // brighter than the main view's asphalt: on a 190 px map, contrast IS
  // the information (the user reads the network's SHAPE here).
  offCtx.fillStyle = 'rgba(13, 17, 23, 0.92)'
  offCtx.fillRect(0, 0, W, H)
  offCtx.strokeStyle = 'rgba(140, 160, 190, 0.55)'
  offCtx.lineWidth = 1
  offCtx.beginPath()
  for (const road of Object.values(network.roads)) {
    const pts =
      road.waypoints && road.waypoints.length >= 2 ? road.waypoints : [road.startNode, road.endNode]
    let first = true
    for (const p of pts) {
      const { px, py } = cachedTransform.toPx(p.x, p.z)
      if (first) {
        offCtx.moveTo(px, py)
        first = false
      } else {
        offCtx.lineTo(px, py)
      }
    }
  }
  offCtx.stroke()
  cachedFor = network
}

const draw = (): void => {
  const canvas = canvasRef.value
  if (!canvas) return
  if (cachedFor !== world.network || !cachedTransform || !cachedBounds) buildOffscreen()
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  ctx.drawImage(offscreen, 0, 0)

  // The fleet: one 2 px dot per vehicle in its own colour (the same
  // tint the main view paints the body with — the two views agree).
  for (const v of Object.values(world.network.vehicles)) {
    const { px, py } = cachedTransform!.toPx(v.position.x, v.position.z)
    ctx.fillStyle = v.color
    ctx.fillRect(px - 1, py - 1, 2.5, 2.5)
  }

  // The user's camera: a small triangle at its position, oriented by
  // its heading — "you are here" on the navigation picture. RAW
  // renderer (module registry) — the reactive proxy would drag the
  // whole scene into Vue's reactivity (see frame()'s controlsActive).
  const renderer = getMainRenderer()
  if (renderer) {
    const cam = renderer.getCamera()
    const { px, py } = cachedTransform!.toPx(cam.position.x, cam.position.z)
    const dir = new THREE.Vector3()
    cam.getWorldDirection(dir)
    const angle = minimapHeading(dir.x, dir.z)
    const size = 7
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(angle)
    ctx.fillStyle = '#7ecbff'
    ctx.beginPath()
    ctx.moveTo(size, 0)
    ctx.lineTo(-size * 0.6, size * 0.55)
    ctx.lineTo(-size * 0.6, -size * 0.55)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

// The store's 10 Hz readout trigger — the same one every panel uses
// (the network is a shallow ref mutated in place; reading uiTick is
// what makes this redraw at all).
watchEffect(() => {
  void world.uiTick
  draw()
})

// Dev introspection parity with __world/__cesium.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __minimap?: { draw: () => void } }).__minimap = { draw }
}
</script>

<style scoped>
.minimap-card {
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: color-mix(in srgb, var(--dc-panel, #111827) 82%, transparent);
  overflow: hidden;
  pointer-events: auto;
}

.minimap-canvas {
  display: block;
}

.minimap-caption {
  position: absolute;
  left: 8px;
  top: 5px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(230, 237, 243, 0.75);
  pointer-events: none;
}
</style>

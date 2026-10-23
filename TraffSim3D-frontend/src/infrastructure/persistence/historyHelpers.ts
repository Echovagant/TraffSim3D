import type { SerializedScene } from './sceneSerializer'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'

/**
 * Deep-clone a SerializedScene via JSON round-trip. The scene format
 * is JSON-friendly (no class instances, no Maps, no functions), so
 * structuredClone is overkill. The cost is O(N) where N = total
 * bytes of the scene; at demo scale (a few KB), this is sub-millisecond.
 */
export const cloneScene = (scene: SerializedScene): SerializedScene => {
  return JSON.parse(JSON.stringify(scene)) as SerializedScene
}

/**
 * Apply a SerializedScene to a live network. Used by undo/redo:
 * the worldStore replaces `network` with a new RoadNetwork built
 * from the snapshot, and Rapier bodies are re-registered by the
 * caller (worldStore.loadNetwork).
 *
 * Pure function — does NOT mutate Rapier. Caller handles that.
 */
export const sceneToNetwork = (scene: SerializedScene): RoadNetwork => {
  const network = createRoadNetwork()
  for (const road of scene.network.roads) {
    network.roads[road.id] = road
  }
  for (const inter of scene.network.intersections) {
    network.intersections[inter.id] = inter
  }
  for (const v of scene.network.vehicles) {
    network.vehicles[v.id] = v
  }
  // The geographic anchor travels with the snapshot: an undo/redo of an
  // imported map must not drop the anchor (the scene would drift off
  // the real basemap).
  const origin = scene.network.origin
  if (origin) {
    network.origin = { lat: origin.lat, lon: origin.lon }
  }
  return network
}

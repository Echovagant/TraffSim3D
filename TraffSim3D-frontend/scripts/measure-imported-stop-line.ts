// scripts/measure-imported-stop-line.ts
//
// Measures how far the stop line of an IMPORTED OSM map moves when it
// follows the junction projection instead of the road-midpoint
// assumption.
//
//   npx vite-node --config vite.contract.config.ts scripts/measure-imported-stop-line.ts <payload.json>
//
// The payload is the backend's `parse_osm_xml` output; it goes through
// the real frontend adapter (`normalizeOsmPayload`) first, so the numbers
// are the ones the app would use.

import fs from 'node:fs'
import { normalizeOsmPayload } from '@infrastructure/api/osmNetworkAdapter'
import { roadLength, stopLineSOnRoad } from '@domain/services/laneGeometry'

const payloadPath = process.argv[2]
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')) as unknown
const { network } = normalizeOsmPayload(payload)

let maxDelta = 0
for (const road of Object.values(network.roads)) {
  const len = roadLength(road)
  const connected = Object.values(network.intersections).filter((i) =>
    i.connectedRoads.includes(road.id),
  )
  if (connected.length === 0) {
    console.log(`${road.id}: len=${len.toFixed(1)} — no junction`)
    continue
  }
  for (const inter of connected) {
    const radius = inter.intersectionRadius
    // The old assumption: the stop line sat at the road midpoint.
    const oldForward = len / 2 - radius
    const oldBackward = len / 2 + radius
    const newForward = stopLineSOnRoad(road, inter, 0)
    const newBackward = stopLineSOnRoad(road, inter, road.laneCount - 1)
    const fwd = newForward === null ? null : (newForward as number) - oldForward
    const bwd = newBackward === null ? null : (newBackward as number) - oldBackward
    if (fwd !== null) maxDelta = Math.max(maxDelta, Math.abs(fwd))
    if (bwd !== null) maxDelta = Math.max(maxDelta, Math.abs(bwd))
    console.log(
      `${road.id} (len ${len.toFixed(1)} m, ${road.laneCount} lanes) ↔ ${inter.id} ` +
        `@ (${inter.position.x.toFixed(1)}, ${inter.position.z.toFixed(1)}) r=${radius}\n` +
        `    forward : old ${oldForward.toFixed(1)} → new ${
          newForward === null ? 'none (no stop line on this approach)' : newForward.toFixed(1)
        }${fwd === null ? '' : `  (Δ ${fwd.toFixed(1)} m)`}\n` +
        `    backward: old ${oldBackward.toFixed(1)} → new ${
          newBackward === null ? 'none (no stop line on this approach)' : newBackward.toFixed(1)
        }${bwd === null ? '' : `  (Δ ${bwd.toFixed(1)} m)`}`,
    )
  }
}
console.log(`\nmax |Δ stop line| = ${maxDelta.toFixed(1)} m`)

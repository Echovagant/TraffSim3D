// src/domain/services/approachAxis.ts
//
// Which axis does a road approach a junction on?
//
// ## Why the axis is not a property of the road
//
// The axis used to be read off the road's **whole extent** — the distance
// it travels along X compared to the distance it travels along Z. That is
// the right answer for a straight road, and the wrong one for a road that
// turns: a street that runs north for 300 m and then bends east for 40 m
// is a north-south street for 300 m of its length and an east-west one for
// the last 40.
//
// What a traffic light governs is the **approach** — the direction the
// traffic travels *at the junction*. A road that leaves a junction heading
// north is that junction's north approach, whatever the rest of the road
// does afterwards. So the axis is decided by the road's **local tangent at
// the junction's projection on the road**.
//
// The difference is not academic. The OSM parser used to read the axis off
// the **first** connected road of a junction (and only ever built ONE
// light), so all 51 signalised junctions of the Shenzhen extract ended up
// with an `ew` light: the axis was a guess about one road, applied to the
// whole junction. The perpendicular approach was therefore governed by
// nothing at all.
//
// ## One place decides it
//
// `approachAxis` is the **only** place in the frontend that answers "which
// axis is this approach on". The queue scoping uses it
// (`signalController.ts` → `axisRoadsForLight`), the tick picks the
// governing light with it, and the built-in scenes derive their lights
// from it (`defaultScene.ts`).
//
// The backend mirrors it (`app/apps/maps/osm_parser.py` →
// `_approach_axis`), so an imported map's lights carry the same axis the
// frontend would have computed for the same geometry. The two ends have to
// agree: the frontend picks the light that holds the vehicle, and the
// backend decides which light that is.

import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import {
  projectIntersectionOnRoad,
  roadForward,
  roadWaypoints,
} from '@domain/services/laneGeometry'

/**
 * The two traffic axes of a junction.
 *
 * `ns` = the traffic travels along Z (north–south), `ew` = along X
 * (east–west). The names are the axis of the **travel direction**, not of
 * the carriageway: a road is on the `ns` axis when the traffic on it runs
 * north–south at the junction.
 */
export type RoadAxis = 'ns' | 'ew'

/**
 * The axis of a road's **whole extent**: `ns` when the road travels
 * further along Z than along X, `ew` otherwise.
 *
 * This is the road-level reading of the axis — it says which way the road
 * *mostly* runs. It is the right answer for a straight road, and the
 * fallback for the cases where the local tangent at the junction cannot be
 * trusted (see `approachAxis`).
 *
 * A polyline road is classified by the distance it actually travels along
 * each axis (the per-segment |dx| / |dz| are summed), so a curved road is
 * judged by its real extent rather than by its end-to-end chord.
 */
export const roadPolylineAxis = (road: Road): RoadAxis => {
  const points = roadWaypoints(road)
  let dx = 0
  let dz = 0
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const cur = points[i]!
    dx += Math.abs(cur.x - prev.x)
    dz += Math.abs(cur.z - prev.z)
  }
  return dz > dx ? 'ns' : 'ew'
}

/**
 * The axis of the road's **travel direction at the junction**.
 *
 * The tangent is taken at the junction's projection on the road's
 * polyline (`roadForward` at `intersectionCenterS`), and the axis is `ns`
 * when the tangent runs more along Z than along X.
 *
 * ## The degradation path
 *
 * When the junction is further than `MAX_INTERSECTION_OFFSET_M` (30 m) from
 * the road's centreline, the projection is rejected — the junction is not
 * really on that road — and the road's **whole extent**
 * (`roadPolylineAxis`) decides the axis instead. A degenerate tangent (a
 * zero-length segment at the junction) degrades the same way.
 *
 * The backend rejects the same projections (`MAX_INTERSECTION_OFFSET_M` is
 * mirrored there), so the two ends fall back at the same places.
 */
export const approachAxis = (road: Road, intersection: Intersection): RoadAxis => {
  const projection = projectIntersectionOnRoad(road, intersection)
  if (!projection.projected) return roadPolylineAxis(road)
  const tangent = roadForward(road, projection.s)
  // A degenerate tangent (zero-length segment) carries no direction —
  // the road's extent is the only thing left to go on.
  if (Math.abs(tangent.ux) < 1e-9 && Math.abs(tangent.uz) < 1e-9) {
    return roadPolylineAxis(road)
  }
  return Math.abs(tangent.uz) > Math.abs(tangent.ux) ? 'ns' : 'ew'
}

/**
 * The axes present among an intersection's connected roads — the **axis
 * groups** of the junction.
 *
 * A junction's approaches are grouped by the axis they approach on: the
 * north and south arms of a crossroads are one group (`ns`), the east and
 * west arms the other (`ew`). Each group gets its **own** light, and the
 * two groups are driven in opposition.
 *
 * The order is the order of `connectedRoads` — the first axis group is the
 * one the junction's first road approaches on.
 *
 * Roads the caller does not have are skipped, and a junction without any
 * road has no axis group (and therefore no light).
 */
export const approachAxisGroups = (
  intersection: Intersection,
  roads: Readonly<Record<string, Road>>,
): RoadAxis[] => {
  const axes: RoadAxis[] = []
  for (const roadId of intersection.connectedRoads) {
    const road = roads[roadId]
    if (!road) continue
    const axis = approachAxis(road, intersection)
    if (!axes.includes(axis)) axes.push(axis)
  }
  return axes
}

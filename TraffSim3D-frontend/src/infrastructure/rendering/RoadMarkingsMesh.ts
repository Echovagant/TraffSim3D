import * as THREE from 'three'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import { ROAD_LANE_WIDTH } from '@shared/constants/simulation'
import {
  laneOffset,
  laneForwardSign,
  roadForward,
  roadLength,
  roadRight,
  roadStopLines,
  roadWaypoints,
  segmentAt,
} from '@domain/services/laneGeometry'

const CENTERLINE_COLOR = 0xfacc15 // yellow
const DIVIDER_COLOR = 0xe2e8f0 // near-white
const STOPLINE_COLOR = 0xffffff // bright white
const ARROW_COLOR = 0xffffff // white arrows, also painted on the road

/** Length of each dashed segment and gap, in world units. */
const DASH = 0.6
const GAP = 0.6

/**
 * The points of the "↑" arrow painted in a lane's center, in the road's
 * *forward* direction (local +z), as four segments. The backward lanes
 * are the same shape turned by 180°.
 */
const ARROW_SEGMENTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-0.5, -1.0, -0.5, 0.6],
  [-0.5, 0.6, 0.5, 0.6],
  [-0.7, 0.4, 0.0, 1.0],
  [0.0, 1.0, 0.7, 0.4],
]
const ARROW_SIZE = 0.55

/**
 * Polyline-aware road markings. Centerline follows the
 * polyline (N-1 segments). Dashed dividers distribute along the
 * polyline arc length, snapping to the local segment tangent at each
 * dash. Stop lines are drawn where the traffic logic actually stops a
 * vehicle — one per approach of every connected intersection, computed
 * by the same projection (`roadStopLines` → `stopLineSOnRoad`) the tick
 * brakes on. Arrows are placed at `s = 0.2·len` and `0.8·len`, rotated
 * to the local tangent.
 *
 * For 2-point roads (N=2), the result is mathematically the same as
 * the older single-segment road.
 */
export interface RoadMarkingsOptions {
  /**
   * The network's intersections. Only the ones that list this road in
   * `connectedRoads` contribute a stop line — the same filter the
   * traffic logic uses.
   */
  intersections?: readonly Intersection[]
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _scale = new THREE.Vector3(1, 1, 1)
const _matrix = new THREE.Matrix4()
const _point = new THREE.Vector3()

/**
 * The painted markings of a whole network as ONE line mesh.
 *
 * Every road used to own its markings: a centre line, a dash batch, one
 * line object per stop line and one per arrow — 480 objects (480 draw
 * calls) on a 5x5 grid, each of them a few pixels long. The paint is
 * unchanged — the same vertices, the same colours — but the lines of
 * every road now live in one buffer, and the colours travel as vertex
 * colours instead of one material per layer.
 */
export const createRoadMarkings = (
  roads: readonly Road[],
  options: RoadMarkingsOptions = {},
): THREE.Group => {
  const group = new THREE.Group()
  const positions: number[] = []
  const colors: number[] = []
  const color = new THREE.Color()

  /** Append one painted segment, carrying its colour as a vertex colour. */
  const pushSegment = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    hex: number,
  ): void => {
    color.setHex(hex)
    positions.push(ax, ay, az, bx, by, bz)
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
  }

  for (const road of roads) {
    const wps = roadWaypoints(road)
    const length = roadLength(road)
    if (length < 1e-6 || wps.length < 2) continue

    const laneWidth = ROAD_LANE_WIDTH
    const halfWidth = (road.laneCount * laneWidth) / 2

    // Centerline: solid yellow line from waypoints[0] → waypoints[N-1].
    if (road.laneCount % 2 === 0) {
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i]!
        const b = wps[i + 1]!
        pushSegment(a.x, (a.y ?? 0) + 0.02, a.z, b.x, (b.y ?? 0) + 0.02, b.z, CENTERLINE_COLOR)
      }
    }

    // Lane divider offsets (perpendicular distance from centerline).
    const dividerOffsets: number[] = []
    for (let i = 0; i < road.laneCount - 1; i++) {
      const offset = laneOffset(i, road.laneCount) + laneWidth / 2
      if (Math.abs(offset) > 1e-3) dividerOffsets.push(offset)
    }
    // A road without a lane divider (a single lane) carries no stop line
    // and no arrow either — the rule the per-road painter had.
    if (dividerOffsets.length === 0) continue

    // Distribute dashes evenly along the polyline arc length.
    const segLen = DASH + GAP
    const totalDashes = Math.max(0, Math.floor((length + GAP) / segLen))

    // Per-offset, walk the polyline and emit a dash at each `s`.
    for (const offset of dividerOffsets) {
      for (let i = 0; i < totalDashes; i++) {
        const sCenter = i * segLen
        const sStart = sCenter
        const sEnd = Math.min(length, sCenter + DASH)
        if (sEnd <= sStart) continue
        const pStart = pointAt(road, offset, sStart)
        const pEnd = pointAt(road, offset, sEnd)
        pushSegment(
          pStart.x,
          pStart.y + 0.02,
          pStart.z,
          pEnd.x,
          pEnd.y + 0.02,
          pEnd.z,
          DIVIDER_COLOR,
        )
      }
    }

    // Stop lines: one per approach of every connected intersection, at
    // the arc length the traffic logic stops at. `roadStopLines` and the
    // tick's `stopLineSOnRoad` read the SAME projection, so the painted
    // line and the enforced line cannot drift apart.
    for (const s of roadStopLines(road, options.intersections ?? [])) {
      const rgt = roadRight(road, s)
      const cx = pointAt(road, 0, s)
      pushSegment(
        cx.x + rgt.ux * -halfWidth,
        cx.y + 0.03,
        cx.z + rgt.uz * -halfWidth,
        cx.x + rgt.ux * halfWidth,
        cx.y + 0.03,
        cx.z + rgt.uz * halfWidth,
        STOPLINE_COLOR,
      )
    }

    // Lane direction arrows at s = 0.2·len and 0.8·len, per lane.
    if (road.laneCount >= 3) {
      const arrowSlots = [length * 0.2, length * 0.8]
      for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
        const sign = laneForwardSign(laneIndex, road.laneCount)
        const off = laneOffset(laneIndex, road.laneCount)
        for (const s of arrowSlots) {
          const p = pointAt(road, off, s)
          const fwd = roadForward(road, s)
          const yaw = Math.atan2(fwd.uz, fwd.ux)
          // The arrow used to be its own object with a position and a
          // rotation; the placement is baked into the vertices here, so
          // the paint lands on exactly the same pixels.
          _euler.set(0, -yaw + (sign === -1 ? Math.PI : 0), 0)
          _quat.setFromEuler(_euler)
          _pos.set(p.x, p.y + 0.025, p.z)
          _matrix.compose(_pos, _quat, _scale)
          for (const [ax, az, bx, bz] of ARROW_SEGMENTS) {
            _point.set(ax * ARROW_SIZE, 0, az * ARROW_SIZE).applyMatrix4(_matrix)
            const startX = _point.x
            const startY = _point.y
            const startZ = _point.z
            _point.set(bx * ARROW_SIZE, 0, bz * ARROW_SIZE).applyMatrix4(_matrix)
            pushSegment(startX, startY, startZ, _point.x, _point.y, _point.z, ARROW_COLOR)
          }
        }
      }
    }
  }

  if (positions.length === 0) return group

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true })
  group.add(new THREE.LineSegments(geom, mat))
  return group
}

/**
 * Helper: world position of a point at perpendicular offset from
 * centerline, at arc-length `s` along the polyline. Mirrors
 * `lanePoint()` but takes the perpendicular offset directly (not a
 * laneIndex) so markings can pick any offset (e.g. divider lines that
 * sit between lanes).
 */
const pointAt = (
  road: Road,
  perpOffset: number,
  s: number,
): { x: number; y: number; z: number } => {
  const wps = roadWaypoints(road)
  const sClamped = Math.max(0, Math.min(roadLength(road), s))
  const seg = segmentAt(road, sClamped)
  const a = wps[seg.segIdx]!
  const b = wps[seg.segIdx + 1]!
  const localT = seg.segLen < 1e-6 ? 0 : (sClamped - seg.segStartS) / seg.segLen
  const baseX = a.x + (b.x - a.x) * localT
  const baseZ = a.z + (b.z - a.z) * localT
  // Right-perpendicular at this s.
  const fwd = roadForward(road, sClamped)
  const rx = fwd.uz
  const rz = -fwd.ux
  return {
    x: baseX + rx * perpOffset,
    y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * localT,
    z: baseZ + rz * perpOffset,
  }
}

// src/application/services/intersectionGeometry.spec.ts
//
// The regression that pins the **junction geometry** of the built-in
// scenes — the defect this file exists for:
//
//   A queued vehicle stopped at a stop line hung its NOSE over the
//   crossing road's outermost lane, and the crossing traffic drove into
//   it. Measured on the cross scene (90 s, real Rapier): the 9 m bus `v-6`
//   stopped with its nose at x = -8.944, the crossing road's outer lane
//   spans x = [-9.65, -7.85] — a 0.706 m overlap — and the two bodies
//   touched at step 103.
//
//   The cause was geometric, and it was two bugs in one number:
//
//   1. the stop line sits on the intersection box's edge
//      (`stopLineSOnRoad` = `centreS ± intersectionRadius`), so the box
//      has to be at least as wide as the crossing road's half-width —
//      otherwise the outer lanes are never inside the box;
//   2. the stop rule is enforced on the vehicle's **CENTRE**, so a queued
//      vehicle's nose reaches past the stop line by up to (half its
//      length - the braking margin). The box needs a clearance on top of
//      the half-width to absorb that overhang.
//
//   The rule this spec pins:
//
//   - every junction box CONTAINS the carriageway of every road it
//     connects: `radius >= laneCount * ROAD_LANE_WIDTH / 2`;
//   - every junction adds the clearance on top:
//     `radius >= halfWidth + INTERSECTION_CLEARANCE_M`;
//   - every default vehicle starts UPSTREAM of its stop line, with
//     enough room to brake — a vehicle that starts on the line cannot
//     stop on the red and runs the light into the junction;
//   - and, end to end on the cross scene: no two vehicle bodies overlap
//     over 90 s of the physics path, and a queued vehicle's nose never
//     reaches into the crossing carriageway.
//
// The end-to-end part uses the REAL Rapier WASM (`importOriginal`
// bypasses the global no-op stub in `tests/setup.ts`): the overlap is a
// property of the solver, so a fake solver would test the fake.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@dimforge/rapier3d-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dimforge/rapier3d-compat')>()
  return actual
})

const { RapierWorld } = await import('@infrastructure/physics')
const { buildRigidBodySpec } = await import('@infrastructure/physics/RapierBodySpec')
const { tick } = await import('./tick')
const {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
  buildElevatedScene,
  buildCorridorScene,
} = await import('./defaultScene')
const { stopLineSOnRoad, laneForwardSign, roadLength } = await import(
  '@domain/services/laneGeometry'
)
const { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH, VEHICLE_BODY_SPEC } = await import(
  '@shared/constants/simulation'
)
import type { TickContext } from './tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'

const DT = 1 / 60
const STEPS = 5400 // 90 s

/** The built-in scenes, with the roads each junction connects. */
const SCENES: Array<{ name: string; build: () => RoadNetwork }> = [
  { name: 'cross', build: buildCrossIntersectionNetwork },
  { name: 't', build: buildTJunctionNetwork },
  { name: 'loop', build: buildRectangularLoopNetwork },
  { name: 'elevated', build: buildElevatedScene },
  { name: 'corridor', build: buildCorridorScene },
]

/** A junction's half-width requirement: the widest road it connects. */
const halfWidthOf = (net: RoadNetwork, inter: Intersection): number =>
  Math.max(
    ...inter.connectedRoads.map((id) => {
      const road = net.roads[id]
      if (!road) return 0
      return (road.laneCount * ROAD_LANE_WIDTH) / 2
    }),
  )

// ---------------------------------------------------------------------------
// the static rule
// ---------------------------------------------------------------------------

describe('junction geometry', () => {
  for (const { name, build } of SCENES) {
    describe(name, () => {
      it('every junction box contains the carriageway of every road it connects', () => {
        const net = build()
        for (const inter of Object.values(net.intersections)) {
          const half = halfWidthOf(net, inter)
          expect(inter.intersectionRadius).toBeGreaterThanOrEqual(half)
        }
      })

      it('every junction adds the nose-overhang clearance', () => {
        const net = build()
        // **Every** junction, not just the ones with a traffic light: the
        // front-end paints a stop line on every junction's box edge and
        // the cross-road yield rule can stop a vehicle in front of any of
        // them, so a queue — and therefore a nose overhang — can form
        // anywhere. The rule has no "signalised" branch any more.
        for (const inter of Object.values(net.intersections)) {
          const half = halfWidthOf(net, inter)
          expect(inter.intersectionRadius).toBeGreaterThanOrEqual(half + INTERSECTION_CLEARANCE_M)
        }
      })

      it('every default vehicle starts upstream of its stop line, with braking room', () => {
        const net = build()
        for (const v of Object.values(net.vehicles)) {
          const road = net.roads[v.roadId]!
          const sign = laneForwardSign(v.laneIndex, road.laneCount)
          // A road can be connected to more than one junction (the
          // corridor's middle road has two), so take the stop line this
          // vehicle is actually approaching.
          let closest: number | null = null
          for (const inter of Object.values(net.intersections)) {
            if (!inter.connectedRoads.includes(road.id)) continue
            // A junction without a traffic light has no stop rule — the
            // painted line there is decoration, so a vehicle is not held
            // by it and needs no braking room.
            if (inter.trafficLights.length === 0) continue
            const stopS = stopLineSOnRoad(road, inter, v.laneIndex)
            if (stopS === null) continue
            const upstream = sign === 1 ? stopS - v.s : v.s - stopS
            if (upstream < 0) continue // the line is behind the vehicle
            if (closest === null || upstream < closest) closest = upstream
          }
          if (closest === null) continue // this approach has no stop line
          // 5 m is the braking distance of an 8 m/s car at MAX_DECEL
          // (10 m/s²) plus a margin: a vehicle that starts closer than
          // that cannot stop on the red — it runs the light and drives
          // into the junction.
          expect(closest).toBeGreaterThanOrEqual(5)
        }
      })
    })
  }
})

// ---------------------------------------------------------------------------
// the end-to-end rule (the cross scene, real Rapier)
// ---------------------------------------------------------------------------

interface Box {
  cx: number
  cz: number
  ux: number
  uz: number
  hl: number
  hw: number
}

const corners = (b: Box): Array<[number, number]> => {
  const px = -b.uz
  const pz = b.ux
  const out: Array<[number, number]> = []
  for (const sl of [1, -1]) {
    for (const sw of [1, -1]) {
      out.push([b.cx + sl * b.hl * b.ux + sw * b.hw * px, b.cz + sl * b.hl * b.uz + sw * b.hw * pz])
    }
  }
  return out
}

/** Separating-axis test: do two vehicle footprints overlap? */
const footprintsOverlap = (a: Box, b: Box): boolean => {
  const ca = corners(a)
  const cb = corners(b)
  const axes: Array<[number, number]> = [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ]
  for (const [ax, az] of axes) {
    let aMin = Infinity
    let aMax = -Infinity
    for (const [x, z] of ca) {
      const p = x * ax + z * az
      if (p < aMin) aMin = p
      if (p > aMax) aMax = p
    }
    let bMin = Infinity
    let bMax = -Infinity
    for (const [x, z] of cb) {
      const p = x * ax + z * az
      if (p < bMin) bMin = p
      if (p > bMax) bMax = p
    }
    if (aMax <= bMin || bMax <= aMin) return false
  }
  return true
}

interface Footprint {
  id: string
  box: Box
  speed: number
  roadId: string
  /** the vehicle's arc length along its road */
  s: number
  /** the arc length of the road's midpoint — the junction sits there */
  centreS: number
  /** +1 for a forward lane (towards a larger s), -1 for a backward lane */
  sign: 1 | -1
}

const runCrossScene = async (): Promise<Footprint[][]> => {
  const net = buildCrossIntersectionNetwork()
  const ids = Object.keys(net.vehicles)
  const world = new RapierWorld()
  await world.init()
  for (const v of Object.values(net.vehicles)) {
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
  }
  const frames: Footprint[][] = []
  let simTime = 0
  for (let step = 0; step < STEPS; step++) {
    simTime += DT
    const ctx: TickContext = {
      rapierWorld: world,
      signal: {
        controllers: new Map(),
        controllerKind: 'actuated',
        getCoordinatedOffsets: () => new Map(),
        isCoordinatedEnabled: () => false,
        getRlActionSource: () => undefined,
      },
      trajectoryExporter: null,
      sensorRegistry: null,
      lidarEnabled: false,
      getHostPose: () => null,
      fixedStepScheduler: null,
      draggingId: null,
      removeVehicle: (id: string) => {
        delete net.vehicles[id]
      },
      policy: null,
      replayTargetId: null,
    }
    tick(net, DT, simTime, ctx)
    frames.push(
      ids.map((id) => {
        const v = net.vehicles[id]
        if (!v) {
          return {
            id,
            box: { cx: NaN, cz: NaN, ux: 1, uz: 0, hl: 0, hw: 0 },
            speed: 0,
            roadId: '',
            s: NaN,
            centreS: NaN,
            sign: 1 as 1 | -1,
          }
        }
        const spec = VEHICLE_BODY_SPEC[v.type]
        const road = net.roads[v.roadId]!
        return {
          id,
          box: {
            cx: v.position.x,
            cz: v.position.z,
            ux: Math.cos(v.heading),
            uz: Math.sin(v.heading),
            hl: spec.length / 2,
            hw: spec.width / 2,
          },
          speed: v.speed,
          roadId: v.roadId,
          s: v.s,
          centreS: roadLength(road) / 2,
          sign: laneForwardSign(v.laneIndex, road.laneCount),
        }
      }),
    )
  }
  return frames
}

describe('the cross scene over 90 s of real physics', () => {
  it('never lets two vehicle bodies overlap', async () => {
    const frames = await runCrossScene()
    const contacts: string[] = []
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k]!
      for (let i = 0; i < f.length; i++) {
        for (let j = i + 1; j < f.length; j++) {
          const a = f[i]!
          const b = f[j]!
          if (Number.isNaN(a.box.cx) || Number.isNaN(b.box.cx)) continue
          if (footprintsOverlap(a.box, b.box)) {
            contacts.push(`step ${k} (t=${(k * DT).toFixed(3)} s): ${a.id} <-> ${b.id}`)
          }
        }
      }
    }
    expect(contacts.slice(0, 5)).toEqual([])
    expect(contacts.length).toBe(0)
  }, 120_000)

  it('keeps a queued vehicle out of the crossing carriageway', async () => {
    const net = buildCrossIntersectionNetwork()
    // The crossing road's half-width: 6 lanes x 3.5 m = 21 m -> 10.5 m.
    const crossHalfWidth = (6 * ROAD_LANE_WIDTH) / 2
    const frames = await runCrossScene()
    let worstClearance = Infinity
    let worstLabel = ''
    for (let k = 0; k < frames.length; k++) {
      for (const f of frames[k]!) {
        if (Number.isNaN(f.box.cx) || f.speed >= 0.5) continue // not queued
        const road = net.roads[f.roadId]
        if (!road) continue
        // Only the vehicles that are still APPROACHING the junction: a
        // vehicle that already crossed it is inside the crossing road on
        // purpose.
        const upstream = f.sign === 1 ? f.centreS - f.s : f.s - f.centreS
        if (upstream <= 0) continue
        const roadIsNS =
          Math.abs(road.endNode.z - road.startNode.z) > Math.abs(road.endNode.x - road.startNode.x)
        // The crossing road runs along the OTHER axis, so the body's
        // lateral offset from the crossing road's centreline is measured
        // on that axis: an EW vehicle's nose reaches into the NS road
        // along x, an NS vehicle's along z.
        let minLateral = Infinity
        for (const [cx, cz] of corners(f.box)) {
          const lateral = roadIsNS ? Math.abs(cz) : Math.abs(cx)
          if (lateral < minLateral) minLateral = lateral
        }
        const clearance = minLateral - crossHalfWidth
        if (clearance < worstClearance) {
          worstClearance = clearance
          worstLabel =
            `${f.id} at step ${k} (t=${(k * DT).toFixed(3)} s): body reaches ${minLateral.toFixed(3)} m ` +
            `from the crossing road's centreline (the carriageway ends at ${crossHalfWidth} m)`
        }
      }
    }
    expect(worstLabel).not.toBe('')
    expect(worstClearance, worstLabel).toBeGreaterThan(0)
  }, 120_000)
})

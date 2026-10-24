import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnVehicle } from './spawnVehicle'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { inIntersectionBox } from '@domain/services/laneGeometry'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'

describe('spawnVehicle', () => {
  it('returns {ok: true, vehicle} when a free lane exists', () => {
    const net = buildTestNetwork(0)
    const r = spawnVehicle(net, 'v-99')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.vehicle.id).toBe('v-99')
      expect(r.vehicle.roadId).toMatch(/^r-/)
    }
  })

  it('honors type override', () => {
    const net = buildTestNetwork(0)
    const r = spawnVehicle(net, 'v-99', { type: 'bus' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.vehicle.type).toBe('bus')
  })

  it('honors color override', () => {
    const net = buildTestNetwork(0)
    const r = spawnVehicle(net, 'v-99', { color: '#ff00ff' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.vehicle.color).toBe('#ff00ff')
  })

  it('sets initial status = waiting if speed < 0.5', () => {
    const net = buildTestNetwork(0)
    const r = spawnVehicle(net, 'v-99', { speed: 0 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.vehicle.status).toBe('waiting')
  })

  it('returns {ok: false} when no lane has a free window (both roads too short)', () => {
    const net = buildTestNetwork(0)
    // Make BOTH roads too short to fit the minimum gap.
    net.roads['r-ns'] = {
      ...net.roads['r-ns']!,
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 0, y: 0, z: 2 },
    }
    net.roads['r-ew'] = {
      ...net.roads['r-ew']!,
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 2, y: 0, z: 0 },
    }
    const r = spawnVehicle(net, 'v-99')
    expect(r.ok).toBe(false)
  })
})

/**
 * The legacy path (`network.spawnPoints` is empty → the random
 * `findFreeLanes` scan) must not put a car **inside a junction box**.
 *
 * The box IS the junction: its edge is the stop line, and the
 * intersection-occupancy rule ("is this vehicle in the intersection?")
 * tests the same interval. A car placed inside it would start inside the
 * junction — past the stop line — and the traffic logic would treat it as
 * traffic that had already entered the box.
 *
 * The old code excluded a hard-coded 5 m zone around the stop line,
 * which did **not** keep the car out of the box: the box reaches
 * `radius` past the line (the line is its edge), so a car 5 m past the
 * line was still inside the junction. With the lane-model radii
 * (11.5 m and 15 m) the box is deeper still.
 */
describe('spawnVehicle — the legacy fallback never spawns inside a junction box', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** One 100 m road with a 15 m junction box at its middle (the cross scene's radius). */
  const legacyNetwork = (): ReturnType<typeof createRoadNetwork> => {
    const net = createRoadNetwork()
    const road: Road = {
      id: 'r-1',
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 100, y: 0, z: 0 },
      laneCount: 2,
      speedLimit: 20,
      level: 0,
    }
    net.roads[road.id] = road
    const inter: Intersection = {
      id: 'i-1',
      position: { x: 50, y: 0, z: 0 },
      trafficLights: [],
      connectedRoads: ['r-1'],
      intersectionRadius: 15,
    }
    net.intersections[inter.id] = inter
    return net
  }

  it('rejects a position inside the box and takes the next free one', () => {
    const net = legacyNetwork()
    // The mocked draws are, in order:
    //   1. the vehicle type roll,
    //   2. the first candidate of lane 0 -> s = 1 + 0.5 * 98 = 50,
    //      which is the junction's CENTRE (inside the box [35, 65]),
    //   3. the next candidate -> s = 1 + 0.1 * 98 = 10.8, which is
    //      clear of the box.
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9) // the type roll
      .mockReturnValueOnce(0.5) // lane 0, trial 1 -> inside the box
      .mockReturnValue(0.1) // every later draw -> s = 10.8

    const r = spawnVehicle(net, 'v-99')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const road = net.roads[r.vehicle.roadId]!
    const inter = Object.values(net.intersections)[0]!
    expect(inIntersectionBox(road, r.vehicle.s, inter.intersectionRadius, inter)).toBe(false)
    // …and it really was the rejected draw that used to win.
    expect(r.vehicle.s).not.toBe(50)
  })

  it('never lands inside the box, whatever the draw', () => {
    for (let i = 0; i < 50; i++) {
      const net = legacyNetwork()
      // A draw that lands anywhere in the middle third of the road —
      // i.e. inside the box.
      vi.spyOn(Math, 'random').mockReturnValue(0.4 + (i % 10) / 100)
      const r = spawnVehicle(net, `v-${i}`)
      if (!r.ok) continue
      const road = net.roads[r.vehicle.roadId]!
      const inter = Object.values(net.intersections)[0]!
      expect(inIntersectionBox(road, r.vehicle.s, inter.intersectionRadius, inter)).toBe(false)
      vi.restoreAllMocks()
    }
  })
})

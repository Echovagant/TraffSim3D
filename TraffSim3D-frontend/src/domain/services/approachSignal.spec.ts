import { describe, it, expect } from 'vitest'
import { approachSignalFor, signalPhaseLabel } from './approachSignal'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

// A straight east-west road with a light-controlled junction at its
// end (x = 100) — the driver meets the signal there.
const road: Road = {
  id: 'r-1',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 100, y: 0, z: 0 },
  laneCount: 2,
  speedLimit: 14,
  level: 0,
}

const junction: Intersection = {
  id: 'i-1',
  position: { x: 100, y: 0, z: 0 },
  connectedRoads: ['r-1'],
  radius: 11.5,
  intersectionRadius: 11.5,
  trafficLights: [
    {
      id: 'tl-ew',
      position: { x: 100, y: 0, z: 6 },
      phase: LightPhase.Red,
      phaseRemaining: 12,
      cycleSeconds: 60,
      axis: 'ew',
    },
    {
      id: 'tl-ns',
      position: { x: 106, y: 0, z: 0 },
      phase: LightPhase.Green,
      phaseRemaining: 30,
      cycleSeconds: 60,
      axis: 'ns',
    },
  ],
} as unknown as Intersection

const network = {
  roads: { 'r-1': road },
  intersections: { 'i-1': junction },
  vehicles: {},
  spawnPoints: {},
  road: (id: string) => (id === 'r-1' ? road : undefined),
  intersection: (id: string) => (id === 'i-1' ? junction : undefined),
  vehicle: () => undefined,
  spawnPoint: () => undefined,
} as unknown as RoadNetwork

const vehicle = (over: Partial<Vehicle>): Vehicle =>
  ({
    id: 'v-1',
    type: 'car',
    roadId: 'r-1',
    laneIndex: 0,
    s: 40,
    position: { x: 40, y: 0, z: 1.75 },
    heading: 0,
    speed: 10,
    targetSpeed: 14,
    status: 'driving',
    desiredStatus: 'driving',
    ...over,
  }) as unknown as Vehicle

describe('approachSignalFor — the signal the driver is about to meet', () => {
  it('reads the live phase and countdown of the light on the approach axis', () => {
    const signal = approachSignalFor(vehicle({}), network)
    expect(signal).not.toBeNull()
    // The east-west approach gets the east-west light — red, 12 s left.
    expect(signal!.light.id).toBe('tl-ew')
    expect(signal!.phase).toBe(LightPhase.Red)
    expect(signal!.remainingS).toBe(12)
    // 60 m from the junction's projection.
    expect(signal!.distanceM).toBeGreaterThan(50)
    expect(signal!.distanceM).toBeLessThan(70)
  })

  it('has no signal when the road ahead carries no light', () => {
    const bare = {
      ...network,
      intersections: {
        'i-1': { ...junction, trafficLights: [] },
      },
    } as unknown as RoadNetwork
    expect(approachSignalFor(vehicle({}), bare)).toBeNull()
  })

  // The fix: an imported OSM way is a long polyline that crosses many
  // junctions in its MIDDLE. The old test rejected every mid-road
  // junction ("the junction must sit at the travel end"), and the
  // cluster showed 无信号 to a car 46 m from a red light. The rule now
  // reads the same projection the stop line is drawn from.
  it('sees a junction in the MIDDLE of the road, ahead of the car', () => {
    const mid = {
      ...network,
      intersections: {
        'i-1': { ...junction, position: { x: 60, y: 0, z: 0 } },
      },
    } as unknown as RoadNetwork
    const signal = approachSignalFor(vehicle({ s: 40, position: { x: 40, y: 0, z: 1.75 } }), mid)
    expect(signal).not.toBeNull()
    expect(signal!.light.id).toBe('tl-ew')
    // 20 m from the stop line's junction.
    expect(signal!.distanceM).toBeGreaterThan(15)
    expect(signal!.distanceM).toBeLessThan(25)
  })

  it('ignores a junction the car has already passed', () => {
    const behind = {
      ...network,
      intersections: {
        'i-1': { ...junction, position: { x: 20, y: 0, z: 0 } },
      },
    } as unknown as RoadNetwork
    // The car at s = 40 has crossed the line at s ≈ 8.5 already.
    expect(
      approachSignalFor(vehicle({ s: 40, position: { x: 40, y: 0, z: 1.75 } }), behind),
    ).toBeNull()
  })

  it('still shows the light to a car standing exactly on the stop line', () => {
    // Stop line for the end junction (radius 11.5) sits at s = 88.5.
    const onLine = approachSignalFor(
      vehicle({ s: 88.5, position: { x: 88.5, y: 0, z: 1.75 } }),
      network,
    )
    expect(onLine).not.toBeNull()
    expect(onLine!.remainingS).toBe(12)
  })

  it('skips a junction whose line the car has crossed (the commitment rule)', () => {
    // Car at s = 95 is past the line (88.5) but inside the box (< 100):
    // the tick no longer governs it, and neither does the gauge.
    expect(
      approachSignalFor(vehicle({ s: 95, position: { x: 95, y: 0, z: 1.75 } }), network),
    ).toBeNull()
  })

  it('measures from the END node for a backward lane', () => {
    // laneIndex 1 of 2 = backward: s counts from the road's END, so a
    // car at s = 30 stands at x = 70 and drives towards x = 0.
    const mid = {
      ...network,
      intersections: {
        'i-1': { ...junction, position: { x: 40, y: 0, z: 0 } },
      },
    } as unknown as RoadNetwork
    const signal = approachSignalFor(
      vehicle({ laneIndex: 1, s: 30, position: { x: 70, y: 0, z: -1.75 } }),
      mid,
    )
    expect(signal).not.toBeNull()
    // 30 m from the junction at x = 40.
    expect(signal!.distanceM).toBeGreaterThan(25)
    expect(signal!.distanceM).toBeLessThan(35)
  })

  // The second bug: the nearest junction ahead often carries NO light —
  // the driver's light is the NEXT one, on the same road. Returning only
  // the nearest dropped a lit junction 130 m ahead because a bare one
  // stood 15 m in front of it (measured on the Shenzhen extract: cars
  // v-25 and v-53 both showed 无信号 with a light dead ahead).
  it('walks past a bare junction to the lit one on the same road', () => {
    const two = {
      ...network,
      intersections: {
        // x = 55: bare (no lights), 15 m ahead of the car.
        'i-bare': { ...junction, id: 'i-bare', position: { x: 55, y: 0, z: 0 }, trafficLights: [] },
        // x = 70: lit, 30 m ahead of the car.
        'i-1': { ...junction, position: { x: 70, y: 0, z: 0 } },
      },
    } as unknown as RoadNetwork
    const signal = approachSignalFor(vehicle({ s: 40, position: { x: 40, y: 0, z: 1.75 } }), two)
    expect(signal).not.toBeNull()
    expect(signal!.light.id).toBe('tl-ew')
    expect(signal!.distanceM).toBeGreaterThan(25)
    expect(signal!.distanceM).toBeLessThan(35)
  })
})

describe('signalPhaseLabel — the arrow and flashing phases read as their colour', () => {
  it('names the three basic phases', () => {
    expect(signalPhaseLabel(LightPhase.Green)).toBe('绿灯')
    expect(signalPhaseLabel(LightPhase.Yellow)).toBe('黄灯')
    expect(signalPhaseLabel(LightPhase.Red)).toBe('红灯')
  })

  it('names the arrow phases by their colour', () => {
    expect(signalPhaseLabel(LightPhase.GreenLeft)).toBe('绿灯')
    expect(signalPhaseLabel(LightPhase.RedLeft)).toBe('红灯')
    expect(signalPhaseLabel(LightPhase.AllRed)).toBe('红灯')
  })

  it('names the flashing phases', () => {
    expect(signalPhaseLabel(LightPhase.FlashingYellow)).toBe('闪黄')
    expect(signalPhaseLabel(LightPhase.FlashingRed)).toBe('闪红')
  })
})

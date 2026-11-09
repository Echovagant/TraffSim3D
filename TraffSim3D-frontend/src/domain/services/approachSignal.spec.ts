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

  it('has no signal when the junction is far from the travel end', () => {
    const far = {
      ...network,
      intersections: {
        'i-1': { ...junction, position: { x: 40, y: 0, z: 0 } },
      },
    } as unknown as RoadNetwork
    expect(approachSignalFor(vehicle({}), far)).toBeNull()
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

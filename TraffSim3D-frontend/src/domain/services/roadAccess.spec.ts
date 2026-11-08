import { describe, it, expect } from 'vitest'
import {
  roadWidthM,
  vehicleFitsRoad,
  vehicleRequiredWidthM,
  effectiveLaneCount,
} from './roadAccess'
import type { Road } from '@domain/entities/Road'

const makeRoad = (highway: string | undefined, laneCount: number): Road => ({
  id: 'r-1',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 10, y: 0, z: 0 },
  laneCount,
  speedLimit: 20,
  level: 0,
  ...(highway === undefined ? {} : { highway }),
})

describe('roadWidthM — the class decides the lane metres', () => {
  it('a four-lane primary is 14 m of carriageway', () => {
    expect(roadWidthM(makeRoad('primary', 4))).toBeCloseTo(14, 5)
  })

  it('a two-lane residential street is 6 m', () => {
    expect(roadWidthM(makeRoad('residential', 2))).toBeCloseTo(6, 5)
  })

  it('an unclassified way is ONE 2.2 m lane — its lanes tag is noise', () => {
    const road = makeRoad('unclassified', 2)
    expect(effectiveLaneCount(road)).toBe(1)
    expect(roadWidthM(road)).toBeCloseTo(2.2, 5)
  })

  it('a road with no class (hand-built scenes) keeps its lane count at 3 m', () => {
    expect(roadWidthM(makeRoad(undefined, 3))).toBeCloseTo(9, 5)
  })
})

describe('vehicleFitsRoad — cars cannot scrape through the narrow lanes', () => {
  it('a car (1.8 m + 0.6 clearance) fits a 3 m residential lane, not a 2.2 m lane', () => {
    expect(vehicleRequiredWidthM('car')).toBeCloseTo(2.4, 5)
    expect(vehicleFitsRoad(makeRoad('residential', 1), 'car')).toBe(true)
    expect(vehicleFitsRoad(makeRoad('unclassified', 1), 'car')).toBe(false)
  })

  it('a bus (2.5 m) needs a full 3.1 m — single-lane streets exclude it', () => {
    expect(vehicleRequiredWidthM('bus')).toBeCloseTo(3.1, 5)
    expect(vehicleFitsRoad(makeRoad('residential', 1), 'bus')).toBe(false)
    expect(vehicleFitsRoad(makeRoad('residential', 2), 'bus')).toBe(true)
    expect(vehicleFitsRoad(makeRoad('primary', 2), 'bus')).toBe(true)
  })

  it('a truck (2.2 m) fits single residential lanes but not the narrow ones', () => {
    expect(vehicleFitsRoad(makeRoad('residential', 1), 'truck')).toBe(true)
    expect(vehicleFitsRoad(makeRoad('unclassified', 1), 'truck')).toBe(false)
  })
})

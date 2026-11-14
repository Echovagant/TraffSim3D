// src/domain/services/cityBounds.spec.ts
//
// The fleet's home rectangle. The claim under test: `bboxToLocalRect`
// is the exact inverse of the road drawing's own projection
// (`localToLngLat` in loadOSMScene — same parser projection, same
// 111 000 m/degree), so a boundary derived from the buildings' WGS84
// extent lands EXACTLY where the drawn buildings do, and a vehicle
// position inside the rect is inside the modelled city.

import { describe, it, expect } from 'vitest'
import { bboxToLocalRect, outOfRect, METERS_PER_DEGREE_LAT, type Bbox } from './cityBounds'
import { localToLngLat } from '@infrastructure/cesium/loadOSMScene'

const ORIGIN = { lat: 22.54297, lon: 114.071825 }

// The Shenzhen Futian sample rectangle (the drawn city).
const CITY_BBOX: Bbox = { south: 22.52297, west: 114.04865, north: 22.56297, east: 114.095 }

describe('bboxToLocalRect — the inverse of the drawing projection', () => {
  it('maps the rectangle corners back through localToLngLat exactly', () => {
    const rect = bboxToLocalRect(ORIGIN, CITY_BBOX)
    // The rect's corners, projected back to WGS84, must reproduce the
    // bbox corners (the round-trip through the same 111 000 m/degree
    // flat projection).
    const back = localToLngLat(ORIGIN, rect.minX, rect.minZ)
    expect(back.lng).toBeCloseTo(CITY_BBOX.west, 9)
    expect(back.lat).toBeCloseTo(CITY_BBOX.north, 9)
    const back2 = localToLngLat(ORIGIN, rect.maxX, rect.maxZ)
    expect(back2.lng).toBeCloseTo(CITY_BBOX.east, 9)
    expect(back2.lat).toBeCloseTo(CITY_BBOX.south, 9)
  })

  it('keeps north-negative z (minZ is the NORTH edge in the app frame)', () => {
    const rect = bboxToLocalRect(ORIGIN, CITY_BBOX)
    expect(rect.minZ).toBeLessThan(rect.maxZ)
    // The north edge (larger lat) maps to the SMALLER (more negative) z.
    const northZ = -(CITY_BBOX.north - ORIGIN.lat) * METERS_PER_DEGREE_LAT
    expect(rect.minZ).toBeCloseTo(northZ, 4)
  })

  it('contains vehicle positions that localToLngLat places inside the bbox', () => {
    const rect = bboxToLocalRect(ORIGIN, CITY_BBOX)
    // A point the drawing puts inside the rectangle…
    const ll = localToLngLat(ORIGIN, 500, -800) // 500 m east, 800 m north
    // …must read as INSIDE the same rectangle (the whole point: the
    // vehicles and the buildings share the frame).
    expect(ll.lat).toBeGreaterThan(CITY_BBOX.south)
    expect(ll.lat).toBeLessThan(CITY_BBOX.north)
    expect(ll.lng).toBeGreaterThan(CITY_BBOX.west)
    expect(ll.lng).toBeLessThan(CITY_BBOX.east)
    expect(outOfRect({ x: 500, z: -800 }, rect)).toBe(false)
  })
})

describe('outOfRect', () => {
  const rect = { minX: -100, maxX: 100, minZ: -200, maxZ: 200 }

  it('is false inside and true outside', () => {
    expect(outOfRect({ x: 0, z: 0 }, rect)).toBe(false)
    expect(outOfRect({ x: 500, z: 0 }, rect)).toBe(true)
    expect(outOfRect({ x: 0, z: -500 }, rect)).toBe(true)
  })

  it('allows the boundary slack (a road grazing the last rooftop stays in)', () => {
    // 30 m past the edge is still inside (VEHICLE_BOUNDS_MARGIN_M).
    expect(outOfRect({ x: 125, z: 0 }, rect)).toBe(false)
    expect(outOfRect({ x: 135, z: 0 }, rect)).toBe(true)
  })
})

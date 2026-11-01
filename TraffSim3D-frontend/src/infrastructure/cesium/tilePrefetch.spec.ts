// src/infrastructure/cesium/tilePrefetch.spec.ts
//
// The tile prefetch: the arithmetic that decides WHICH tiles to warm.
//
// What is pinned here:
//   1. **The zoom comes from the camera's height**, not from the
//      height as if it were a zoom level — the first version asked
//      for 1 501 tiles and the browser refused every one of them
//      (ERR_INSUFFICIENT_RESOURCES);
//   2. **The tile grid** — the standard Web Mercator arithmetic, with
//      the reference tiles of the city the project ships;
//   3. **The ancestor chain** — one tile per level, from the finest
//      level up to z0.

import { describe, it, expect } from 'vitest'
import { ancestorTiles, tileOf, tileZoomForHeight } from './tilePrefetch'

describe('tileZoomForHeight', () => {
  it('reads a 1 500 m bird’s-eye view as a street-level zoom', () => {
    // The Smart City view's default: 1 500 m above 深圳福田中心.
    const zoom = tileZoomForHeight(1500, 22.54297)
    expect(zoom).toBeGreaterThanOrEqual(15)
    expect(zoom).toBeLessThanOrEqual(17)
  })

  it('reads a higher camera as a coarser zoom', () => {
    const low = tileZoomForHeight(1500, 22.54297)
    const high = tileZoomForHeight(15000, 22.54297)
    expect(high).toBeLessThan(low)
  })

  it('never asks for more than the maximum level', () => {
    expect(tileZoomForHeight(1, 22.54297, { maxZoom: 19 })).toBeLessThanOrEqual(19)
    // A camera on the ground still needs a sane level.
    expect(tileZoomForHeight(0.001, 22.54297)).toBeGreaterThanOrEqual(0)
  })
})

describe('tileOf', () => {
  it('places a known coordinate on the standard grid', () => {
    // The Web Mercator reference: 0,0 is the north-west corner of the
    // world at z0, and at z1 the whole world is 2×2 tiles.
    expect(tileOf(-180, 85.05112878, 0)).toEqual({ x: 0, y: 0, z: 0 })
    expect(tileOf(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 })
    expect(tileOf(-90, 0, 2)).toEqual({ x: 1, y: 2, z: 2 })
    expect(tileOf(180, -85.05112878, 2)).toEqual({ x: 3, y: 3, z: 2 })
  })

  it('keeps the polar latitudes inside the grid', () => {
    // The poles do not exist on the Web Mercator grid; the clamp is
    // what keeps the index in range.
    expect(tileOf(0, 90, 3).y).toBeGreaterThanOrEqual(0)
    expect(tileOf(0, -90, 3).y).toBeLessThanOrEqual(7)
  })
})

describe('ancestorTiles', () => {
  it('gives one tile per level, from the finest up to z0', () => {
    const tiles = ancestorTiles(114.06865, 22.54297, 16)
    expect(tiles).toHaveLength(17)
    expect(tiles[0]!.z).toBe(0)
    expect(tiles[16]!.z).toBe(16)
    // Every level's tile holds the same point.
    for (const tile of tiles) {
      const { x, y } = tileOf(114.06865, 22.54297, tile.z)
      expect(tile.x).toBe(x)
      expect(tile.y).toBe(y)
    }
  })
})

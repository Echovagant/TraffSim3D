// src/infrastructure/cesium/viewer.spec.ts
//
// Two things are pinned here:
//
// 1. The viewer's geographic anchor: an imported OSM map carries its
//    own projection origin, everything else falls back to the default
//    天安门 anchor (a display anchor only — the simulation still runs,
//    it is just not pinned to a real place).
// 2. **The basemap's tile source and its datum.** The scene's roads
//    come from OSM (WGS84), so the basemap has to be OSM's too: a
//    Chinese provider's tiles are GCJ-02 and sit hundreds of metres
//    away from the data (measured at the project's own origin: 605 m).
//    The same source also means the attribution is on screen.

import { describe, it, expect } from 'vitest'
import { DEFAULT_IMAGERY, DEFAULT_TANGENT_ORIGIN, resolveTangentOrigin } from './viewer'

describe('resolveTangentOrigin', () => {
  it('uses the payload origin when the scene carries one', () => {
    expect(resolveTangentOrigin({ lat: 22.545, lon: 114.06 })).toEqual({
      lat: 22.545,
      lng: 114.06,
    })
  })

  it('falls back to the default origin when the scene has none', () => {
    expect(resolveTangentOrigin(null)).toEqual(DEFAULT_TANGENT_ORIGIN)
    expect(resolveTangentOrigin(undefined)).toEqual(DEFAULT_TANGENT_ORIGIN)
  })

  it('falls back for an out-of-range or non-finite origin', () => {
    expect(resolveTangentOrigin({ lat: Number.NaN, lon: 0 })).toEqual(DEFAULT_TANGENT_ORIGIN)
    expect(resolveTangentOrigin({ lat: 200, lon: 0 })).toEqual(DEFAULT_TANGENT_ORIGIN)
    expect(resolveTangentOrigin({ lat: 0, lon: 400 })).toEqual(DEFAULT_TANGENT_ORIGIN)
  })
})

describe('DEFAULT_IMAGERY', () => {
  it('serves the basemap from OpenStreetMap — the same source as the roads', () => {
    expect(DEFAULT_IMAGERY.urlTemplate).toContain('openstreetmap')
    // No Chinese provider: those tiles are GCJ-02, which is hundreds of
    // metres from the WGS84 the scene's roads are in.
    expect(DEFAULT_IMAGERY.urlTemplate).not.toContain('autonavi')
    expect(DEFAULT_IMAGERY.urlTemplate).not.toContain('baidu')
  })

  it('carries the attribution the tile terms require', () => {
    expect(DEFAULT_IMAGERY.credit).toContain('OpenStreetMap')
  })

  it('spreads the requests over several subdomains', () => {
    expect(DEFAULT_IMAGERY.subdomains.length).toBeGreaterThan(1)
    expect(DEFAULT_IMAGERY.urlTemplate).toContain('{s}')
  })
})

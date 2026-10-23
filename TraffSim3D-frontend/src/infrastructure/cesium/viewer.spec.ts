// src/infrastructure/cesium/viewer.spec.ts
//
// The Cesium viewer's geographic anchor: an imported OSM map carries
// its own projection origin, everything else falls back to the default
// 天安门 anchor (a display anchor only — the simulation still runs, it
// is just not pinned to a real place).

import { describe, it, expect } from 'vitest'
import { DEFAULT_TANGENT_ORIGIN, resolveTangentOrigin } from './viewer'

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

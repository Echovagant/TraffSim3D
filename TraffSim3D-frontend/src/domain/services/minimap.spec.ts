// src/domain/services/minimap.spec.ts
//
// The minimap projection. Pinned: the uniform fit (scale = the tighter
// axis, letterboxed on the other), the north-up mapping (z grows
// southward = canvas downward, x eastward = canvas rightward), and the
// heading convention (canvas-up = north, clockwise positive).

import { describe, it, expect } from 'vitest'
import { createMinimapTransform, minimapHeading } from './minimap'
import type { NetworkBounds } from './networkBounds'

const BOUNDS: NetworkBounds = {
  minX: 0,
  maxX: 1000,
  minZ: 0,
  maxZ: 500,
  centerX: 500,
  centerZ: 250,
  diagonal: 1118,
  roadCount: 10,
  intersectionCount: 5,
}

describe('createMinimapTransform — the uniform fit', () => {
  it('scales by the tighter axis and letterboxes the other', () => {
    // Box 200x120, padding 10: x needs 1000 → 180 (0.18 m/px), z needs
    // 500 → 90 (0.18) — x is the tighter axis at padding 10: 180/1000 = 0.18.
    const t = createMinimapTransform(BOUNDS, 200, 120, 10)
    expect(t.metresPerPx).toBeCloseTo(1 / 0.18, 6)
  })

  it('maps the bounds corners into the padded box', () => {
    const t = createMinimapTransform(BOUNDS, 200, 120, 10)
    const min = t.toPx(0, 0)
    const max = t.toPx(1000, 500)
    expect(min.px).toBeCloseTo(10, 6)
    expect(max.px).toBeCloseTo(190, 6)
    // z letterboxed: the drawn height is 500·0.18 = 90 → centred in 120
    // → top offset 15; z=0 (north edge) draws at the TOP of the letterbox.
    expect(min.py).toBeCloseTo(15, 6)
    expect(max.py).toBeCloseTo(105, 6)
  })

  it('keeps north up: a vehicle 100 m south of the origin draws BELOW it', () => {
    const t = createMinimapTransform(BOUNDS, 200, 120, 10)
    const origin = t.toPx(500, 100)
    const south = t.toPx(500, 200)
    expect(south.py).toBeGreaterThan(origin.py)
    // East draws rightward.
    const east = t.toPx(600, 100)
    expect(east.px).toBeGreaterThan(origin.px)
  })
})

describe('minimapHeading — canvas-up is north', () => {
  it('maps north to angle 0 and east to +90° (clockwise)', () => {
    expect(minimapHeading(0, -1)).toBeCloseTo(0, 9) // north = -Z
    expect(minimapHeading(1, 0)).toBeCloseTo(Math.PI / 2, 9) // east = +X
    expect(minimapHeading(0, 1)).toBeCloseTo(Math.PI, 9) // south
  })
})

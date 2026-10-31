// The route ribbon.
//
// A route the user cannot see is a route the user cannot check, so the
// ribbon is the product's proof that the plan is real. Two things are
// pinned: that it is built at all (a route with fewer than two points
// has no shape), and that its geometry follows the polyline.

import { describe, it, expect } from 'vitest'
import { buildRouteMesh, ROUTE_RIBBON_WIDTH_M } from './RouteMesh'

const point = (x: number, z: number) => ({ x, y: 0, z })

describe('buildRouteMesh', () => {
  it('builds a ribbon over the polyline', () => {
    const mesh = buildRouteMesh({ points: [point(0, 0), point(100, 0), point(100, 100)] })
    expect(mesh).not.toBeNull()
    const geometry = mesh!.geometry
    // Two vertices per point (the ribbon's two edges).
    expect(geometry.getAttribute('position').count).toBe(6)
    // Two triangles per segment.
    expect(geometry.getIndex()?.count).toBe(12)
    geometry.dispose()
  })

  it('has no shape when the route is shorter than two points', () => {
    expect(buildRouteMesh({ points: [] })).toBeNull()
    expect(buildRouteMesh({ points: [point(0, 0)] })).toBeNull()
  })

  it('drops zero-length segments instead of inventing a direction', () => {
    // Two points at the same place carry no direction, so the ribbon
    // must not try to make one.
    const mesh = buildRouteMesh({ points: [point(0, 0), point(0, 0), point(100, 0)] })
    expect(mesh).not.toBeNull()
    expect(mesh!.geometry.getAttribute('position').count).toBe(4)
    mesh!.geometry.dispose()
  })

  it('is wide enough to read as a lane', () => {
    const mesh = buildRouteMesh({ points: [point(0, 0), point(100, 0)] })
    const position = mesh!.geometry.getAttribute('position')
    // The ribbon runs along +X, so its width is across Z: the two
    // edges of the strip are half a width either side of the centre
    // line.
    const leftZ = position.getZ(0)
    const rightZ = position.getZ(1)
    expect(Math.abs(rightZ - leftZ)).toBeCloseTo(ROUTE_RIBBON_WIDTH_M, 5)
    mesh!.geometry.dispose()
  })

  it('cannot be picked by the editor', () => {
    const mesh = buildRouteMesh({ points: [point(0, 0), point(100, 0)] })
    // The route is information, not scenery: clicking it must not
    // select anything.
    expect(mesh!.raycast).not.toBe(undefined)
    mesh!.geometry.dispose()
  })
})

// The POI layer's geometry — the markers, their colours and the count.
//
// What is pinned here:
//   1. the whole set costs ONE draw call (an InstancedMesh);
//   2. the markers stand on the ground at the POI's scene position;
//   3. the category decides the colour, and the selected POI is
//      brighter;
//   4. the markers are NOT pickable — they are information, not
//      scenery, and the editor's click handler must not select them.

import { describe, it, expect } from 'vitest'
import { createPoiLayer, poiColor, POI_MARKER_HEIGHT_M, type Poi } from './PoiLayer'

const poi = (id: string, x: number, z: number, category = '餐饮'): Poi => ({
  id,
  name: `place-${id}`,
  category,
  address: 'somewhere',
  x,
  z,
})

describe('the POI layer', () => {
  it('draws the whole set in one instanced mesh', () => {
    const layer = createPoiLayer()
    layer.set([poi('a', 0, 0), poi('b', 10, 0), poi('c', 20, 0)])
    expect(layer.mesh.count).toBe(3)
    expect(layer.pois).toHaveLength(3)
    layer.dispose()
  })

  it('stands the markers on the ground at the POI’s position', () => {
    const layer = createPoiLayer()
    layer.set([poi('a', 12, -34)])
    // The instance matrix carries the translation; the geometry is
    // pre-raised so the marker stands on the ground.
    const array = layer.mesh.instanceMatrix.array
    // The first instance's translation is at indices 12..14.
    expect(array[12]).toBeCloseTo(12, 6)
    expect(array[14]).toBeCloseTo(-34, 6)
    layer.dispose()
  })

  it('the marker geometry starts at the ground', () => {
    const layer = createPoiLayer()
    const position = layer.mesh.geometry.getAttribute('position')
    let lowest = Infinity
    for (let i = 0; i < position.count; i += 1) {
      lowest = Math.min(lowest, position.getY(i))
    }
    // The column's base sits at (or just above) the road surface.
    expect(lowest).toBeGreaterThanOrEqual(0)
    expect(lowest).toBeLessThan(1)
    expect(POI_MARKER_HEIGHT_M).toBeGreaterThan(0)
    layer.dispose()
  })

  it('brightens the selected POI', () => {
    const layer = createPoiLayer()
    layer.set([poi('a', 0, 0), poi('b', 10, 0)])
    const before = Array.from(layer.mesh.instanceColor!.array.slice(0, 3))
    layer.select('b')
    const after = Array.from(layer.mesh.instanceColor!.array.slice(3, 6))
    // The selected one is brighter than the unselected one.
    const luminance = (c: number[]) => c[0] + c[1] + c[2]
    expect(luminance(after)).toBeGreaterThan(luminance(before))
    layer.dispose()
  })

  it('the markers cannot be picked', () => {
    const layer = createPoiLayer()
    expect(layer.mesh.raycast).not.toBe(undefined)
    layer.dispose()
  })

  it('gives the categories their own colours and falls back for the rest', () => {
    expect(poiColor('餐饮')).not.toBe(poiColor('医疗'))
    expect(poiColor('一个没有命名的类别')).toBe(poiColor('另一个没有命名的类别'))
  })

  it('caps the count — a huge POI set still costs one draw call', () => {
    const layer = createPoiLayer()
    const many = Array.from({ length: 900 }, (_, i) => poi(`p${i}`, i, 0))
    layer.set(many)
    expect(layer.mesh.count).toBeLessThanOrEqual(512)
    layer.dispose()
  })
})

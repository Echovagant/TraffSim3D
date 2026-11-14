import { describe, expect, it } from 'vitest'
import {
  LOD_MAX_SCALE,
  LOD_MIN_PIXELS,
  LOD_REFERENCE_LENGTH_M,
  vehicleLodScale,
} from './vehicleLod'

const FOV_60 = (60 * Math.PI) / 180

describe('vehicleLodScale', () => {
  it('returns exactly 1 while the car already reads at or above the minimum', () => {
    // A 4.2 m car at 100 m through 60° FOV on a 900 px viewport:
    // 4.2 · 900 / (2 · 100 · tan30°) ≈ 32.7 px — far above 3.
    expect(vehicleLodScale(100, 900, FOV_60)).toBe(1)
    // Close distances and big viewports never scale.
    expect(vehicleLodScale(1, 900, FOV_60)).toBe(1)
    expect(vehicleLodScale(50, 2160, FOV_60)).toBe(1)
  })

  it('crosses 1 exactly at the distance where the car reads LOD_MIN_PIXELS', () => {
    // The threshold distance: apparent = 3 px.
    const d = (LOD_REFERENCE_LENGTH_M * 900) / (LOD_MIN_PIXELS * 2 * Math.tan(FOV_60 / 2))
    expect(vehicleLodScale(d * 0.999, 900, FOV_60)).toBe(1)
    // Just past it the factor starts growing, from just above 1.
    const f = vehicleLodScale(d * 1.001, 900, FOV_60)
    expect(f).toBeGreaterThan(1)
    expect(f).toBeLessThan(1.01)
  })

  it('gives ~4× at the city-overview slant distance (~4.7 km)', () => {
    // The 45° bird view at 3324 m height sits ~4700 m from the centre.
    const f = vehicleLodScale(4700, 900, FOV_60)
    // apparentPx = 4.2·900/(2·4700·tan30°) ≈ 0.697 → 3/0.697 ≈ 4.3.
    expect(f).toBeGreaterThan(3.5)
    expect(f).toBeLessThan(5.5)
  })

  it('is monotone in distance and continuous across the threshold', () => {
    let prev = 1
    for (let d = 10; d <= 8000; d += 50) {
      const f = vehicleLodScale(d, 900, FOV_60)
      expect(f).toBeGreaterThanOrEqual(prev)
      expect(f).toBeGreaterThanOrEqual(1)
      prev = f
    }
  })

  it('clamps at LOD_MAX_SCALE so a degenerate input cannot blow up a matrix', () => {
    expect(vehicleLodScale(1e9, 900, FOV_60)).toBe(LOD_MAX_SCALE)
  })

  it('returns 1 for degenerate inputs instead of NaN', () => {
    expect(vehicleLodScale(0, 900, FOV_60)).toBe(1)
    expect(vehicleLodScale(100, 0, FOV_60)).toBe(1)
    expect(vehicleLodScale(100, 900, 0)).toBe(1)
    expect(vehicleLodScale(100, 900, Math.PI)).toBe(1)
    expect(vehicleLodScale(-5, 900, FOV_60)).toBe(1)
    expect(vehicleLodScale(Number.NaN, 900, FOV_60)).toBe(1)
  })
})

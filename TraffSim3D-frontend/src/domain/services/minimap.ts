// src/domain/services/minimap.ts
//
// The navigation mini-map's projection: the fleet lives in the local
// metric frame (x = east, z = south in the app convention), and the
// minimap is a small top-down canvas. This is a plain uniform scale +
// centre fit — no Mercator, no rotation: the app frame is already
// north-up when drawn with z mapped to canvas-down (z grows southward,
// canvas y grows downward — they agree, which is what keeps the
// minimap's "up" = the world's north).
//
// Pure domain: the component owns the canvas, this owns the math.

import type { NetworkBounds } from './networkBounds'

export interface MinimapTransform {
  /** Local metric metres → minimap canvas pixels. */
  toPx: (x: number, z: number) => { px: number; py: number }
  /** Metres per canvas pixel (the map's scale, for the view cone size). */
  metresPerPx: number
}

/**
 * Uniform fit of a network's bounds into a canvas box, with a padding
 * margin and centred — a wide network gets letterboxed vertically.
 * `padding` keeps the outermost dots off the canvas edge.
 */
export const createMinimapTransform = (
  bounds: NetworkBounds,
  widthPx: number,
  heightPx: number,
  paddingPx = 8,
): MinimapTransform => {
  const spanX = Math.max(1, bounds.maxX - bounds.minX)
  const spanZ = Math.max(1, bounds.maxZ - bounds.minZ)
  const scale = Math.min((widthPx - paddingPx * 2) / spanX, (heightPx - paddingPx * 2) / spanZ)
  // Centre the drawn network in the box (letterbox the longer axis).
  const offX = (widthPx - spanX * scale) / 2
  const offY = (heightPx - spanZ * scale) / 2
  return {
    metresPerPx: 1 / scale,
    toPx: (x: number, z: number) => ({
      px: offX + (x - bounds.minX) * scale,
      py: offY + (z - bounds.minZ) * scale,
    }),
  }
}

/**
 * The heading of a camera (or vehicle) as the minimap draws it: the
 * angle from canvas-up (north) clockwise. The app frame's north is -Z
 * and canvas y grows downward, so a heading of `atan2(dx, -dz)` in app
 * metres maps directly to the canvas clockwise angle.
 */
export const minimapHeading = (dx: number, dz: number): number => {
  return Math.atan2(dx, -dz)
}

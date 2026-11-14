/**
 * Far-camera legibility for vehicles.
 *
 * At the city overview the camera sits kilometres away and a real-size
 * car (4.2 m) covers well under one screen pixel — the overview reads
 * "cars floating on buildings". The fix is the one real traffic
 * platforms use: below a minimum screen size, scale the *displayed*
 * body up just enough to hold that size. The dot stays a display
 * symbol — position, heading, physics and collision geometry are
 * untouched, and the factor passes smoothly through 1 as the camera
 * approaches, so there is no visible switch.
 */
/**
 * The minimum screen size (CSS pixels) a vehicle must read at any
 * distance. 3 px is the smallest mark that is visibly *present* rather
 * than reading as a rendering artifact.
 */
export const LOD_MIN_PIXELS = 3
/**
 * The vehicle the factor is calibrated against: the car's length
 * (4.2 m). Bigger types scale by the same factor, so a bus reads as a
 * proportionally bigger mark than a car — the type hierarchy survives
 * the overview, exactly like the dot layers of a real traffic platform.
 */
export const LOD_REFERENCE_LENGTH_M = 4.2
/** Safety clamp — far past it the number would mean a bug, not a dot. */
export const LOD_MAX_SCALE = 8

/**
 * The scale factor a vehicle body needs at `distanceM` from the camera
 * so its reference length covers at least `LOD_MIN_PIXELS` screen
 * pixels. Returns exactly 1 while the body already reads large enough —
 * the factor only ever grows, and it does so continuously.
 *
 * Geometry: apparent size in pixels of a world length `L` at distance
 * `d` through a vertical FOV `θ` on a viewport `H` px tall is
 * `L · H / (2 · d · tan(θ/2))` (CSS pixels; DPR cancels because the
 * same factor scales the buffer). Solving `apparent = min` for the
 * scale gives the return value.
 */
export const vehicleLodScale = (
  distanceM: number,
  viewportHeightPx: number,
  fovRad: number,
): number => {
  if (!(distanceM > 0) || !(viewportHeightPx > 0) || !(fovRad > 0) || fovRad >= Math.PI) {
    return 1
  }
  const apparentPx =
    (LOD_REFERENCE_LENGTH_M * viewportHeightPx) / (2 * distanceM * Math.tan(fovRad / 2))
  if (apparentPx >= LOD_MIN_PIXELS) return 1
  return Math.min(LOD_MAX_SCALE, LOD_MIN_PIXELS / apparentPx)
}

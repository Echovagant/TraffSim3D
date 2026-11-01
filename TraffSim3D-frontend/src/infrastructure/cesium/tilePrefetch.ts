// src/infrastructure/cesium/tilePrefetch.ts
//
// Why the basemap takes a minute to appear — and what to do about it
// WITHOUT touching Cesium's quality settings.
//
// Cesium walks its tile quadtree **downwards**: it loads the coarse
// tiles first and refines them, because a child tile may only be
// requested once its parent is there (otherwise the screen would show
// holes). For a camera 1 500 m above a city that is a chain of
// **fifteen levels** — z1 (the whole world) down to z16 (the street).
//
// Measured from this network (2026-11-01, 深圳福田, the OSM mirror):
// each level costs a round trip plus Cesium's own processing, and the
// chain reached z16 after **90–190 s**. The tiles themselves are not
// the problem — they are 1–4 s each and they are tiny; the problem is
// that the chain is **serial**.
//
// The fix that does not touch the quality knobs: **fetch the
// ancestors ourselves, in parallel**, so they are already in the
// browser's HTTP cache when Cesium asks for them. The chain then
// costs Cesium's processing time only, and the level that actually
// needs the network is the last one or two.
//
// The ancestors are cheap: z1 has 4 tiles, z2 two, and the rest one
// to four each — about 25 tiles, a few kilobytes each.

/** One tile on the standard Web Mercator grid. */
export interface TileCoordinate {
  x: number
  y: number
  z: number
}

/**
 * The tile zoom a camera needs, from its height above the ground.
 *
 * The camera's height is a distance in metres, NOT a zoom level — the
 * first version of this module confused the two and asked for 1 501
 * tiles (one per "level" from 0 to 1500), which exhausted the
 * browser's connection pool (`ERR_INSUFFICIENT_RESOURCES`).
 *
 * The chain of reasoning: at height `h` the camera sees about
 * `2 · h · tan(fov/2)` metres across the screen, and the ground
 * sample distance is that divided by the screen height in pixels. A
 * zoom level `z` puts one pixel on `156543.03 · cos(lat) / 2^z`
 * metres of ground. Setting the two equal and solving for `z` gives
 * the level the camera actually renders.
 */
export const tileZoomForHeight = (
  heightM: number,
  lat: number,
  options: { fovDeg?: number; screenHeightPx?: number; maxZoom?: number } = {},
): number => {
  const fovDeg = options.fovDeg ?? 60
  const screenHeightPx = options.screenHeightPx ?? 800
  const maxZoom = options.maxZoom ?? 19
  const groundSpan = 2 * heightM * Math.tan((fovDeg * Math.PI) / 360)
  const metresPerPixel = Math.max(groundSpan / screenHeightPx, 1e-6)
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const zoom = Math.log2((156543.03 * cosLat) / metresPerPixel)
  return Math.max(0, Math.min(maxZoom, Math.floor(zoom)))
}

/**
 * The tile that holds a WGS84 coordinate at a zoom level.
 *
 * The standard Web Mercator (EPSG:3857) grid: the world is cut into
 * 2^z columns and rows, and the latitude is squeezed by
 * `ln(tan(π/4 + φ/2))`.
 */
export const tileOf = (lng: number, lat: number, zoom: number): TileCoordinate => {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const scale = 2 ** zoom
  const x = Math.floor(((lng + 180) / 360) * scale)
  const radians = (clampedLat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale,
  )
  // The clamp matters at the poles: the formula's own limit
  // (85.05112878°) evaluates a hair below zero in float64, and
  // `Math.floor` turns that into the index **−1** — a tile outside
  // the grid, which the server answers with a 404.
  return {
    x: Math.max(0, Math.min(scale - 1, x)),
    y: Math.max(0, Math.min(scale - 1, y)),
    z: zoom,
  }
}

/**
 * The ancestors of a tile: the same point at every coarser zoom.
 *
 * From the finest level up to level 0 — one tile per level, because
 * the point falls in exactly one tile of each level.
 */
export const ancestorTiles = (lng: number, lat: number, zoom: number): TileCoordinate[] => {
  const tiles: TileCoordinate[] = []
  for (let z = 0; z <= zoom; z += 1) {
    tiles.push(tileOf(lng, lat, z))
  }
  return tiles
}

/**
 * Fetch a set of tiles into the browser's HTTP cache.
 *
 * A plain `fetch` — the response is cached like any other, and
 * Cesium's later request for the same URL is served from it without
 * touching the network. Failures are ignored: a tile that could not
 * be prefetched is simply fetched the slow way.
 *
 * The fetches run a few at a time, not all at once: a hundred
 * parallel requests is how the browser ends up answering
 * `ERR_INSUFFICIENT_RESOURCES` and loading **no** tiles at all.
 */
export const prefetchTiles = async (
  tiles: TileCoordinate[],
  urlFor: (tile: TileCoordinate) => string,
  options: { concurrency?: number } = {},
): Promise<number> => {
  const concurrency = Math.max(1, options.concurrency ?? 6)
  let fetched = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < tiles.length) {
      const tile = tiles[next]!
      next += 1
      try {
        const response = await fetch(urlFor(tile), { mode: 'cors', credentials: 'omit' })
        if (!response.ok) continue
        // The body has to be consumed for the response to be cached.
        await response.arrayBuffer()
        fetched += 1
      } catch {
        // A prefetch is an optimisation, never a requirement.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker))
  return fetched
}

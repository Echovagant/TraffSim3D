/**
 * Driving-behaviour contract, verified against the LIVE scene (not the
 * trajectory CSV — the CSV is a faithful record of the same state, but
 * these assertions are about what the simulation DOES).
 *
 * Expectations encoded here come from a 45 s / 5 Hz instrumented probe of
 * the three built-in scene families (2026-11-04, cross/grid/loop, 225
 * samples each) plus the tick pipeline's own rules:
 *
 *   - lane keeping is near-exact on straight roads (probe: p99 lateral
 *     deviation 0.02 m over 15k grid samples, max 1.66 m during turn-arc
 *     transit),
 *   - speeds stay at or below the scene limit (observed max 16.7 m/s; the
 *     hard code cap is MAX_SPEED),
 *   - lane changes are only ever requested manually, one lane at a time
 *     (`requestLaneChange` clamps to ±1), so a same-road laneIndex jump
 *     of 2+ can only be a bug,
 *   - the travel-end wrap (`applyTravelEndWrap`) re-enters the SAME lane
 *     from the other end of the road — a same-lane teleport with no
 *     landing-occupancy check, so the landing must be asserted clear,
 *   - a junction continuation chooses ONE road; flipping back and forth
 *     between two roads within seconds is the "corner ping-pong" defect
 *     observed 2026-11-04 on the loop scene (4 of 8 vehicles flipped
 *     road twice within ~1 s at a corner, all of them on backward-lane
 *     far-end entries).
 *
 * The sampling runs inside the page (setInterval, no CDP round trip per
 * sample) at 5 Hz for WALL_SAMPLE_MS of wall clock — SwiftShader makes
 * sim time an unreliable yardstick for cadence.
 */
import { test, expect, type Page } from '@playwright/test'
import { waitForSceneReady, switchScene } from './helpers/wait'

/** Wall-clock sample window per scene. */
const WALL_SAMPLE_MS = 25_000
/** In-page sampling cadence. */
const SAMPLE_MS = 200

interface SampleRow {
  wt: number
  id: string
  road: string
  lane: number
  s: number
  x: number
  z: number
  h: number
  sp: number
  st: string
  dl: number | null
  lc: number | null
  turn: number
}

const startSampler = (page: Page, sampleMs: number): Promise<void> =>
  page.evaluate(
    ({ sampleMs }) => {
      const buf: Array<{ wt: number; rows: SampleRow[] }> = []
      ;(window as unknown as { __behaviorBuf?: typeof buf }).__behaviorBuf = buf
      const t0 = performance.now()
      const read = (): SampleRow[] => {
        const w = window as unknown as {
          __world?: { network: { vehicles: Record<string, Record<string, unknown>> } }
        }
        if (!w.__world) return []
        const out: SampleRow[] = []
        for (const [id, v] of Object.entries(w.__world.network.vehicles)) {
          out.push({
            wt: Math.round(performance.now() - t0),
            id,
            road: v.roadId as string,
            lane: v.laneIndex as number,
            s: v.s as number,
            x: v.position.x as number,
            z: v.position.z as number,
            h: v.heading as number,
            sp: v.speed as number,
            st: v.status as string,
            dl: v.desiredLaneIndex as number | null,
            lc: v.laneChangeStartedAt as number | null,
            turn: v.turn ? 1 : 0,
          })
        }
        return out
      }
      const timer = setInterval(() => {
        const b = (window as unknown as { __behaviorBuf?: typeof buf }).__behaviorBuf
        if (b) b.push({ wt: Math.round(performance.now() - t0), rows: read() })
      }, sampleMs)
      ;(window as unknown as { __behaviorTimer?: ReturnType<typeof setInterval> }).__behaviorTimer =
        timer
    },
    { sampleMs },
  )

const collectSamples = async (page: Page): Promise<Array<{ wt: number; rows: SampleRow[] }>> => {
  const dump = await page.evaluate(() => {
    const w = window as unknown as {
      __behaviorBuf?: Array<{ wt: number; rows: SampleRow[] }>
      __behaviorTimer?: ReturnType<typeof setInterval>
    }
    if (w.__behaviorTimer) clearInterval(w.__behaviorTimer)
    return JSON.stringify(w.__behaviorBuf ?? [])
  })
  return JSON.parse(dump) as Array<{ wt: number; rows: SampleRow[] }>
}

/** Per-vehicle time series, sorted by wall time. */
const seriesOf = (samples: Array<{ wt: number; rows: SampleRow[] }>): Map<string, SampleRow[]> => {
  const series = new Map<string, SampleRow[]>()
  for (const s of samples)
    for (const r of s.rows) {
      if (!series.has(r.id)) series.set(r.id, [])
      series.get(r.id)!.push(r)
    }
  for (const rs of series.values()) rs.sort((a, b) => a.wt - b.wt)
  return series
}

test.describe('driving behaviour (live scene)', () => {
  test('cross scene: speed cap, single-step lane changes, lane keeping, clean wraps', async ({
    page,
  }) => {
    test.setTimeout(WALL_SAMPLE_MS + 120_000)
    await waitForSceneReady(page)
    await switchScene(page, 'cross')
    await startSampler(page, SAMPLE_MS)
    await page.waitForTimeout(WALL_SAMPLE_MS)
    const samples = await collectSamples(page)
    const series = seriesOf(samples)

    // The cross scene always carries its six default vehicles.
    expect(series.size).toBe(6)

    for (const [id, rs] of series) {
      for (const r of rs) {
        // Hard code cap (MAX_SPEED = 35 m/s). Nothing may exceed it —
        // a higher reading means a NaN-tainted or teleported speed.
        expect(r.sp, `${id} speed at wt=${r.wt}`).toBeLessThanOrEqual(35.01)
      }
      // Waiting vehicles must be (nearly) stationary — status hysteresis
      // means a queued car may still be rolling down to a stop, but a
      // WAITING car at speed is a status/brake contradiction.
      for (const r of rs) {
        if (r.st === 'waiting') expect(r.sp, `${id} waiting at wt=${r.wt}`).toBeLessThanOrEqual(0.6)
      }
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1]!
        const b = rs[i]!
        if (a.road !== b.road) continue // junction turn / wrap: separate contract
        // Lane changes are requested one lane at a time and committed by
        // convergence, so the observed laneIndex may only step by ±1.
        const dl = b.lane - a.lane
        expect(Math.abs(dl), `${id} laneIndex ${a.lane}→${b.lane} at wt=${b.wt}`).toBeLessThan(2)
      }
    }

    // Lane keeping: on the two straight axis roads, a driving vehicle
    // not in a lane change sits on its lane's lateral offset. The lane
    // offsets are derived from the sample population itself (median per
    // road+lane), so the assertion survives scene re-authoring.
    const lat = new Map<string, number[]>() // road|lane -> lateral values
    for (const rs of series.values()) {
      for (const r of rs) {
        if (r.dl !== null || r.turn === 1 || r.st !== 'driving') continue
        const axis = r.road === 'r-ns' ? 'x' : r.road === 'r-ew' ? 'z' : null
        if (!axis) continue
        const key = `${r.road}|${r.lane}`
        if (!lat.has(key)) lat.set(key, [])
        lat.get(key)!.push(axis === 'x' ? r.x : r.z)
      }
    }
    const centers = new Map<string, number>()
    for (const [key, vals] of lat) {
      vals.sort((a, b) => a - b)
      centers.set(key, vals[Math.floor(vals.length / 2)]!)
    }
    let checked = 0
    let deviant = 0
    for (const rs of series.values()) {
      for (const r of rs) {
        if (r.dl !== null || r.turn === 1 || r.st !== 'driving') continue
        const axis = r.road === 'r-ns' ? 'x' : r.road === 'r-ew' ? 'z' : null
        if (!axis) continue
        const c = centers.get(`${r.road}|${r.lane}`)
        if (c === undefined) continue
        checked += 1
        const dev = Math.abs((axis === 'x' ? r.x : r.z) - c)
        // 0.6 m ≈ a sixth of a lane (3.5 m): the Pure-Pursuit tracking
        // error budget. The probe measured p99 = 0.02 m; 0.6 leaves room
        // for collision-avoidance nudges without hiding real weaving.
        if (dev > 0.6) deviant += 1
      }
    }
    expect(checked, 'lane-keeping samples were collected').toBeGreaterThan(200)
    expect(deviant, `${deviant}/${checked} samples off-lane > 0.6 m`).toBe(0)

    // Travel-end wraps: the wrap re-enters the SAME lane (its landing-
    // clearance contract is a separate test — it is a known defect). The
    // wrap itself is designed; what must hold is that it does not change
    // the vehicle's lane.
    let wraps = 0
    for (const [id, rs] of series) {
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1]!
        const b = rs[i]!
        const d = Math.hypot(b.x - a.x, b.z - a.z)
        if (a.road === b.road && d > 10) {
          wraps += 1
          expect(b.lane, `${id} wrapped into lane ${b.lane} from lane ${a.lane}`).toBe(a.lane)
        }
      }
    }
    // The cross scene's roads end at the map edge with no junction, so
    // wrapping is the designed continuation — at 16.7 m/s over a 60 m
    // road every vehicle wraps every ~4 s.
    expect(wraps, 'wraps occurred in the sample window').toBeGreaterThan(0)
  })

  test('cross scene: a travel-end wrap lands clear of other traffic', async ({ page }) => {
    // Guard for the landing-occupancy check added 2026-11-05: the wrap
    // used to teleport the vehicle with no check at all — observed
    // live, v-5 wrapped to within 3.8 m of v-1 (centres; bodies
    // overlap — a car is ~4.5 m long). The tick now holds the vehicle
    // at the travel end while the landing lane is occupied
    // (`wrapLandingBlocked`, clearance 8 m).
    test.setTimeout(WALL_SAMPLE_MS + 120_000)
    await waitForSceneReady(page)
    await switchScene(page, 'cross')
    await startSampler(page, SAMPLE_MS)
    await page.waitForTimeout(WALL_SAMPLE_MS)
    const samples = await collectSamples(page)
    let wraps = 0
    for (const [id, rs] of seriesOf(samples)) {
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1]!
        const b = rs[i]!
        const d = Math.hypot(b.x - a.x, b.z - a.z)
        if (a.road !== b.road || d <= 10) continue
        wraps += 1
        for (const s2 of samples) {
          if (Math.abs(s2.wt - b.wt) > 1000) continue
          for (const r2 of s2.rows) {
            if (r2.id === id || r2.road !== b.road) continue
            const gap = Math.hypot(r2.x - b.x, r2.z - b.z)
            // Same-lane centres must stay > 5 m (bodies ~4.5 m long —
            // closer means overlapping). An ADJACENT lane is 3.5 m
            // away laterally by construction, so its centres may
            // legitimately come much closer in Euclidean terms; there
            // the bound is the body widths (~1.9 m) plus margin.
            const bound = r2.lane === b.lane ? 5 : 2.5
            expect(
              gap,
              `${id} wrapped to within ${gap.toFixed(1)} m of ${r2.id} (lane ${r2.lane})`,
            ).toBeGreaterThan(bound)
          }
        }
      }
    }
    expect(wraps, 'wraps occurred in the sample window').toBeGreaterThan(0)
  })

  test('loop scene: no corner ping-pong (roadId must not flip-flop)', async ({ page }) => {
    // Guard for the junction-turn fixes added 2026-11-05: on the
    // rectangular loop, 4 of 8 vehicles used to flip road twice
    // within ~1 s at a corner (observed r-loop-0 → r-loop-3 →
    // r-loop-0 → r-loop-3, flips 206 ms–1 s apart). All four were on
    // BACKWARD-lane far-end junction entries (the clockwise
    // circulation): the turn landed at the bare junction end, whose
    // Bézier corner sits behind the exit ray for inner-lane turns, the
    // garbage arc made the lane re-derivation flip onto the oncoming
    // lane exactly at its travel end, and the decision re-fired.
    // Fixed by landing ENTRY_LEAD_M inside the entry lane, firing the
    // turn while the exit pose is still in front of the crossing
    // (`fireLeadM`), a post-turn sticky window, and the degenerate-
    // corner fallback in buildTurnArc.
    test.setTimeout(WALL_SAMPLE_MS + 120_000)
    await waitForSceneReady(page)
    await switchScene(page, 'loop')
    await startSampler(page, SAMPLE_MS)
    await page.waitForTimeout(WALL_SAMPLE_MS)
    const samples = await collectSamples(page)
    for (const [, rs] of seriesOf(samples)) {
      const flips: number[] = []
      for (let i = 1; i < rs.length; i++) {
        if (rs[i]!.road !== rs[i - 1]!.road) flips.push(rs[i]!.wt)
      }
      for (let j = 1; j < flips.length; j++) {
        const gapMs = flips[j]! - flips[j - 1]!
        // A legitimate corner passage takes several seconds (120 m
        // legs at ≤ 13.9 m/s → ≥ 8 s between flips; even a red light
        // at the corner is longer than this bound). Anything under
        // 3 s is the same junction being re-decided.
        expect(gapMs, `road flipped twice within ${gapMs} ms (ping-pong)`).toBeGreaterThan(3000)
      }
    }
  })

  test('micro-city: no travel-end wrap anywhere on the map', async ({ page }) => {
    // The micro city is fully networked: every segment runs
    // junction-to-junction, so a vehicle at its travel end always turns
    // — the edge-to-edge teleport of the cross scene cannot happen. The
    // sample window covers multiple junction passages per vehicle.
    test.setTimeout(WALL_SAMPLE_MS + 120_000)
    await waitForSceneReady(page)
    await switchScene(page, 'micro-city')
    // 4x sim clock: the light cycles (up to a 60 s actuated green) put
    // only one or two junction passages per vehicle into a wall-clock
    // window, and the lane-arrows contract needs interior turns to
    // observe. The grid specs use the same trick.
    await page.evaluate(() => {
      const w = window as unknown as { __world?: { setTickRate?: (r: number) => void } }
      w.__world?.setTickRate?.(4)
    })
    await startSampler(page, SAMPLE_MS)
    await page.waitForTimeout(WALL_SAMPLE_MS)
    const samples = await collectSamples(page)
    const series = seriesOf(samples)
    // The scene opens with 14 vehicles and none despawn.
    expect(series.size).toBeGreaterThanOrEqual(14)
    let turns = 0
    for (const [id, rs] of series) {
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1]!
        const b = rs[i]!
        const d = Math.hypot(b.x - a.x, b.z - a.z)
        // The sampler runs on wall clock; a page hiccup stretches one
        // sample's wall gap, and the sim advances with it — so the
        // distance bound scales with the measured wall time. The 4x
        // sim clock multiplies how far a wall second carries the sim.
        const wallS = ((b.wt - a.wt) / 1000) * 4
        if (a.road === b.road) {
          // Same road: motion is continuous — no teleport, no jump of
          // two lanes.
          // The bound uses the HIGHER of the two samples' speeds plus
          // an acceleration allowance: a vehicle that starts from a
          // red light travels much further than its starting speed
          // suggests over a long sample gap (measured: 11.3 m in 3.2 s
          // of sim time from 1.2 m/s — physics, not a teleport). A real
          // teleport happens inside ONE frame, where the gap is tiny
          // and the bound stays small.
          const bound = (Math.max(a.sp, b.sp) + 3) * wallS * 1.2 + 5
          expect(d, `${id} moved ${d.toFixed(1)} m in ${wallS.toFixed(2)} s`).toBeLessThan(bound)
          expect(Math.abs(b.lane - a.lane), `${id} laneIndex jump at wt=${b.wt}`).toBeLessThan(2)
        } else {
          turns += 1
          // A junction continuation is a small hop: the turn may fire
          // up to fireLeadM (~4.75 m) before the end and the arc lands
          // ~3 m into the new road, plus one sample of driving — under
          // ~18 m of geometry, never the 57 m of a cross-scene wrap.
          const bound = (a.sp || 16) * wallS * 1.5 + 18
          expect(d, `${id} junction hop of ${d.toFixed(1)} m`).toBeLessThan(bound)
        }
      }
    }
    // The map actually produces junction traffic in the window.
    expect(turns, 'junction turns occurred').toBeGreaterThan(5)
  })

  test('micro-city: turns follow the lane arrows', async ({ page }) => {
    // The lane-semantics contract, verified live: a LEFT turn only from
    // the leftmost travel lane, a RIGHT turn only from the rightmost,
    // straight from anywhere. The movement is classified from the
    // vehicle's heading change across the junction (sampled before and
    // after the arc, so the mid-turn heading noise does not matter).
    // The window is the long one: interior-to-interior turns are a
    // minority of the road changes (most traffic circulates the ring),
    // and the turn hash fires a quarter of the time.
    const MICRO_SAMPLE_MS = 60_000
    test.setTimeout(MICRO_SAMPLE_MS + 120_000)
    await waitForSceneReady(page)
    await switchScene(page, 'micro-city')
    // 4x sim clock: the light cycles (up to a 60 s actuated green) put
    // only one or two junction passages per vehicle into a wall-clock
    // window, and the lane-arrows contract needs interior turns to
    // observe. The grid specs use the same trick.
    await page.evaluate(() => {
      const w = window as unknown as { __world?: { setTickRate?: (r: number) => void } }
      w.__world?.setTickRate?.(4)
    })
    await startSampler(page, SAMPLE_MS)
    await page.waitForTimeout(MICRO_SAMPLE_MS)
    const samples = await collectSamples(page)

    const movementOf = (from: number, to: number): 'straight' | 'left' | 'right' | 'uturn' => {
      let d = (to - from) % (2 * Math.PI)
      if (d > Math.PI) d -= 2 * Math.PI
      if (d < -Math.PI) d += 2 * Math.PI
      const mag = Math.abs(d)
      if (mag > (3 * Math.PI) / 4) return 'uturn'
      if (mag <= Math.PI / 4) return 'straight'
      return d < 0 ? 'right' : 'left'
    }
    // The lane-position helpers mirror the domain's convention: the
    // forward half travels s upwards, the backward half downwards, and
    // "position from right" is 0 for the keep-right lane of whichever
    // half the vehicle is in.
    const travelLanes = (laneIndex: number, laneCount: number): number => {
      const backward = Math.floor(laneCount / 2)
      return laneIndex < backward ? laneCount - backward : backward
    }
    const positionFromRight = (laneIndex: number, laneCount: number): number =>
      laneIndex < Math.floor(laneCount / 2) ? laneIndex : laneCount - 1 - laneIndex

    let lefts = 0
    let rights = 0
    for (const [, rs] of seriesOf(samples)) {
      for (let i = 1; i < rs.length; i++) {
        if (rs[i]!.road === rs[i - 1]!.road) continue
        const before = rs[i - 1]!
        // The `after` heading must be past the arc: at i+2 (0.4 s) the
        // body can still be mid-sweep, and a 90° turn then classifies as
        // straight. Four samples (0.8 s) clear an arc at scene speeds.
        const after = rs[Math.min(rs.length - 1, i + 4)]!
        if (after.road !== rs[i]!.road) continue // next junction already reached — skip this one
        const movement = movementOf(before.h, after.h)
        if (movement === 'uturn' || movement === 'straight') continue
        // Turns onto a one-way RING road are exempt: at a ring junction
        // the ring's flow leaves exactly one movement open (measured:
        // the southbound arterial at the SW corner can only turn west),
        // so the arrows paint that single movement and every lane takes
        // it. The lane-position rule is asserted where the junction
        // actually offers a choice — interior-to-interior turns.
        const target = rs[i]!.road
        const isRing = /mc-(ew-r0|ew-r2|ns-c0|ns-c3)/.test(target)
        if (isRing) continue
        // The lane count of the road the vehicle was ON. The sampler
        // stores per-row lane data only, so infer it from the road id
        // convention (mc-*): the middle EW row is the 6-lane arterial,
        // the one-way couplet and the NS arterial are 4-lane, the rest
        // of the columns are 2-lane locals.
        const laneCount = before.road.startsWith('mc-ew-r1')
          ? 6
          : before.road.startsWith('mc-ns-c1')
            ? 4
            : 2 // the one-way ring streets and the local column
        const pos = positionFromRight(before.lane, laneCount)
        const last = travelLanes(before.lane, laneCount) - 1
        if (movement === 'left') {
          lefts += 1
          expect(pos, `left turn from lane position ${pos}/${last} on ${before.road}`).toBe(last)
        } else {
          rights += 1
          expect(pos, `right turn from lane position ${pos} on ${before.road}`).toBe(0)
        }
      }
    }
    // The window saw both kinds of turn — the rule is exercised, not
    // vacuously true.
    expect(lefts, `lefts=${lefts} rights=${rights}`).toBeGreaterThan(0)
    expect(rights, `lefts=${lefts} rights=${rights}`).toBeGreaterThan(0)
  })
})

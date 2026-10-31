// The observation builder's unit checks — hand-computed cases.
//
// The full parity against Python lives in `driveObservationParity.spec.ts`
// (the committed scene states and their 23-dim vectors). This spec pins
// the individual semantics the parity fixture happens to exercise only
// in combination: the arrival floor, the clamps, the ranking, the empty
// slots, and the rotation into the ego's frame.

import { describe, it, expect } from 'vitest'
import { buildDriveObservation, DRIVE_ARRIVAL_TOLERANCE_M, DRIVE_OBS_DIM } from './driveObservation'

const ORIGIN = { x: 0, z: 0 }

const self = (overrides: Record<string, number> = {}) => ({
  x: -30,
  z: 0,
  heading: 0,
  speed: 10,
  routeProgress: 0.25,
  ...overrides,
})

const observation = (
  overrides: Record<string, number> = {},
  others: readonly { x: number; z: number; speed: number }[] = [],
) => buildDriveObservation({ conflictPoint: ORIGIN, self: self(overrides), others })

describe('buildDriveObservation', () => {
  it('has the declared dimension', () => {
    expect(observation()).toHaveLength(DRIVE_OBS_DIM)
    expect(DRIVE_OBS_DIM).toBe(23)
  })

  it('normalises the own state', () => {
    const obs = observation({ speed: 8.335, routeProgress: 0.4 })
    // [0] speed / 16.67
    expect(obs[0]).toBeCloseTo(8.335 / 16.67, 12)
    // [1] distance / 100 — the vehicle sits 30 m from the junction.
    expect(obs[1]).toBeCloseTo(0.3, 12)
    // [2] arrival time (30 / 8.335 = 3.599 s) / 20
    expect(obs[2]).toBeCloseTo(30 / 8.335 / 20, 12)
    // [3] the junction is dead ahead — bearing 0.
    expect(obs[3]).toBeCloseTo(0, 12)
    // [4] route progress, handed in.
    expect(obs[4]).toBe(0.4)
  })

  it('floors the arrival speed at 0.5 — a standing car arrives "late, finite"', () => {
    const obs = observation({ speed: 0 })
    // 30 m at the 0.5 m/s floor = 60 s; / 20 = 3 → clamped to 1.
    expect(obs[2]).toBe(1)
  })

  it('clamps the distance and the arrival at their bounds', () => {
    const obs = observation({ x: -500, speed: 1 })
    expect(obs[1]).toBe(1) // 500 m / 100
    // 500 s / 20 → clamped.
    expect(obs[2]).toBe(1)
  })

  it('points the bearing at the junction, in the vehicle’s frame', () => {
    // The junction is dead BEHIND the vehicle (heading +z, the junction
    // at -z): the bearing is pi, wrapped to -pi, / pi = -1.
    const behind = observation({ x: 0, z: 30, heading: Math.PI / 2 })
    expect(behind[3]).toBeCloseTo(-1, 12)
    // A quarter turn to the LEFT of the heading (+x): +0.5.
    const left = observation({ x: 0, z: -30, heading: 0 })
    expect(left[3]).toBeCloseTo(0.5, 12)
  })

  it('flags the vehicle inside the arrival tolerance', () => {
    // Just OUTSIDE the 2 m tolerance.
    expect(observation({ x: -DRIVE_ARRIVAL_TOLERANCE_M - 0.1 })[5]).toBe(0)
    // Just inside it.
    expect(observation({ x: -DRIVE_ARRIVAL_TOLERANCE_M + 0.1 })[5]).toBe(1)
  })

  it('counts the others that arrive earlier over ALL of them', () => {
    // Three others: two closer and moving, one farther. The vehicle's
    // own arrival is 3 s; the movers arrive in 2 s and 2.5 s, the far
    // standing one at 80/0.5 = 160 s.
    const obs = observation({ speed: 10 }, [
      { x: -20, z: 0, speed: 10 }, // 20 m → 2 s — earlier
      { x: -25, z: 0, speed: 10 }, // 25 m → 2.5 s — earlier
      { x: -80, z: 0, speed: 0 }, // 80 m standing → later
      { x: -70, z: 0, speed: 0 }, // 70 m standing → later (not in a slot)
    ])
    expect(obs[6]).toBeCloseTo(2 / 4, 12)
    // The earliest difference: 2 s - 3 s = -1 s, / 10.
    expect(obs[7]).toBeCloseTo(-0.1, 12)
  })

  it('ranks the slots by distance to the SELF vehicle, not to the junction', () => {
    // The self sits at (-30, 0), so the car at (-25, 0) is 5 m away —
    // the nearest, although the (-12, 0) car is closest to the
    // JUNCTION. The ranking is the core's: nearest to SELF.
    const obs = observation({ speed: 10 }, [
      { x: -40, z: 0, speed: 5 }, // 10 m from self — second
      { x: -12, z: 0, speed: 5 }, // 18 m from self — third
      { x: -25, z: 0, speed: 5 }, // 5 m from self — first
    ])
    // Slot 0: the (-25, 0) car. Its offset from the CONFLICT point, in
    // the ego's frame (heading 0): dx = -25, dz = 0 → x' = -25/50.
    expect(obs[8]).toBe(1)
    expect(obs[9]).toBeCloseTo(-25 / 50, 12)
    expect(obs[10]).toBeCloseTo(0, 12)
    expect(obs[11]).toBeCloseTo(5 / 16.67, 12)
    // Slot 1: the (-40, 0) car.
    expect(obs[13]).toBe(1)
    expect(obs[14]).toBeCloseTo(-40 / 50, 12)
    // Slot 2: the (-12, 0) car.
    expect(obs[18]).toBe(1)
    expect(obs[19]).toBeCloseTo(-12 / 50, 12)
  })

  it('rotates the slot offsets into the ego’s frame', () => {
    // Heading north (+z = pi/2); a car sitting 10 m east of the
    // junction. In the ego's frame (x forward, z ... the frame rotates
    // by -heading): dx = 10, dz = 0, cos(-pi/2) = 0, sin(-pi/2) = -1
    // → x' = dx*0 - 0*(-1) = 0, z' = dx*(-1) + 0*0 = -10 → /50.
    const obs = observation({ x: 0, z: 30, heading: Math.PI / 2 }, [{ x: 10, z: 0, speed: 5 }])
    expect(obs[9]).toBeCloseTo(0, 12)
    expect(obs[10]).toBeCloseTo(-10 / 50, 12)
  })

  it('leaves the slots zero when there is nobody else', () => {
    const obs = observation()
    for (let i = 8; i < 23; i += 1) expect(obs[i]).toBe(0)
    // Nobody arrives earlier than me: the count is 0 / max(1, 0) = 0.
    expect(obs[6]).toBe(0)
    expect(obs[7]).toBe(0)
  })
})

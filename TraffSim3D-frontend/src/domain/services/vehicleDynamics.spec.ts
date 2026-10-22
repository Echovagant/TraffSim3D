// Vehicle dynamics unit tests.
//
// Covers all four exports:
//   - smoothAccel: per-type accel ramp, snap-to-target convergence,
//     reverse-direction decel
//   - safeGapGipps: closing on stationary leader; following at same
//     speed; following faster leader
//   - statusFromHysteresis: flicker prevention, crash stickiness,
//     waiting one-way trap
//   - clampTargetSpeedByType: respects road limit + type
//   - handRolledStep: convenience wrapper

import { describe, it, expect } from 'vitest'
import {
  smoothAccel,
  safeGapGipps,
  statusFromHysteresis,
  clampTargetSpeedByType,
  handRolledStep,
} from './vehicleDynamics'
import type { Vehicle } from '@domain/entities/Vehicle'

const makeVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
  id: 'v-test',
  type: 'car',
  color: '#3a86ff',
  position: { x: 0, y: 0, z: 0 },
  heading: 0,
  speed: 0,
  targetSpeed: 16.67,
  roadId: 'r-ns',
  laneIndex: 0,
  s: 10,
  lane: 'r-ns:0' as never,
  status: 'driving',
  desiredStatus: 'driving',
  enteredIntersectionAt: null,
  desiredLaneIndex: null,
  laneChangeStartedAt: null,
  spawnedAt: 0,
  ...overrides,
})

describe('smoothAccel', () => {
  it('acceleration is capped at the per-type accel limit', () => {
    // 2.0 m/s² comfy, dt = 0.1 → +0.2 m/s per call
    const v0 = 0
    const v1 = smoothAccel(v0, 20, 0.1, 'car')
    expect(v1).toBeCloseTo(0.2, 6)
  })

  it('truck accelerates slower than car (per-type VEHICLE_DYN)', () => {
    const vCar = smoothAccel(0, 20, 1.0, 'car')
    const vTruck = smoothAccel(0, 20, 1.0, 'truck')
    expect(vTruck).toBeLessThan(vCar)
    // truck accel = 2.0 * 0.7 = 1.4 m/s²
    expect(vTruck).toBeCloseTo(1.4, 6)
  })

  it('snaps to targetSpeed when within one dt of acceleration', () => {
    const v = smoothAccel(19.95, 20, 0.1, 'car') // 0.05 gap < 2.0*0.1 = 0.2
    expect(v).toBe(20)
  })

  it('deceleration uses the per-type decel cap', () => {
    // car decel = 2.5 m/s², dt = 1 → -2.5 m/s per call (when target < current)
    const v = smoothAccel(20, 15, 1.0, 'car')
    expect(v).toBeCloseTo(17.5, 6)
  })

  it('clamps to 0 when decelerating past zero (no reverse driving)', () => {
    const v = smoothAccel(1, 0, 1.0, 'car')
    expect(v).toBe(0) // dt*decel = 2.5 > gap 1 → snap to 0
  })

  it('dt=0 returns current speed (no-op guard)', () => {
    const v = smoothAccel(5, 10, 0, 'car')
    expect(v).toBe(5)
  })
})

describe('safeGapGipps', () => {
  it('Newell baseline (Δv=0): speed*TIME_HEADWAY + MIN_GAP', () => {
    const g = safeGapGipps(10, 10, 100, 1.5, 2.0)
    expect(g).toBeCloseTo(10 * 1.5 + 2.0, 6) // 17 m
  })

  it('closing on stationary leader adds braking component', () => {
    const gSame = safeGapGipps(10, 10, 100, 1.5, 2.0)
    const gClosing = safeGapGipps(10, 0, 100, 1.5, 2.0)
    expect(gClosing).toBeGreaterThan(gSame)
    // 10 * (10 - 0) / (2 * 2.5) = 20 m extra
    expect(gClosing - gSame).toBeCloseTo(20, 6)
  })

  it('relative speed matters: Δv ≠ 0 adds the braking component', () => {
    // Gipps' braking term grows with both |Δv| and the follower's own
    // speed. Closing on a stationary leader at 10 m/s adds 20 m of gap;
    // following a faster leader at 5 m/s with the same Δv=10 only adds
    // 10 m because the follower's lower speed needs less of a margin.
    const gSame = safeGapGipps(10, 10, 100, 1.5, 2.0) // 17 m
    const gClosing = safeGapGipps(10, 0, 100, 1.5, 2.0) // 37 m
    const gFaster = safeGapGipps(5, 15, 100, 1.5, 2.0) // 19.5 m
    expect(gClosing).toBeCloseTo(gSame + 20, 6)
    expect(gFaster).toBeCloseTo(gSame + 2.5, 6)
  })
})

describe('statusFromHysteresis', () => {
  it('waiting → driving requires speed >= DRIVING_SPEED_THRESHOLD (1.0)', () => {
    // speed 0.5 < 1.0 → still waiting even though desired=driving
    expect(statusFromHysteresis('waiting', 'driving', 0.5)).toBe('waiting')
    // speed 1.5 ≥ 1.0 → promote to driving
    expect(statusFromHysteresis('waiting', 'driving', 1.5)).toBe('driving')
  })

  it('driving → waiting only below WAITING_SPEED_THRESHOLD (0.3)', () => {
    // speed 0.5 ≥ 0.3 → stay driving (hysteresis prevents flicker)
    expect(statusFromHysteresis('driving', 'driving', 0.5)).toBe('driving')
    // speed 0.1 < 0.3 → drop to waiting
    expect(statusFromHysteresis('driving', 'driving', 0.1)).toBe('waiting')
  })

  it('flicker test: speed oscillates 1.5 → 0.5 → 1.0 → 0.4 stays driving', () => {
    let s: 'driving' | 'waiting' | 'crashed' = 'waiting'
    s = statusFromHysteresis(s, 'driving', 1.5) // → driving
    expect(s).toBe('driving')
    s = statusFromHysteresis(s, 'driving', 0.5) // stay driving (≥ 0.3)
    expect(s).toBe('driving')
    s = statusFromHysteresis(s, 'driving', 1.0)
    expect(s).toBe('driving')
    s = statusFromHysteresis(s, 'driving', 0.4) // still ≥ 0.3 → driving
    expect(s).toBe('driving')
  })

  it('crashed is sticky — desiredStatus=driving cannot un-crash', () => {
    expect(statusFromHysteresis('crashed', 'driving', 100)).toBe('crashed')
    expect(statusFromHysteresis('crashed', 'waiting', 0)).toBe('crashed')
  })

  it('controller asks for crash → status flips immediately', () => {
    expect(statusFromHysteresis('driving', 'crashed', 10)).toBe('crashed')
  })

  it('controller asks for waiting → status flips to waiting regardless of speed', () => {
    expect(statusFromHysteresis('driving', 'waiting', 15)).toBe('waiting')
  })
})

describe('clampTargetSpeedByType', () => {
  it('clamps to road speed limit (no overspeed)', () => {
    expect(clampTargetSpeedByType(30, 'car', 16.67)).toBe(16.67)
  })

  it('clamps to 0 (no negative target speed)', () => {
    expect(clampTargetSpeedByType(-5, 'car', 16.67)).toBe(0)
  })

  it('returns desired if within road limit', () => {
    expect(clampTargetSpeedByType(10, 'car', 16.67)).toBe(10)
  })
})

describe('handRolledStep', () => {
  it('ramps speed toward targetSpeed using per-type dynamics', () => {
    const v = makeVehicle({ speed: 0, targetSpeed: 10 })
    const next = handRolledStep(v, 1.0) // car accel = 2.0
    expect(next).toBeCloseTo(2.0, 6)
  })
})

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DriveGauge from './DriveGauge.vue'

/** The transform the wheel group ends up with, for a given wheel angle. */
const wheelRotation = (steerDeg: number): string => {
  const wrapper = mount(DriveGauge, { props: { speedMps: 10, limitMps: 14, steerDeg } })
  return wrapper.find('svg.wheel g').attributes('transform') ?? ''
}

describe('DriveGauge — the steering wheel', () => {
  it('sits straight when the wheels are straight', () => {
    expect(wheelRotation(0)).toContain('rotate(0.0')
  })

  it('turns counter-clockwise for a left angle (the simulation convention)', () => {
    // 17.5° is half of a real car's 35° lock, so half of the icon's 140°.
    // Negative in SVG: a left turn is counter-clockwise on screen.
    expect(wheelRotation(17.5)).toContain('rotate(-70.0')
    expect(wheelRotation(-17.5)).toContain('rotate(70.0')
  })

  it('stops at the lock instead of spinning — a real rack does not go further', () => {
    expect(wheelRotation(90)).toContain('rotate(-140.0')
    expect(wheelRotation(-90)).toContain('rotate(140.0')
  })
})

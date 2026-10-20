import { describe, it, expect } from 'vitest'
import { LightPhase } from './Phase'

describe('LightPhase', () => {
  it('has exactly 10 values (016 H2 exhaustiveness)', () => {
    expect(Object.keys(LightPhase).length).toBe(10)
  })
  it('M1 values keep their string identity (backward compat with v3 saved scenes)', () => {
    expect(LightPhase.Green).toBe('green')
    expect(LightPhase.Yellow).toBe('yellow')
    expect(LightPhase.Red).toBe('red')
  })
  it('M2-B new values exist with expected string values', () => {
    expect(LightPhase.GreenLeft).toBe('greenLeft')
    expect(LightPhase.YellowLeft).toBe('yellowLeft')
    expect(LightPhase.RedLeft).toBe('redLeft')
    expect(LightPhase.FlashingYellow).toBe('flashingYellow')
    expect(LightPhase.FlashingRed).toBe('flashingRed')
    expect(LightPhase.AllRed).toBe('allRed')
    expect(LightPhase.Dark).toBe('dark')
  })
  it('LightPhase type is a string union (assignment compiles)', () => {
    const v: LightPhase = LightPhase.Green
    expect(typeof v).toBe('string')
  })
})

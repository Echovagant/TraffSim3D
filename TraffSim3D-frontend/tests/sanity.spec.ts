// TraffSim3D-frontend/tests/sanity.spec.ts
//
// Sanity test — proves Vitest + happy-dom + alias resolution work.
// Delete or replace with real tests in plan 015.

import { describe, it, expect } from 'vitest'
import { LightPhase } from '@domain/value-objects/Phase'

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })

  it('resolves @domain alias', () => {
    expect(LightPhase.Green).toBe('green')
  })

  it('happy-dom environment is loaded', () => {
    expect(typeof document).toBe('object')
  })
})

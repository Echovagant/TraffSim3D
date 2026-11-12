/**
 * The signal-controller options — the RL entry's label in particular.
 *
 * It used to be a fixed string, "RL (未实装·回退固定周期)", in TWO
 * components (the editor toolbar and the readout drawer). So the UI
 * claimed the policy was missing while it was in fact installed and
 * driving the signals: the AI Proving Ground installs the shipped
 * grid policy, and the grid scene then runs on it.
 *
 * A label that lies about the state of the system is worse than no
 * label — the reader cannot tell which of the two situations they are
 * looking at. These tests pin the truthfulness.
 */
import { describe, expect, it } from 'vitest'
import { controllerOptions } from './controllerOptions'

const rlLabel = (installed: boolean, origin: 'shipped' | 'checkpoint' | null): string =>
  controllerOptions(installed, origin).find((o) => o.value === 'rl')?.label ?? ''

describe('the signal controller options', () => {
  it('offers the four controllers the product supports', () => {
    expect(controllerOptions(false, null).map((o) => o.value)).toEqual([
      'fixed-cycle',
      'actuated',
      'coordinated',
      'rl',
    ])
  })

  it('says the RL policy is NOT installed when none is loaded', () => {
    expect(rlLabel(false, null)).toContain('未实装')
    expect(rlLabel(false, null)).toContain('回退固定周期')
  })

  it('says the RL policy IS installed when one is loaded', () => {
    expect(rlLabel(true, 'shipped')).toContain('已实装')
    expect(rlLabel(true, 'shipped')).not.toContain('未实装')
    expect(rlLabel(true, 'shipped')).toContain('产品附带策略')
  })

  it('names the source when the policy came from a checkpoint', () => {
    expect(rlLabel(true, 'checkpoint')).toContain('所选 checkpoint')
  })
})

import { describe, it, expect } from 'vitest';
import { RLController } from './RLController';
import { makeTestLight, buildTestNetwork } from '@__fixtures__/testNetwork';
import { LightPhase } from '@domain/value-objects/Phase';

describe('RLController', () => {
  const c = new RLController();

  it('M4 stub: green → yellow at phaseRemaining=0 (delegates to FixedCycle)', () => {
    const net = buildTestNetwork();
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Yellow);
  });

  it('M4 stub: stays in green while phaseRemaining > 0', () => {
    const net = buildTestNetwork();
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Green);
  });

  it('applyAction is a no-op (M4 will route through PPO)', () => {
    const net = buildTestNetwork();
    const light = makeTestLight();
    expect(() => c.applyAction(light, 'preempt')).not.toThrow();
  });
});
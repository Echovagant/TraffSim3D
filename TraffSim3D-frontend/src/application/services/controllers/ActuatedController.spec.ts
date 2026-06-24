import { describe, it, expect } from 'vitest';
import { ActuatedController } from './ActuatedController';
import { makeTestLight, buildTestNetwork } from '@__fixtures__/testNetwork';
import { LightPhase } from '@domain/value-objects/Phase';
import { MAX_GREEN_SECS, GREEN_EXTENSION_STEP, MIN_RED_SECS } from '@shared/constants/simulation';

describe('ActuatedController', () => {
  const c = new ActuatedController();

  it('extends green by GREEN_EXTENSION_STEP when queue > 0', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Green);
    expect(d.duration).toBe(10 + GREEN_EXTENSION_STEP);
  });

  it('does not extend green when queue = 0', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 });
    const d = c.decide(light, net, 0);
    expect(d.duration).toBe(10);
  });

  it('caps green at MAX_GREEN_SECS', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: MAX_GREEN_SECS - 1 });
    const d = c.decide(light, net, 0);
    expect(d.duration).toBeLessThanOrEqual(MAX_GREEN_SECS);
  });

  it('green → yellow when phaseRemaining hits 0', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Yellow);
    expect(d.duration).toBe(3);
  });

  it('shortens red when opposite axis queue = 0 (016 H4)', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Yellow);
    expect(d.actions[0]?.name).toBe('shorten_red');
  });

  it('does not shorten red below MIN_RED_SECS', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: MIN_RED_SECS, axis: 'ns' });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Red);
  });

  it('does not shorten red when opposite axis has cars', () => {
    const net = buildTestNetwork(1);
    net.vehicles['v-1']!.roadId = 'r-ew';
    net.vehicles['v-1']!.s = 5;
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Red);
  });

  it('yellow → red when phaseRemaining hits 0', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 0 });
    const d = c.decide(light, net, 0);
    expect(d.phase).toBe(LightPhase.Red);
    expect(d.duration).toBe(30);
  });
});
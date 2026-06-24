import { describe, it, expect } from 'vitest';
import { LightPhase } from '@domain/value-objects/Phase';
import { PHASE_COLOR, PHASE_EMISSIVE_INTENSITY } from './TrafficLightNode';

describe('TrafficLightNode constants', () => {
  it('PHASE_COLOR has 10 keys (016 H2 exhaustiveness)', () => {
    expect(Object.keys(PHASE_COLOR).length).toBe(10);
  });
  it('PHASE_EMISSIVE_INTENSITY has 10 keys', () => {
    expect(Object.keys(PHASE_EMISSIVE_INTENSITY).length).toBe(10);
  });
  it('PHASE_COLOR[Dark] is near-black (0x1a1a1a)', () => {
    expect(PHASE_COLOR[LightPhase.Dark]).toBe(0x1a1a1a);
  });
  it('Left family shares hue with base (M2-D will differentiate by shape)', () => {
    expect(PHASE_COLOR[LightPhase.GreenLeft]).toBe(PHASE_COLOR[LightPhase.Green]);
    expect(PHASE_COLOR[LightPhase.YellowLeft]).toBe(PHASE_COLOR[LightPhase.Yellow]);
    expect(PHASE_COLOR[LightPhase.RedLeft]).toBe(PHASE_COLOR[LightPhase.Red]);
  });
  it('PHASE_EMISSIVE_INTENSITY[Dark] is 0 (故障时不发光)', () => {
    expect(PHASE_EMISSIVE_INTENSITY[LightPhase.Dark]).toBe(0);
  });
});
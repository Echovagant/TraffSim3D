import { describe, it, expect } from 'vitest';
import { getQueueLength, getAxisQueueLength } from './signalController';
import { buildTestNetwork, makeTestLight, makeTestVehicle } from '@__fixtures__/testNetwork';
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation';
import { roadLength } from '@domain/services/laneGeometry';

describe('getQueueLength', () => {
  it('returns 0 for empty network', () => {
    const net = buildTestNetwork(0);
    const light = makeTestLight();
    expect(getQueueLength(light, net)).toBe(0);
  });
  it('counts a single car on the light\'s axis lane before stop line', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight();
    expect(getQueueLength(light, net)).toBe(1);
  });
  it('excludes cars past the stop line', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight();
    const len = roadLength(net.roads['r-ns']!);
    net.vehicles['v-1']!.s = len / 2 + STOP_LINE_DISTANCE + 1;
    expect(getQueueLength(light, net)).toBe(0);
  });
  it('excludes crashed cars (007 R2 mitigation)', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight();
    net.vehicles['v-1']!.status = 'crashed';
    expect(getQueueLength(light, net)).toBe(0);
  });
  it('excludes cars in the intersection box (enteredIntersectionAt !== null)', () => {
    const net = buildTestNetwork(1);
    const light = makeTestLight();
    net.vehicles['v-1']!.enteredIntersectionAt = 1.5;
    expect(getQueueLength(light, net)).toBe(0);
  });
  it('respects controlledLane filter', () => {
    const net = buildTestNetwork(2);
    const light = makeTestLight({ controlledLane: 0 });
    net.vehicles['v-1']!.laneIndex = 0;
    net.vehicles['v-2']!.laneIndex = 1;
    expect(getQueueLength(light, net)).toBe(1);
  });
  it('ignores cars on the wrong road', () => {
    const net = buildTestNetwork(2);
    const light = makeTestLight();
    net.vehicles['v-2']!.roadId = 'r-ew';
    expect(getQueueLength(light, net)).toBe(1);
  });
  it('getAxisQueueLength counts across all lanes on the axis', () => {
    const net = buildTestNetwork(2);
    const light = makeTestLight();
    net.vehicles['v-1']!.laneIndex = 0;
    net.vehicles['v-2']!.laneIndex = 1;
    expect(getAxisQueueLength(light, net)).toBe(2);
  });
});
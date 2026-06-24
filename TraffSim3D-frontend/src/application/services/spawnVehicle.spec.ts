import { describe, it, expect } from 'vitest';
import { spawnVehicle } from './spawnVehicle';
import { buildTestNetwork } from '@__fixtures__/testNetwork';

describe('spawnVehicle', () => {
  it('returns {ok: true, vehicle} when a free lane exists', () => {
    const net = buildTestNetwork(0);
    const r = spawnVehicle(net, 'v-99');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vehicle.id).toBe('v-99');
      expect(r.vehicle.roadId).toMatch(/^r-/);
    }
  });

  it('honors type override', () => {
    const net = buildTestNetwork(0);
    const r = spawnVehicle(net, 'v-99', { type: 'bus' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vehicle.type).toBe('bus');
  });

  it('honors color override', () => {
    const net = buildTestNetwork(0);
    const r = spawnVehicle(net, 'v-99', { color: '#ff00ff' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vehicle.color).toBe('#ff00ff');
  });

  it('sets initial status = waiting if speed < 0.5', () => {
    const net = buildTestNetwork(0);
    const r = spawnVehicle(net, 'v-99', { speed: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vehicle.status).toBe('waiting');
  });

  it('returns {ok: false} when no lane has a free window (both roads too short)', () => {
    const net = buildTestNetwork(0);
    // Make BOTH roads too short to fit the minimum gap.
    net.roads['r-ns'] = {
      ...net.roads['r-ns']!,
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 0, y: 0, z: 2 },
    };
    net.roads['r-ew'] = {
      ...net.roads['r-ew']!,
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 2, y: 0, z: 0 },
    };
    const r = spawnVehicle(net, 'v-99');
    expect(r.ok).toBe(false);
  });
});
import { describe, it, expect } from 'vitest';
import { cloneScene, sceneToNetwork, serializeNetwork } from '@infrastructure/persistence';
import { buildTestNetwork } from '@__fixtures__/testNetwork';

describe('sceneSerializer round-trip', () => {
  it('cloneScene produces a deep-independent copy', () => {
    const net = buildTestNetwork(2);
    const scene = serializeNetwork(net);
    const cloned = cloneScene(scene);
    // Mutate the original; cloned should not see it.
    net.vehicles['v-1']!.color = '#000000';
    expect(cloned.network.vehicles.find((v) => v.id === 'v-1')!.color).not.toBe('#000000');
  });

  it('sceneToNetwork restores a valid network', () => {
    const net = buildTestNetwork(2);
    const scene = serializeNetwork(net);
    const restored = sceneToNetwork(scene);
    expect(restored.roads['r-ns']).toBeDefined();
    expect(Object.keys(restored.vehicles).length).toBe(2);
  });

  it('serialized scene includes schemaVersion 4 + savedAtMs', () => {
    const net = buildTestNetwork(0);
    const scene = serializeNetwork(net);
    expect(scene.schemaVersion).toBe(4);
    expect(typeof scene.savedAtMs).toBe('number');
  });
});
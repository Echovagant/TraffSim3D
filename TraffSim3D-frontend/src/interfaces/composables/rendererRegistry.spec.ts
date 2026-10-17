// Unit tests for src/interfaces/composables/rendererRegistry.ts
//
// Deliberately trivial module: one module-scope slot holding the main
// ThreeJSRenderer so CameraView can reuse it instead of constructing a
// second renderer (a second renderer = a second RAF loop = the FPS
// counter doubles). Fresh-import per test to reset the slot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreeJSRenderer } from '@infrastructure/rendering';

const loadModule = async (): Promise<typeof import('./rendererRegistry')> => {
  vi.resetModules();
  return import('./rendererRegistry');
};

describe('rendererRegistry', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null before any renderer is registered', async () => {
    const m = await loadModule();
    expect(m.getMainRenderer()).toBeNull();
  });

  it('round-trips the exact renderer instance that was set', async () => {
    const m = await loadModule();
    const fake = { frameCount: 0 } as unknown as ThreeJSRenderer;

    m.setMainRenderer(fake);

    expect(m.getMainRenderer()).toBe(fake);
  });

  it('the second setMainRenderer replaces (does not stack) the first', async () => {
    const m = await loadModule();
    const first = { frameCount: 1 } as unknown as ThreeJSRenderer;
    const second = { frameCount: 2 } as unknown as ThreeJSRenderer;

    m.setMainRenderer(first);
    m.setMainRenderer(second);

    expect(m.getMainRenderer()).toBe(second);
  });

  it('setMainRenderer(null) clears the slot', async () => {
    const m = await loadModule();
    m.setMainRenderer({} as unknown as ThreeJSRenderer);
    expect(m.getMainRenderer()).not.toBeNull();

    m.setMainRenderer(null);

    expect(m.getMainRenderer()).toBeNull();
  });
});

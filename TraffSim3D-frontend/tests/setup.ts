// TraffSim3D-frontend/tests/setup.ts
//
// Global Vitest setup. Runs once per test file before any specs.
// Keep this file SMALL — the goal is to stub the things every test
// needs (Rapier WASM, etc.), not to provide a fixture library. Tests
// that need more should import it explicitly.

import { vi } from 'vitest';

// Rapier lazy-loads via `await import('@dimforge/rapier3d-compat')`.
// In a unit test, we don't want to load the full WASM (slow + flaky).
// Stub the import with a no-op module. Plan 015's tick tests will
// pass a mock RapierWorld via the worldStore seam.
vi.mock('@dimforge/rapier3d-compat', () => ({
  default: {},
  init: vi.fn().mockResolvedValue(undefined),
  World: vi.fn(),
  EventQueue: vi.fn(),
  RigidBodyDesc: { dynamic: vi.fn(), fixed: vi.fn() },
  ColliderDesc: { cuboid: vi.fn() },
  Ray: vi.fn(),
}));

// Pinia in tests — use createPinia() in each test that needs it
// (don't enable globally; the per-test pinia() pattern is cleaner).

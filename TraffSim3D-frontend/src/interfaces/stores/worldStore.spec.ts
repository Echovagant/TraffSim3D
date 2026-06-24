// Plan 035 follow-up: regression test for the `switchScene` bug.
//
// Bug history: `worldStore.network` was originally a plain closure
// variable; `replaceNetwork` did `network = next`. Pinia setup stores
// do NOT track plain reassignments, so consumers like EntityOutline
// (which read `world.network` and depended on the in-place-mutation
// contract) saw the stale initial reference even after the Three.js
// renderer rebuilt. Switches from "cross" → "t" / "loop" had no
// visible effect in the UI.
//
// Fix: `network` is now `shallowRef`. Pinia auto-unwraps it on the
// store so `world.network` reflects the latest value reactively. This
// test pins the contract: `switchScene('t')` must produce a network
// whose `roads` / `intersections` / `vehicles` come from the T
// factory, and `currentSceneKind` must update.

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorldStore } from './worldStore';
import { buildCrossIntersectionNetwork, buildTJunctionNetwork, buildRectangularLoopNetwork } from '@application/services/defaultScene';

describe('worldStore.switchScene', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('default scene is the cross-intersection factory output', () => {
    const world = useWorldStore();
    const expected = buildCrossIntersectionNetwork();
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort());
    expect(world.currentSceneKind).toBe('cross');
  });

  it('switchScene("t") replaces network with the T-junction factory output', () => {
    const world = useWorldStore();
    world.switchScene('t');
    const expected = buildTJunctionNetwork();
    expect(world.currentSceneKind).toBe('t');
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort());
    expect(Object.keys(world.network.intersections).length).toBe(1);
    expect(Object.values(world.network.intersections)[0]!.connectedRoads.length).toBe(3);
    // Vehicles dropped from 6 (cross) to 4 (T).
    expect(Object.keys(world.network.vehicles).length).toBe(4);
  });

  it('switchScene("loop") replaces network with the rectangular-loop factory output', () => {
    const world = useWorldStore();
    world.switchScene('loop');
    const expected = buildRectangularLoopNetwork();
    expect(world.currentSceneKind).toBe('loop');
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort());
    expect(Object.keys(world.network.intersections).length).toBe(4);
    expect(Object.keys(world.network.vehicles).length).toBe(8);
  });

  it('switchScene("t") then switchScene("loop") leaves the store on the loop scene', () => {
    const world = useWorldStore();
    world.switchScene('t');
    world.switchScene('loop');
    expect(world.currentSceneKind).toBe('loop');
    expect(Object.keys(world.network.vehicles).length).toBe(8);
  });
});
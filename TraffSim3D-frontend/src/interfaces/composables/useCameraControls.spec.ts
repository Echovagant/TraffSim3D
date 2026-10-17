// Unit tests for src/interfaces/composables/useCameraControls.ts
//
// Three real collaborators are used on purpose: THREE.Vector3 /
// PerspectiveCamera math, the real OrbitControls, and the real
// requestAnimationFrame loop. Only Two things are faked: the
// ThreeJSRenderer seam (a real one needs a WebGL context that
// happy-dom cannot provide) and the clock, via fake timers so the
// 400ms camera lerp can be driven deterministically.
//
// Assertions target camera *values* (target point, distance, polar
// angle, zoom limits) — never rendering.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, h, ref, nextTick, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import * as THREE from 'three';
import { useCameraControls } from './useCameraControls';
import { requestCameraFocus, requestFitToNetwork, consumePendingFocus, consumePendingFit } from './useCameraFocus';
import { computeNetworkBounds } from '@domain/services/networkBounds';
import type { ThreeJSRenderer } from '@infrastructure/rendering';
import type { NetworkBounds } from '@domain/services/networkBounds';

type OrbitControlsLike = {
  target: THREE.Vector3;
  object: THREE.PerspectiveCamera;
  minDistance: number;
  maxDistance: number;
  enableDamping: boolean;
  dampingFactor: number;
  maxPolarAngle: number;
  mouseButtons: Record<string, number>;
  dispose: () => void;
  update: () => void;
};

const bounds = (over: Partial<NetworkBounds> = {}): NetworkBounds => ({
  minX: 0, maxX: 100, minZ: 0, maxZ: 100,
  centerX: 50, centerZ: 50, diagonal: 100,
  roadCount: 2, intersectionCount: 2,
  ...over,
});

interface Harness {
  wrapper: VueWrapper;
  camera: THREE.PerspectiveCamera;
  attachControls: ReturnType<typeof vi.fn>;
  controls: () => OrbitControlsLike;
  setCanvas: (canvas: HTMLCanvasElement | null) => Promise<void>;
  dispose: () => void;
}

const mountControls = (canvas: HTMLCanvasElement | null = document.createElement('canvas')): Harness => {
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 2000);
  camera.position.set(0, 50, 100);

  const attachControls = vi.fn();
  // Test double: cast through unknown because the stub only implements
  // two of ThreeJSRenderer's methods (and ref() unwraps the arg type).
  const rendererRef = ref({
    getCamera: () => camera,
    attachControls,
  }) as unknown as Ref<ThreeJSRenderer | null>;
  const canvasRef = ref<HTMLCanvasElement | null>(canvas);

  let captured: OrbitControlsLike | null = null;
  attachControls.mockImplementation((c: OrbitControlsLike) => {
    captured = c;
  });

  const Host = defineComponent({
    setup() {
      useCameraControls(canvasRef, rendererRef);
      return () => h('div');
    },
  });
  const wrapper = mount(Host);

  return {
    wrapper,
    camera,
    attachControls,
    controls: () => captured!,
    setCanvas: async (next) => {
      canvasRef.value = next;
      await nextTick();
    },
    dispose: () => wrapper.unmount(),
  };
};

/** Run the RAF lerp to completion. */
const settle = async (ms = 600) => {
  await vi.advanceTimersByTimeAsync(ms);
};const polarAngleDeg = (cam: THREE.PerspectiveCamera, target: THREE.Vector3): number => {
  const offset = cam.position.clone().sub(target);
  return (Math.acos(offset.y / offset.length()) * 180) / Math.PI;
};

const azimuthDeg = (cam: THREE.PerspectiveCamera, target: THREE.Vector3): number => {
  const offset = cam.position.clone().sub(target);
  return (Math.atan2(offset.z, offset.x) * 180) / Math.PI;
};

describe('useCameraControls', () => {
  let h: Harness;

  beforeEach(() => {
    // `performance` MUST be faked here: startRaf() measures its
    // duration with performance.now(), so a real clock makes elapsed
    // ~0 forever and the lerp never reaches its endpoint.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
    // Drain module-level intents left over from a previous case.
    consumePendingFocus();
    consumePendingFit();
    delete (window as unknown as Record<string, unknown>).__camera;
    h = mountControls();
  });

  afterEach(() => {
    h.dispose();
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__camera;
  });

  describe('OrbitControls wiring', () => {
    it('creates controls and hands them to the renderer', () => {
      expect(h.attachControls).toHaveBeenCalledTimes(1);
      expect(h.attachControls.mock.calls[0]![0]).toBe(h.controls());
    });

    it('damping is on at the documented factor', () => {
      expect(h.controls().enableDamping).toBe(true);
      expect(h.controls().dampingFactor).toBe(0.08);
    });

    it('starts with the default 5..200m zoom limits', () => {
      expect(h.controls().minDistance).toBe(5);
      expect(h.controls().maxDistance).toBe(200);
    });

    it('clamps the polar angle just above the ground plane', () => {
      expect(h.controls().maxPolarAngle).toBeCloseTo(Math.PI / 2 - 0.05, 10);
    });

    it('binds left=rotate, middle=dolly, right=pan', () => {
      expect(h.controls().mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
      expect(h.controls().mouseButtons.MIDDLE).toBe(THREE.MOUSE.DOLLY);
      expect(h.controls().mouseButtons.RIGHT).toBe(THREE.MOUSE.PAN);
    });

    it('exposes window.__camera reporting the live camera state', () => {
      const probe = (window as unknown as Record<string, () => unknown>).__camera;
      expect(typeof probe).toBe('function');
      const state = probe!() as {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        distance: number; minDistance: number; maxDistance: number;
      };
      expect(state.position.y).toBeCloseTo(50, 6);
      expect(state.minDistance).toBe(5);
      expect(state.maxDistance).toBe(200);
      expect(state.distance).toBeCloseTo(
        h.camera.position.distanceTo(h.controls().target), 6,
      );
    });
  });

  describe('canvas lifecycle', () => {
    it('creates no controls while the canvas is null', async () => {
      const bare = mountControls(null);
      expect(bare.attachControls).not.toHaveBeenCalled();
      bare.dispose();
    });

    it('creates controls once the canvas arrives', async () => {
      const bare = mountControls(null);
      await bare.setCanvas(document.createElement('canvas'));
      expect(bare.attachControls).toHaveBeenCalledTimes(1);
      expect(bare.controls().minDistance).toBe(5);
      bare.dispose();
    });
  });

  describe('focus animation', () => {
    it('moves controls.target to the requested world point', async () => {
      requestCameraFocus({ x: -40, y: 0, z: 75 });
      await nextTick();
      await settle();

      const { target } = h.controls();
      expect(target.x).toBeCloseTo(-40, 6);
      expect(target.y).toBeCloseTo(0, 6);
      expect(target.z).toBeCloseTo(75, 6);
    });

    it('preserves the orbit radius so the user does not get a zoom jump', async () => {
      const before = h.camera.position.distanceTo(h.controls().target);
      requestCameraFocus({ x: 200, y: 0, z: 200 });
      await nextTick();
      await settle();

      const after = h.camera.position.distanceTo(h.controls().target);
      expect(after).toBeCloseTo(before, 4);
    });

    it('interpolates rather than snapping — partway through the lerp it is neither end', async () => {
      const startTarget = h.controls().target.clone();
      requestCameraFocus({ x: 1000, y: 0, z: 1000 });
      await nextTick();
      await vi.advanceTimersByTimeAsync(200); // half of the 400ms default

      const mid = h.controls().target.x;
      expect(mid).toBeGreaterThan(startTarget.x);
      expect(mid).toBeLessThan(1000);
    });

    it('consumes the request once — a later tick does not re-move the camera', async () => {
      requestCameraFocus({ x: 10, y: 0, z: 10 });
      await nextTick();
      await settle();
      const settled = h.controls().target.clone();

      // No new request: nothing should schedule more motion.
      await vi.advanceTimersByTimeAsync(1000);

      expect(h.controls().target).toEqual(settled);
    });

    it('a focus requested before the canvas exists stays pending and never applies', async () => {
      // Dispose the default harness so it cannot win the consume race.
      h.dispose();
      const bare = mountControls(null);

      requestCameraFocus({ x: 1, y: 0, z: 1 });
      await nextTick();
      await settle();
      expect(bare.attachControls).not.toHaveBeenCalled();

      // The intent is NOT consumed by the no-controls guard...
      expect(consumePendingFocus()).toEqual({ x: 1, y: 0, z: 1 });

      // ...and it is stranded: the focus watcher only fires on a
      // *change* of the pending ref, so mounting the canvas later does
      // not replay it. Documented here as real current behaviour.
      await bare.setCanvas(document.createElement('canvas'));
      await settle();
      expect(bare.camera.position.x).toBe(0);
      expect(bare.camera.position.z).toBe(100);
      bare.dispose();
    });
  });

  describe('fit-to-network (Plan 053)', () => {
    it('puts controls.target on the bbox centre with Y forced to 0', async () => {
      requestFitToNetwork({ bounds: bounds({ centerX: 250, centerZ: -80 }), aspect: 1.6 });
      await nextTick();
      await settle();

      const { target } = h.controls();
      expect(target.x).toBeCloseTo(250, 6);
      expect(target.y).toBeCloseTo(0, 6);
      expect(target.z).toBeCloseTo(-80, 6);
    });

    it('adopts the classic 30°-from-vertical map angle', async () => {
      requestFitToNetwork({ bounds: bounds(), aspect: 1.6 });
      await nextTick();
      await settle();

      expect(polarAngleDeg(h.camera, h.controls().target)).toBeCloseTo(30, 3);
    });

    it('places the camera on the 45° azimuth so X+ and Z+ are both visible', async () => {
      requestFitToNetwork({ bounds: bounds(), aspect: 1.6 });
      await nextTick();
      await settle();

      expect(azimuthDeg(h.camera, h.controls().target)).toBeCloseTo(45, 3);
    });

    it('lifts the zoom ceiling far above the old 200m cap for a district-sized import', async () => {
      // Regression: a 5km OSM district could not be zoomed out to see.
      const b = bounds({ diagonal: 5000, centerX: 0, centerZ: 0 });
      requestFitToNetwork({ bounds: b, aspect: 1.6 });
      await nextTick();
      await settle();

      expect(h.controls().maxDistance).toBeGreaterThan(5000);
      expect(h.controls().maxDistance).toBeGreaterThan(200);
    });

    it('scales the zoom ceiling with the network diagonal', async () => {
      requestFitToNetwork({ bounds: bounds({ diagonal: 1000 }), aspect: 1.5 });
      await nextTick();
      await settle();
      const bigMax = h.controls().maxDistance;

      requestFitToNetwork({ bounds: bounds({ diagonal: 2000 }), aspect: 1.5 });
      await nextTick();
      await settle();

      expect(h.controls().maxDistance).toBeGreaterThan(bigMax);
    });

    it('keeps the zoom-in floor at 5m for small networks (no 0.5m snap)', async () => {
      requestFitToNetwork({ bounds: bounds({ diagonal: 40 }), aspect: 1 });
      await nextTick();
      await settle();

      expect(h.controls().minDistance).toBe(5);
    });

    it('never frames a network closer than half its diagonal', async () => {
      requestFitToNetwork({ bounds: bounds({ diagonal: 8 }), aspect: 1 });
      await nextTick();
      await settle();

      expect(h.camera.position.distanceTo(h.controls().target)).toBeGreaterThanOrEqual(4);
    });

    it('a taller-than-wide viewport needs more distance than a wide one', async () => {
      requestFitToNetwork({ bounds: bounds({ diagonal: 300 }), aspect: 0.5 });
      await nextTick();
      await settle();
      const tall = h.camera.position.distanceTo(h.controls().target);

      requestFitToNetwork({ bounds: bounds({ diagonal: 300 }), aspect: 2 });
      await nextTick();
      await settle();
      const wide = h.camera.position.distanceTo(h.controls().target);

      // A square frame is the tightest fit; the short axis is the
      // bottleneck in both directions.
      expect(tall).toBeGreaterThan(wide);

      requestFitToNetwork({ bounds: bounds({ diagonal: 300 }), aspect: 1 });
      await nextTick();
      await settle();
      const square = h.camera.position.distanceTo(h.controls().target);

      expect(wide).toBeGreaterThan(square);
      expect(square).toBeGreaterThan(0);
    });

    it('consumes the fit request once', async () => {
      requestFitToNetwork({ bounds: bounds({ diagonal: 600 }), aspect: 1.5 });
      await nextTick();
      await settle();
      const first = h.controls().maxDistance;

      await vi.advanceTimersByTimeAsync(2000);

      expect(h.controls().maxDistance).toBe(first);
    });

    it('works with a real computed NetworkBounds from a demo scene', async () => {
      const { buildCrossIntersectionNetwork } = await import('@application/services/defaultScene');
      const net = buildCrossIntersectionNetwork();
      const netBounds = computeNetworkBounds(net);

      requestFitToNetwork({ bounds: netBounds, aspect: 16 / 9 });
      await nextTick();
      await settle();

      expect(h.controls().target.x).toBeCloseTo(netBounds.centerX, 6);
      expect(h.controls().target.z).toBeCloseTo(netBounds.centerZ, 6);
      expect(h.camera.position.distanceTo(h.controls().target)).toBeGreaterThan(netBounds.diagonal * 0.5);
    });
  });

  describe('teardown', () => {
    it('unmount disposes the controls', () => {
      const controls = h.controls();
      const disposeSpy = vi.spyOn(controls, 'dispose');

      h.dispose();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('unmount cancels an in-flight animation so the camera stops moving', async () => {
      const disposeSpy = vi.spyOn(h.controls(), 'dispose');
      requestCameraFocus({ x: 5000, y: 0, z: 5000 });
      await nextTick();
      await vi.advanceTimersByTimeAsync(50);

      const atUnmount = h.camera.position.x;
      h.dispose();
      await vi.advanceTimersByTimeAsync(2000);

      expect(h.camera.position.x).toBe(atUnmount);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('restores damping once the animation completes', async () => {
      requestCameraFocus({ x: 30, y: 0, z: 30 });
      await nextTick();
      await settle();

      // Without the restore, post-animation user input would stay dead.
      expect(h.controls().enableDamping).toBe(true);
    });
  });
});

import { onBeforeUnmount, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ThreeJSRenderer } from '@infrastructure/rendering';
import {
  _pendingFocusRef,
  _pendingFitRef,
  consumePendingFocus,
  consumePendingFit,
  type FocusTarget,
  type FitTarget,
} from './useCameraFocus';

export const useCameraControls = (
  canvasRef: Ref<HTMLCanvasElement | null>,
  rendererRef: Ref<ThreeJSRenderer | null>,
) => {
  let controls: OrbitControls | null = null;
  let focusRafId: number | null = null;

  /** Plan 053: dynamic zoom limits. Updated by `requestFitToNetwork`
   *  so a 5km OSM district can be both framed AND zoomed into a
   *  single intersection without scrolling past hard caps.
   *  Defaults match the M1 single-intersection case (5..200m). */
  let zoomMin = 5;
  let zoomMax = 200;

  watch(
    [canvasRef, rendererRef],
    ([canvas, renderer]) => {
      if (!canvas || !renderer) return;
      controls = new OrbitControls(renderer.getCamera(), canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = zoomMin;
      controls.maxDistance = zoomMax;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;  // keep camera above ground
      // Plan 054b: right-click pan disabled. Three.js OrbitControls
      // defaults to RIGHT=pan, which is hostile in a 3D traffic sim:
      //   1. It hijacks the browser's right-click context menu, so the user
      //      cannot right-click an entity to inspect it.
      //   2. With damping=0.08, right-drag-pan feels laggy — the damped
      //      velocity follows the mouse for ~10 frames after release.
      //   3. Map UIs (OSM / Google Maps / Mapbox) use left-drag for pan and
      //      wheel for zoom; users expect that.
      //
      // HISTORY: commit 95eaf79 introduced this (RIGHT: null) together with the
      // Playwright test `right-click drag does NOT pan` — that commit reported
      // "Frontend e2e: 28/28", i.e. the assertion was green. Commit 1c7ffb0
      // ("M2 risk remediation — signal conflict resolution + lateral drift +
      // renderer registry") silently flipped it back to MOUSE.PAN, replacing the
      // rationale comment with a contradictory "Plan 053: right-click is pan by
      // default". That commit's stated scope does not mention the camera, so the
      // flip reads as an incidental revert rather than a re-deliberation.
      // Restored 2026-10-17; see ADR-008.
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: null,
      } as unknown as typeof controls.mouseButtons;
      renderer.attachControls(controls);
      // Plan 053 follow-up: expose camera state for Playwright tests.
      // Same DEV-only pattern as window.__world — Vite tree-shakes
      // this out of production bundles.
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as unknown as {
          __camera?: () => {
            position: { x: number; y: number; z: number };
            target: { x: number; y: number; z: number };
            distance: number;
            minDistance: number;
            maxDistance: number;
          };
        };
        w.__camera = () => ({
          position: {
            x: controls!.object.position.x,
            y: controls!.object.position.y,
            z: controls!.object.position.z,
          },
          target: { x: controls!.target.x, y: controls!.target.y, z: controls!.target.z },
          distance: controls!.object.position.distanceTo(controls!.target),
          minDistance: controls!.minDistance,
          maxDistance: controls!.maxDistance,
        });
      }
    },
    { immediate: true },
  );

  // Camera focus on selection: when something (EntityOutline row click,
  // keyboard shortcut, future "follow entity" button) requests a focus,
  // animate the camera + controls.target to the requested world point.
  // The camera's offset from controls.target is preserved, so the user's
  // orbit angle / zoom stays intact — only the world-space center moves.
  watch(_pendingFocusRef, (target) => {
    if (!target || !controls) return;
    const t = consumePendingFocus();
    if (!t) return;
    animateCameraTo(controls!, t);
  });

  // Plan 053: fit-to-network. Picks a camera position+target that
  // frames the entire network bbox. Also widens OrbitControls'
  // minDistance/maxDistance so the user can zoom out to see the
  // whole district-level OSM import (the previous hard cap of 200m
  // was too tight — that's the bug the user reported).
  watch(_pendingFitRef, (target) => {
    if (!target || !controls) return;
    const t = consumePendingFit();
    if (!t) return;
    applyFit(controls!, t);
  });

  onBeforeUnmount(() => {
    if (focusRafId !== null) {
      cancelAnimationFrame(focusRafId);
      focusRafId = null;
    }
    controls?.dispose();
    controls = null;
  });

  // ---- helpers (closure-private, not exported) ----

  /** Smoothly animate camera + target to a world point. Preserves the
   *  current orbit radius / polar angle so the camera doesn't snap. */
  const animateCameraTo = (c: OrbitControls, t: FocusTarget): void => {
    const durationMs = t.durationMs ?? 400;
    const startTarget = c.target.clone();
    const endTarget = new THREE.Vector3(t.x, t.y, t.z);
    const startCam = (c.object as THREE.PerspectiveCamera).position.clone();
    // Hold the camera-to-target offset constant so we orbit in place.
    const offset = startCam.clone().sub(startTarget);
    const endCam = endTarget.clone().add(offset);
    startRaf(c, durationMs, startTarget, endTarget, startCam, endCam);
  };

  /** Compute camera + target + zoom limits from a network bbox.
   *  - target = bbox center, Y = 0
   *  - camera distance = bbox.diagonal / (2 * tan(fov/2) * margin)
   *    with margin scaling by aspect ratio (wider → can use shorter
   *    distance; taller → need further out)
   *  - minDistance = diagonal * 0.005  (can zoom into a single road)
   *  - maxDistance = diagonal * 5     (can zoom out 5× the network) */
  const applyFit = (c: OrbitControls, t: FitTarget): void => {
    const { bounds, aspect, durationMs = 600 } = t;
    const fovRad = (c.object as THREE.PerspectiveCamera).fov * Math.PI / 180;
    // Half-angle tangent — what's visible at distance 1.
    const halfTan = Math.tan(fovRad / 2);
    // For wider-than-tall aspects, horizontal FOV is the bottleneck;
    // for taller aspects, vertical FOV is. Use the smaller to guarantee
    // both axes fit (horizontal half-angle = atan(halfTan * aspect)).
    const effHalfTan = Math.min(halfTan, halfTan * aspect);
    // Margin > 1 leaves room around the edges (HUD overlays, etc.).
    const margin = 1.25;
    // Distance to fit a square of side `diagonal`: diagonal / (2 * halfTan * margin)
    // For an aspect-different rectangle, scale by max(diagonal, diagonal*aspect) / diag.
    const aspectFactor = Math.max(1, aspect, 1 / aspect);
    const distance = (bounds.diagonal * aspectFactor * margin) / (2 * effHalfTan);
    // Clamp to a sensible minimum so single-intersection networks
    // don't snap to a 0.5m distance.
    const safeDistance = Math.max(distance, bounds.diagonal * 0.5);
    // Zoom limits — wide enough to frame the whole district OR dive
    // into a single intersection. Allow ~1000× dynamic range.
    // The 0.002 minimum zoom-in is small enough to dive into any road
    // detail (a single lane is ~3.5m wide; 5m keeps the lane in view).
    zoomMin = Math.max(5, bounds.diagonal * 0.002);
    zoomMax = Math.max(zoomMin * 50, bounds.diagonal * 10);
    c.minDistance = zoomMin;
    c.maxDistance = zoomMax;

    // Top-down-ish orbit: 30° from +Y axis = 60° from horizontal. This
    // is the classic GIS / map-app angle — camera is mostly above the
    // scene with a slight tilt so you can read 3D shape (overpasses,
    // bridge ramps, building height). Pure top-down (0°) flattens
    // everything; pure horizon (90°) makes the scene look like a
    // sliver at the bottom of the canvas. 30° is the sweet spot.
    const polarAngle = Math.PI / 180 * 30;  // 30° from vertical
    const azimuth = Math.PI / 4;  // NE corner so X+ / Z+ both visible
    const target = new THREE.Vector3(bounds.centerX, 0, bounds.centerZ);
    const camOffset = new THREE.Vector3(
      Math.sin(polarAngle) * Math.cos(azimuth),
      Math.cos(polarAngle),
      Math.sin(polarAngle) * Math.sin(azimuth),
    ).multiplyScalar(safeDistance);
    const endCam = target.clone().add(camOffset);

    const startTarget = c.target.clone();
    const startCam = (c.object as THREE.PerspectiveCamera).position.clone();
    // Plan 054: shorter animation (400ms) so the camera is "in place"
    // before the user can scroll — feels more responsive. Damping
    // is temporarily disabled in startRaf() to prevent the
    // spherical-cartesian fight that produced the flicker the user
    // reported.
    startRaf(c, 400, startTarget, target, startCam, endCam);
  };

  /** Drive a `lerp` from start → end over `durationMs` with cubic ease.
   *  Cancels any in-flight animation (focus + fit share this RAF id
   *  since they're mutually exclusive user intents).
   *
   *  Plan 054: temporarily disable OrbitControls damping during the
   *  animation. Without this, the damped spherical coordinates fight
   *  with the position lerp — the user sees a "stuttering" or
   *  "flickering" effect as the two update loops try to reconcile.
   *  Damping is restored when the lerp completes (or is cancelled). */
  const startRaf = (
    c: OrbitControls,
    durationMs: number,
    startTarget: THREE.Vector3,
    endTarget: THREE.Vector3,
    startCam: THREE.Vector3,
    endCam: THREE.Vector3,
  ): void => {
    const start = performance.now();
    if (focusRafId !== null) cancelAnimationFrame(focusRafId);
    const wasDamped = c.enableDamping;
    c.enableDamping = false;  // avoid spherical-vs-cartesian fighting
    const tick = (): void => {
      const elapsed = performance.now() - start;
      const u = Math.min(1, elapsed / durationMs);
      // ease-in-out cubic
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      c.target.lerpVectors(startTarget, endTarget, e);
      (c.object as THREE.PerspectiveCamera).position.lerpVectors(startCam, endCam, e);
      if (u < 1) {
        focusRafId = requestAnimationFrame(tick);
      } else {
        focusRafId = null;
        c.enableDamping = wasDamped;  // restore for post-fit user input
      }
    };
    focusRafId = requestAnimationFrame(tick);
  };
};
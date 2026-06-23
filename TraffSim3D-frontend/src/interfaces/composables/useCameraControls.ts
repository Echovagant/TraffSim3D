import { onBeforeUnmount, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ThreeJSRenderer } from '@infrastructure/rendering';
import { _pendingFocusRef, consumePendingFocus } from './useCameraFocus';

export const useCameraControls = (
  canvasRef: Ref<HTMLCanvasElement | null>,
  rendererRef: Ref<ThreeJSRenderer | null>,
) => {
  let controls: OrbitControls | null = null;
  let focusRafId: number | null = null;

  watch(
    [canvasRef, rendererRef],
    ([canvas, renderer]) => {
      if (!canvas || !renderer) return;
      controls = new OrbitControls(renderer.getCamera(), canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 5;
      controls.maxDistance = 200;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;  // keep camera above ground
      renderer.attachControls(controls);
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
    const durationMs = t.durationMs ?? 400;
    const startTarget = controls.target.clone();
    const endTarget = new THREE.Vector3(t.x, t.y, t.z);
    const startCam = (controls.object as THREE.PerspectiveCamera).position.clone();
    const endCam = startCam.clone().add(endTarget).sub(startTarget);
    const start = performance.now();
    if (focusRafId !== null) cancelAnimationFrame(focusRafId);
    const tick = () => {
      const elapsed = performance.now() - start;
      const u = Math.min(1, elapsed / durationMs);
      // ease-in-out cubic
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      controls!.target.lerpVectors(startTarget, endTarget, e);
      (controls!.object as THREE.PerspectiveCamera).position.lerpVectors(startCam, endCam, e);
      if (u < 1) {
        focusRafId = requestAnimationFrame(tick);
      } else {
        focusRafId = null;
      }
    };
    focusRafId = requestAnimationFrame(tick);
  });

  onBeforeUnmount(() => {
    if (focusRafId !== null) {
      cancelAnimationFrame(focusRafId);
      focusRafId = null;
    }
    controls?.dispose();
    controls = null;
  });
};

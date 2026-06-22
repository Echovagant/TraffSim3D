import { onBeforeUnmount, watch, type Ref } from 'vue';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ThreeJSRenderer } from '@infrastructure/rendering';

export const useCameraControls = (
  canvasRef: Ref<HTMLCanvasElement | null>,
  rendererRef: Ref<ThreeJSRenderer | null>,
) => {
  let controls: OrbitControls | null = null;

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

  onBeforeUnmount(() => {
    controls?.dispose();
    controls = null;
  });
};

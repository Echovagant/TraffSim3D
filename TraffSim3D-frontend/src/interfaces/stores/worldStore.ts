import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import { buildDefaultNetwork } from '@application/services/defaultScene';
import { tick } from '@application/services/tick';

export const useWorldStore = defineStore('world', () => {
  // IMPORTANT: `network` is a plain object — NOT a ref. The renderer holds
  // a direct reference and reads positions each frame; if we replaced it
  // every tick, the renderer would still be pointing at the old object.
  //
  // For Vue consumers (HUD, DebugPanel, InspectorPanel) that need to react
  // to mutations, `tickCount` is a separate ref that increments every step.
  // Vue's deep tracking is not engaged — entities are mutated in place, so
  // a watcher on `network` would fire 60 times/sec and tank perf.
  let network: RoadNetwork = buildDefaultNetwork();
  const tickCount = ref(0);
  const fps = ref(0);
  const isRunning = ref(false);

  let frameCount = 0;
  let fpsAcc = 0;
  let lastFpsUpdateMs = performance.now();

  const step = (dt: number) => {
    tick(network, dt);  // mutate in place; the renderer sees the same object
    tickCount.value += 1;
    frameCount += 1;
    fpsAcc += dt;
    const now = performance.now();
    if (now - lastFpsUpdateMs >= 500) {
      fps.value = Math.round(frameCount / fpsAcc);
      frameCount = 0;
      fpsAcc = 0;
      lastFpsUpdateMs = now;
    }
  };

  const reset = () => {
    network = buildDefaultNetwork();
    tickCount.value += 1;  // signal to watchers
  };

  /** Getter for the current network identity. The renderer calls this every frame. */
  const getNetwork = (): RoadNetwork => network;

  return { network, tickCount, fps, isRunning, step, reset, getNetwork };
});

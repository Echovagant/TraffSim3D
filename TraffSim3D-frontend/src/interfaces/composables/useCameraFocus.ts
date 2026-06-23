import { ref, type Ref } from 'vue';
import type { useEditor } from './useEditor';

export interface FocusTarget {
  x: number;
  y: number;
  z: number;
  durationMs?: number;
}

/**
 * Module-level "pending focus" channel. EntityOutline / InspectorPanel /
 * future keyboard shortcuts call `requestCameraFocus`; the camera
 * controls watcher in `useCameraControls` consumes the request and
 * animates the camera to the target. Module-level (not Pinia) because
 * focus is an ephemeral, single-shot intent — there's nothing to persist
 * or persist-across-route.
 */
const pendingFocus: Ref<FocusTarget | null> = ref(null);

export const requestCameraFocus = (target: FocusTarget): void => {
  pendingFocus.value = target;
};

export const consumePendingFocus = (): FocusTarget | null => {
  const t = pendingFocus.value;
  pendingFocus.value = null;
  return t;
};

export const _pendingFocusRef = pendingFocus;

/**
 * Resolve a `(kind, id)` to a world-space position and request a camera
 * focus on it. Returns `true` if the focus was queued, `false` if the
 * entity could not be found. `world` is the `world` object returned by
 * `useEditor` (or anything that exposes a `network`).
 */
export const focusOnSelection = (
  kind: 'vehicle' | 'light',
  id: string,
  world: ReturnType<typeof useEditor>['world'],
): boolean => {
  let pos: { x: number; y: number; z: number } | null = null;
  if (kind === 'vehicle') {
    const v = world.network.vehicles[id];
    if (v) pos = v.position;
  } else {
    for (const inter of Object.values(world.network.intersections)) {
      const l = inter.trafficLights.find((tl) => tl.id === id);
      if (l) {
        pos = l.position;
        break;
      }
    }
  }
  if (!pos) return false;
  requestCameraFocus({ ...pos, durationMs: 400 });
  return true;
};

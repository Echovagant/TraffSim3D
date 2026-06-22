import type { SerializedScene } from './sceneSerializer';

const KEY = 'traffsim3d:scene:v1';

export const LocalStorageAdapter = {
  save(scene: SerializedScene): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(scene));
    } catch (err) {
      // Quota exceeded or storage disabled — surface to caller.
      throw new Error(`LocalStorage save failed: ${(err as Error).message}`);
    }
  },
  load(): SerializedScene | null {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SerializedScene;
    } catch {
      return null;
    }
  },
  clear(): void {
    localStorage.removeItem(KEY);
  },
};

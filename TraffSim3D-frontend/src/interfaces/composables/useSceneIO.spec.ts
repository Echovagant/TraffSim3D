// Unit tests for src/interfaces/composables/useSceneIO.ts
//
// useSceneIO is the thin orchestration layer over the store's
// persistence surface: save / load / clear / exportFile / importFile
// each flash a Chinese status message into `lastMessage` and that
// message auto-clears after 2s. The interesting behaviour is the
// branch selection (ok vs failure) and what each branch does to the
// selection store, so the assertions pin the exact message string.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSceneIO } from './useSceneIO';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { serializeNetwork, SCENE_SCHEMA_VERSION } from '@infrastructure/persistence';

// Mirrors the key LocalStorageAdapter writes (versioned by schema).
const SCENE_KEY = `traffsim3d:scene:v${SCENE_SCHEMA_VERSION}`;

const sceneFile = (name: string, body: unknown): File =>
  new File([JSON.stringify(body)], name, { type: 'application/json' });

describe('useSceneIO', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('save', () => {
    it('reports success and writes the scene to LocalStorage', () => {
      const io = useSceneIO();
      const world = useWorldStore();

      io.save();

      expect(io.lastMessage.value).toBe('已保存到 LocalStorage');
      expect(window.localStorage.getItem(SCENE_KEY)).not.toBeNull();
      // Sanity: the persisted payload is a versioned scene document.
      const raw = JSON.parse(window.localStorage.getItem(SCENE_KEY)!);
      expect(raw.schemaVersion).toBeDefined();
      expect(Object.keys(world.getNetwork().vehicles).length).toBeGreaterThan(0);
    });

    it('surfaces the store reason when serialization fails', () => {
      const world = useWorldStore();
      vi.spyOn(world, 'serialize').mockReturnValue({ ok: false, reason: 'quota exceeded' });
      const io = useSceneIO();

      io.save();

      expect(io.lastMessage.value).toBe('保存失败: quota exceeded');
    });
  });

  describe('load', () => {
    it('reports failure when nothing has been saved yet', () => {
      const io = useSceneIO();

      io.load();

      expect(io.lastMessage.value).toMatch(/^加载失败: /);
    });

    it('restores a saved scene and clears the stale selection', () => {
      const world = useWorldStore();
      world.switchScene('t');
      useSceneIO().save();

      // Move away from the saved scene, then reload it.
      world.switchScene('loop');
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(8);

      const selection = useSelectionStore();
      selection.select('vehicle', Object.keys(world.getNetwork().vehicles)[0]!);
      expect(selection.kind).toBe('vehicle');

      const io = useSceneIO();
      io.load();

      expect(io.lastMessage.value).toBe('已加载保存的场景');
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(4);
      expect(selection.kind).toBeNull();
      expect(selection.id).toBeNull();
    });

    it('surfaces the reason when hydration fails', () => {
      vi.spyOn(useWorldStore(), 'hydrate').mockReturnValue({ ok: false, reason: 'bad schema' });
      const io = useSceneIO();

      io.load();

      expect(io.lastMessage.value).toBe('加载失败: bad schema');
    });
  });

  describe('clear', () => {
    it('empties LocalStorage and confirms', () => {
      const io = useSceneIO();
      io.save();
      expect(window.localStorage.getItem(SCENE_KEY)).not.toBeNull();

      io.clear();

      expect(io.lastMessage.value).toBe('已清除 LocalStorage');
      expect(window.localStorage.getItem(SCENE_KEY)).toBeNull();
    });
  });

  describe('exportFile', () => {
    it('names the download with today’s ISO date and reports the filename', () => {
      const io = useSceneIO();
      const isoDate = new Date().toISOString().slice(0, 10);

      io.exportFile();

      expect(io.lastMessage.value).toBe(`已导出到 traffsim3d-${isoDate}.json`);
    });

    it('surfaces the reason when the export use case fails', () => {
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        throw new Error('createObjectURL blocked');
      });
      const io = useSceneIO();

      io.exportFile();

      expect(io.lastMessage.value).toBe('导出失败: createObjectURL blocked');
    });
  });

  describe('importFile', () => {
    it('reports the failure reason for a malformed file', async () => {
      const io = useSceneIO();

      await io.importFile(new File(['not json at all'], 'broken.json', { type: 'application/json' }));

      expect(io.lastMessage.value).toMatch(/^导入失败: /);
    });

    it('replaces the network, clears the selection and names the file on success', async () => {
      const world = useWorldStore();
      // Build a scene file from a *different* factory than the one
      // currently loaded, so a silent no-op cannot pass.
      world.switchScene('t');
      const tScene = serializeNetwork(world.getNetwork());
      world.switchScene('loop');
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(8);

      const selection = useSelectionStore();
      selection.select('vehicle', 'v-l1-0');
      expect(selection.kind).toBe('vehicle');

      const io = useSceneIO();
      await io.importFile(sceneFile('my-scene.json', tScene));

      expect(io.lastMessage.value).toBe('已从 my-scene.json 导入');
      expect(Object.keys(world.getNetwork().vehicles).length).toBe(4);
      expect(selection.kind).toBeNull();
      expect(selection.id).toBeNull();
    });

    it('an import does not silently overwrite LocalStorage', async () => {
      const world = useWorldStore();
      world.switchScene('t');
      const io = useSceneIO();
      io.save();
      const saved = window.localStorage.getItem(SCENE_KEY);

      await io.importFile(sceneFile('other.json', serializeNetwork(world.getNetwork())));

      expect(window.localStorage.getItem(SCENE_KEY)).toBe(saved);
    });
  });

  describe('lastMessage auto-clear', () => {
    it('clears the message 2000ms after it was set', () => {
      vi.useFakeTimers();
      const io = useSceneIO();

      io.clear();
      expect(io.lastMessage.value).toBe('已清除 LocalStorage');

      vi.advanceTimersByTime(1999);
      expect(io.lastMessage.value).not.toBeNull();

      vi.advanceTimersByTime(1);
      expect(io.lastMessage.value).toBeNull();
    });

    it('a newer message is not wiped by the previous message’s timer', () => {
      vi.useFakeTimers();
      const io = useSceneIO();

      io.save();
      vi.advanceTimersByTime(1500);
      io.clear();
      expect(io.lastMessage.value).toBe('已清除 LocalStorage');

      // t = 2000 — the first message's own deadline. The second must
      // survive because it only sets its own 2s window from t = 1500.
      vi.advanceTimersByTime(500);
      expect(io.lastMessage.value).toBe('已清除 LocalStorage');

      vi.advanceTimersByTime(1500);
      expect(io.lastMessage.value).toBeNull();
    });

    it('the same message text sent twice is still cleared by its own timer', () => {
      vi.useFakeTimers();
      const io = useSceneIO();

      io.clear();
      vi.advanceTimersByTime(1500);
      io.clear();

      vi.advanceTimersByTime(2000);
      expect(io.lastMessage.value).toBeNull();
    });
  });
});

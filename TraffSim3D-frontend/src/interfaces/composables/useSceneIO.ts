import { ref } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useEditor } from './useEditor';
import { exportSceneFile, importSceneFile } from '@application/use-cases';

export const useSceneIO = () => {
  const world = useWorldStore();
  const { selection } = useEditor(ref(null));
  const lastMessage = ref<string | null>(null);

  const flash = (msg: string) => {
    lastMessage.value = msg;
    setTimeout(() => {
      if (lastMessage.value === msg) lastMessage.value = null;
    }, 2000);
  };

  const save = () => {
    const r = world.serialize();
    flash(r.ok ? '已保存到 LocalStorage' : `保存失败: ${r.reason}`);
  };
  const load = () => {
    const r = world.hydrate();
    if (r.ok) {
      selection.clear();
      flash('已加载保存的场景');
    } else {
      flash(`加载失败: ${r.reason}`);
    }
  };
  const clear = () => {
    world.clearStorage();
    flash('已清除 LocalStorage');
  };
  const exportFile = () => {
    const r = exportSceneFile(world.getNetwork());
    flash(r.ok ? `已导出到 ${r.filename}` : `导出失败: ${r.reason}`);
  };
  const importFile = async (file: File) => {
    const r = await importSceneFile(file);
    if (r.ok) {
      // Reuse the store's hydrate path — it removes old Rapier bodies
      // and re-registers new ones. The current network is replaced.
      const result = world.loadNetwork(r.network);
      if (result.ok) {
        selection.clear();
        flash(`已从 ${r.filename} 导入`);
      } else {
        // `loadNetwork` currently always returns `{ ok: true }`; this
        // branch is defensive in case that ever changes.
        flash(`导入失败: unknown`);
      }
    } else {
      flash(`导入失败: ${r.reason}`);
    }
  };

  return { save, load, clear, exportFile, importFile, lastMessage };
};

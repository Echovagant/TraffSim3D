import { ref } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useEditor } from './useEditor';

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

  return { save, load, clear, lastMessage };
};

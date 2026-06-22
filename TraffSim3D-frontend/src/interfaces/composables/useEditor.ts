import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import type { ThreeJSRenderer } from '@infrastructure/rendering';

export const useEditor = (rendererRef: { value: ThreeJSRenderer | null }) => {
  const world = useWorldStore();
  const selection = useSelectionStore();

  const handleClick = (event: MouseEvent) => {
    if (!rendererRef.value) return;
    const hit = rendererRef.value.pick(event.clientX, event.clientY, world.getNetwork());
    if (hit) selection.select(hit.kind, hit.id);
    else selection.clear();
  };

  return { handleClick, world, selection };
};

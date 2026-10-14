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

  // Drag-to-move state. Module-scope closures (not a `ref`) so they
  // don't trigger Vue re-renders — only the renderer reads them,
  // and only via the event handlers.
  let dragStart: { x: number; y: number; pickedId: string } | null = null;
  let isDragging = false;
  const DRAG_THRESHOLD_PX = 4;

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;  // only left-click for picking/drag
    if (!rendererRef.value) return;
    const hit = rendererRef.value.pick(event.clientX, event.clientY, world.getNetwork());
    if (hit && hit.kind === 'vehicle') {
      selection.select(hit.kind, hit.id);
      dragStart = { x: event.clientX, y: event.clientY, pickedId: hit.id };
      isDragging = false;
      // Mark this vehicle as being dragged so tick() skips it.
      // Done up-front (before any threshold) so the very first
      // mousemove that exceeds the threshold doesn't fight the
      // per-frame Rapier re-derivation for one frame.
      world.setDraggingId(hit.id);
    } else {
      // Clicked empty space; not a drag candidate, but we still
      // record dragStart=null so the mouseup falls through to
      // handleClick's "deselect" behavior.
      dragStart = null;
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (!dragStart || !rendererRef.value) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    // 4px threshold distinguishes click from drag (don't lower it
    // — see plan 023 maintenance notes).
    if (!isDragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    isDragging = true;
    const worldPos = rendererRef.value.screenToGround(event.clientX, event.clientY);
    if (!worldPos) return;
    const result = world.moveVehicleTo(dragStart.pickedId, worldPos);
    if (!result.ok) {
      // Drag failed (vehicle not found, etc.) — reset.
      world.setDraggingId(null);
      dragStart = null;
      isDragging = false;
    }
  };

  const handleMouseUp = (event: MouseEvent) => {
    if (!dragStart) {
      // No drag candidate → let handleClick's deselect-on-empty
      // path run normally.
      handleClick(event);
      return;
    }
    const wasDragging = isDragging;
    const pickedId = dragStart.pickedId;
    dragStart = null;
    isDragging = false;
    // Always clear the dragging flag, even on click-without-drag.
    // The vehicle was selected on mousedown; clearing draggingId
    // lets tick() resume normal updates.
    world.setDraggingId(null);
    if (!wasDragging) {
      // It was a click, not a drag — handleClick's selection logic
      // already ran on mousedown (via `selection.select(hit.kind,
      // hit.id)`), so we don't need to re-run it here. The flag
      // distinction is just to suppress `selection.clear()` for
      // the "clicked empty space" case below.
      void pickedId;
    }
  };

  return {
    handleClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    world,
    selection,
  };
};

// Unit tests for src/interfaces/composables/useEditor.ts
//
// useEditor owns the mouse semantics of the 3D canvas: click = pick,
// left-press-and-move = drag a vehicle, and a 4px threshold separates
// the two. It takes no lifecycle hooks, so it can be called directly
// once an active Pinia exists — only the renderer's `pick` /
// `screenToGround` seams need faking (a real ThreeJSRenderer needs a
// WebGL context, which happy-dom does not provide).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useEditor } from './useEditor';
import { useSelectionStore } from '@interfaces/stores/selectionStore';
import { useWorldStore } from '@interfaces/stores/worldStore';
import type { ThreeJSRenderer } from '@infrastructure/rendering';

type PickResult = { kind: 'vehicle' | 'light'; id: string } | null;

/** Build a real useEditor bound to a fake renderer: the composable
 *  under test runs for real, only the ThreeJSRenderer's pick /
 *  screenToGround seams are stubbed. */
const makeEditor = (pickResult: PickResult, ground: { x: number; y: number; z: number } | null = null) => {
  const renderer = {
    pick: vi.fn().mockReturnValue(pickResult),
    screenToGround: vi.fn().mockReturnValue(ground),
  };
  // Test double: cast through unknown because the stub only implements
  // two of ThreeJSRenderer's methods (and ref() unwraps the arg type).
  const rendererRef = ref(renderer) as unknown as Ref<ThreeJSRenderer | null>;
  const editor = useEditor(rendererRef);
  return { ...editor, rendererRef, pick: renderer.pick, screenToGround: renderer.screenToGround };
};

const mouse = (type: string, init: MouseEventInit & { button?: number }) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, ...init });

describe('useEditor — click to pick', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('is a no-op when the renderer is not mounted yet', () => {
    const selection = useSelectionStore();
    const { handleClick } = useEditor(ref(null));

    handleClick(mouse('click', { clientX: 10, clientY: 10 }));

    expect(selection.kind).toBeNull();
    expect(selection.id).toBeNull();
  });

  it('selects the vehicle under the cursor', () => {
    const selection = useSelectionStore();
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const { handleClick, pick } = makeEditor({ kind: 'vehicle', id: vehicleId });

    handleClick(mouse('click', { clientX: 120, clientY: 240 }));

    expect(pick).toHaveBeenCalledTimes(1);
    // The pick must be given the live network + the pointer position.
    expect(pick.mock.calls[0]![0]).toBe(120);
    expect(pick.mock.calls[0]![1]).toBe(240);
    expect(pick.mock.calls[0]![2]).toBe(world.getNetwork());
    expect(selection.kind).toBe('vehicle');
    expect(selection.id).toBe(vehicleId);
  });

  it('selects a traffic light when the raycast hits one', () => {
    const selection = useSelectionStore();
    const { handleClick } = makeEditor({ kind: 'light', id: 'tl-9' });

    handleClick(mouse('click', { clientX: 1, clientY: 1 }));

    expect(selection.kind).toBe('light');
    expect(selection.id).toBe('tl-9');
  });

  it('clears the selection when the click hits empty space', () => {
    const selection = useSelectionStore();
    selection.select('vehicle', 'v-keep-me');
    const { handleClick } = makeEditor(null);

    handleClick(mouse('click', { clientX: 5, clientY: 5 }));

    expect(selection.kind).toBeNull();
    expect(selection.id).toBeNull();
  });
});

describe('useEditor — mousedown / drag', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('ignores non-left buttons entirely (no pick, no drag state)', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const { handleMouseDown, pick } = makeEditor({ kind: 'vehicle', id: vehicleId });

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 2 }));

    expect(pick).not.toHaveBeenCalled();
    expect(world.getDraggingId()).toBeNull();
  });

  it('left-press on a vehicle selects it and marks it as the drag subject', () => {
    const world = useWorldStore();
    const selection = useSelectionStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const { handleMouseDown } = makeEditor({ kind: 'vehicle', id: vehicleId });

    handleMouseDown(mouse('mousedown', { clientX: 40, clientY: 60, button: 0 }));

    expect(selection.kind).toBe('vehicle');
    expect(selection.id).toBe(vehicleId);
    // Marked up-front (not on first threshold crossing) so tick()
    // cannot fight the drag for one frame.
    expect(world.getDraggingId()).toBe(vehicleId);
  });

  it('left-press on empty space leaves no drag subject', () => {
    const world = useWorldStore();
    const { handleMouseDown } = makeEditor(null);

    handleMouseDown(mouse('mousedown', { clientX: 40, clientY: 60, button: 0 }));

    expect(world.getDraggingId()).toBeNull();
  });

  it('left-press on a traffic light is not a drag candidate', () => {
    const world = useWorldStore();
    const { handleMouseDown } = makeEditor({ kind: 'light', id: 'tl-3' });

    handleMouseDown(mouse('mousedown', { clientX: 40, clientY: 60, button: 0 }));

    expect(world.getDraggingId()).toBeNull();
  });

  it('a 3px move is below the threshold — the vehicle does not move', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const before = { ...world.getNetwork().vehicles[vehicleId]!.position };
    const move = vi.spyOn(world, 'moveVehicleTo');
    const { handleMouseDown, handleMouseMove } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      { x: 999, y: 0, z: 999 },
    );

    handleMouseDown(mouse('mousedown', { clientX: 100, clientY: 100, button: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 103, clientY: 100 }));

    expect(move).not.toHaveBeenCalled();
    expect(screenToWorldPos(world, vehicleId)).toEqual(before);
  });

  it('a 4px move crosses the threshold and drags the vehicle to the ground point', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const move = vi.spyOn(world, 'moveVehicleTo');
    const ground = { x: 12, y: 0, z: -34 };
    const { handleMouseDown, handleMouseMove, screenToGround } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      ground,
    );

    handleMouseDown(mouse('mousedown', { clientX: 100, clientY: 100, button: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 104, clientY: 100 }));

    expect(screenToGround).toHaveBeenCalledWith(104, 100);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(vehicleId, ground);
  });

  it('continues dragging on every move past the threshold', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const move = vi.spyOn(world, 'moveVehicleTo');
    const { handleMouseDown, handleMouseMove } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      { x: 1, y: 0, z: 1 },
    );

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 10, clientY: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 20, clientY: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 21, clientY: 0 }));

    expect(move).toHaveBeenCalledTimes(3);
  });

  it('a diagonal 3px move (hypot) is still below the threshold', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const move = vi.spyOn(world, 'moveVehicleTo');
    const { handleMouseDown, handleMouseMove } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      { x: 0, y: 0, z: 0 },
    );

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 0 }));
    // dx=2, dy=2 → hypot ≈ 2.83 < 4
    handleMouseMove(mouse('mousemove', { clientX: 2, clientY: 2 }));

    expect(move).not.toHaveBeenCalled();
  });

  it('screenToGround returning null leaves the vehicle where it was', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const before = { ...world.getNetwork().vehicles[vehicleId]!.position };
    const move = vi.spyOn(world, 'moveVehicleTo');
    const { handleMouseDown, handleMouseMove } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      null, // ray missed the ground plane (looking at the sky)
    );

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 50, clientY: 50 }));

    expect(move).not.toHaveBeenCalled();
    expect(screenToWorldPos(world, vehicleId)).toEqual(before);
  });

  it('a failed move (unknown vehicle) aborts the drag and clears the dragging flag', () => {
    const world = useWorldStore();
    const move = vi.spyOn(world, 'moveVehicleTo').mockReturnValue({ ok: false, reason: 'vehicle not found' });
    // pick returns an id that is NOT in the network → moveVehicleTo fails.
    const { handleMouseDown, handleMouseMove } = makeEditor(
      { kind: 'vehicle', id: 'ghost-vehicle' },
      { x: 3, y: 0, z: 3 },
    );

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 0 }));
    expect(world.getDraggingId()).toBe('ghost-vehicle');

    handleMouseMove(mouse('mousemove', { clientX: 40, clientY: 40 }));

    expect(move).toHaveBeenCalledTimes(1);
    expect(world.getDraggingId()).toBeNull();

    // The drag was aborted, so a further move must not retry.
    handleMouseMove(mouse('mousemove', { clientX: 80, clientY: 80 }));
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('mousemove without a preceding mousedown does nothing', () => {
    const world = useWorldStore();
    const move = vi.spyOn(world, 'moveVehicleTo');
    const { handleMouseMove, screenToGround } = makeEditor(null, { x: 0, y: 0, z: 0 });

    handleMouseMove(mouse('mousemove', { clientX: 90, clientY: 90 }));

    expect(move).not.toHaveBeenCalled();
    expect(screenToGround).not.toHaveBeenCalled();
  });
});

describe('useEditor — mouseup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('with no drag candidate falls through to click semantics (picks, then deselects on a miss)', () => {
    const selection = useSelectionStore();
    selection.select('vehicle', 'v-keep');
    const { handleMouseUp, pick } = makeEditor(null);

    handleMouseUp(mouse('mouseup', { clientX: 7, clientY: 7 }));

    expect(pick).toHaveBeenCalledTimes(1);
    expect(selection.kind).toBeNull();
  });

  it('with no drag candidate picks a newly clicked entity on mouseup', () => {
    const selection = useSelectionStore();
    const { handleMouseUp } = makeEditor({ kind: 'vehicle', id: 'v-new' });

    handleMouseUp(mouse('mouseup', { clientX: 7, clientY: 7 }));

    expect(selection.kind).toBe('vehicle');
    expect(selection.id).toBe('v-new');
  });

  it('clears the dragging flag after a completed drag', () => {
    const world = useWorldStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const { handleMouseDown, handleMouseMove, handleMouseUp } = makeEditor(
      { kind: 'vehicle', id: vehicleId },
      { x: 8, y: 0, z: 8 },
    );

    handleMouseDown(mouse('mousedown', { clientX: 0, clientY: 0, button: 0 }));
    handleMouseMove(mouse('mousemove', { clientX: 60, clientY: 60 }));
    expect(world.getDraggingId()).toBe(vehicleId);

    handleMouseUp(mouse('mouseup', { clientX: 60, clientY: 60 }));

    expect(world.getDraggingId()).toBeNull();
  });

  it('clears the dragging flag even for a click-without-drag', () => {
    const world = useWorldStore();
    const selection = useSelectionStore();
    const vehicleId = Object.keys(world.getNetwork().vehicles)[0]!;
    const { handleMouseDown, handleMouseUp, pick } = makeEditor({ kind: 'vehicle', id: vehicleId });

    handleMouseDown(mouse('mousedown', { clientX: 10, clientY: 10, button: 0 }));
    handleMouseUp(mouse('mouseup', { clientX: 10, clientY: 10 }));

    expect(world.getDraggingId()).toBeNull();
    // The click path already selected on mousedown, and mouseup must
    // NOT re-run it (which would have cleared the selection).
    expect(pick).toHaveBeenCalledTimes(1);
    expect(selection.kind).toBe('vehicle');
    expect(selection.id).toBe(vehicleId);
  });

  it('is a no-op when the renderer disappeared mid-gesture', () => {
    const world = useWorldStore();
    const selection = useSelectionStore();
    const { rendererRef, handleMouseUp, pick } = makeEditor(null);

    handleMouseUp(mouse('mouseup', { clientX: 1, clientY: 1 }));
    rendererRef.value = null;

    expect(() => handleMouseUp(mouse('mouseup', { clientX: 1, clientY: 1 }))).not.toThrow();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(selection.kind).toBeNull();
  });
});

const screenToWorldPos = (world: ReturnType<typeof useWorldStore>, id: string) => ({
  x: world.getNetwork().vehicles[id]!.position.x,
  y: world.getNetwork().vehicles[id]!.position.y,
  z: world.getNetwork().vehicles[id]!.position.z,
});

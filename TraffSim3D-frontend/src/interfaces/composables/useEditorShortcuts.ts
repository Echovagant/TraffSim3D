import { onBeforeUnmount, onMounted } from 'vue';
import { useWorldStore } from '@interfaces/stores/worldStore';
import { useSelectionStore } from '@interfaces/stores/selectionStore';

/**
 * Bind editor-wide keyboard shortcuts. Mount this once at the route
 * root (currently SceneEditorView). All handlers are intentionally
 * guarded against firing when the user is typing in an `<input>` or
 * `<select>` (e.g. the inspector) — keys in those contexts go to the
 * field first, which is the expected behavior.
 *
 * Shortcuts:
 *   Delete / Backspace  → remove currently selected entity
 *   Space               → toggle pause
 *   R                   → reset scene
 *   + / =               → tick rate up
 *   - / _               → tick rate down
 *   Escape              → clear selection
 */
export const useEditorShortcuts = (): void => {
  const world = useWorldStore();
  const selection = useSelectionStore();

  const isTypingTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Ignore auto-repeat for +/- rate cycling — we don't want one
    // long press to fly through the whole ladder. Pause toggle and
    // delete both want auto-repeat, so they're handled below.
    const noRepeat = !e.repeat;

    if (isTypingTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        world.togglePause();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (selection.kind === 'vehicle' && selection.id) {
          world.removeVehicle(selection.id);
          selection.clear();
        } else if (selection.kind === 'light' && selection.id) {
          world.removeTrafficLight(selection.id);
          selection.clear();
        }
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        world.reset();
        break;
      case '+':
      case '=':
        if (noRepeat) {
          e.preventDefault();
          world.cycleTickRate(1);
        }
        break;
      case '-':
      case '_':
        if (noRepeat) {
          e.preventDefault();
          world.cycleTickRate(-1);
        }
        break;
      case 'Escape':
        if (selection.kind) {
          e.preventDefault();
          selection.clear();
        }
        break;
      case '?':
        // Open / close the keyboard-shortcuts modal. The actual open
        // state lives in EditorToolbar.vue; we bridge via a window-level
        // custom event so this composable doesn't need a direct ref.
        // `?` requires Shift on QWERTY (Shift+/), and the layout-specific
        // character (`?` vs other) is the trade-off — the toolbar `?`
        // button is the primary discovery path.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('traffsim3d:toggle-shortcuts'));
        break;
    }
  };

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
  });
};

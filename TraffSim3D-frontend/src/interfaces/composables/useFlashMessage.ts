import { ref, type Ref } from 'vue'

export type FlashLevel = 'info' | 'warn' | 'error'

export interface FlashMessage {
  text: string
  level: FlashLevel
  /** Set when the message was shown; the auto-clear timer compares against
   * this to avoid clearing a newer message that replaced the old one. */
  ts: number
}

/**
 * Module-level flash message channel. Any code (composables, store
 * actions, components) can call `showFlashMessage(text, level)` and
 * every EditorToolbar / status display that watches `_flashMessageRef`
 * will see it. Auto-clears after `durationMs` (default 3s).
 *
 * Module-level (not Pinia) because the flash message is ephemeral,
 * single-shot, and shared across many composables.
 */
const current: Ref<FlashMessage | null> = ref(null)

let clearTimer: number | null = null

export const showFlashMessage = (
  text: string,
  level: FlashLevel = 'info',
  durationMs = 3000,
): void => {
  current.value = { text, level, ts: Date.now() }
  if (clearTimer !== null) window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => {
    // Only clear if this is still the most recent message.
    if (current.value && Date.now() - current.value.ts >= durationMs - 50) {
      current.value = null
    }
    clearTimer = null
  }, durationMs)
}

export const _flashMessageRef = current

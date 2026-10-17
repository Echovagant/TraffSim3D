// Unit tests for src/interfaces/composables/useFlashMessage.ts
//
// The composable is a module-level ephemeral channel (not Pinia): one
// `Ref<FlashMessage | null>` shared by every caller, plus a single
// module-scope auto-clear timer. Each test re-imports the module so
// that neither the ref nor the pending timer leaks across cases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type FlashModule = typeof import('./useFlashMessage');

const loadModule = async (): Promise<FlashModule> => {
  vi.resetModules();
  return import('./useFlashMessage');
};

describe('useFlashMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no message published', async () => {
    const m = await loadModule();
    expect(m._flashMessageRef.value).toBeNull();
  });

  it('publishes text + level + ts to _flashMessageRef', async () => {
    const m = await loadModule();
    vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));

    m.showFlashMessage('已保存', 'warn');

    expect(m._flashMessageRef.value).not.toBeNull();
    expect(m._flashMessageRef.value?.text).toBe('已保存');
    expect(m._flashMessageRef.value?.level).toBe('warn');
    expect(m._flashMessageRef.value?.ts).toBe(Date.parse('2026-10-17T00:00:00Z'));
  });

  it('defaults the level to "info" when omitted', async () => {
    const m = await loadModule();
    m.showFlashMessage('tick rate 1x');
    expect(m._flashMessageRef.value?.level).toBe('info');
  });

  it('carries an explicit "error" level through to the ref', async () => {
    const m = await loadModule();
    m.showFlashMessage('boom', 'error');
    expect(m._flashMessageRef.value?.level).toBe('error');
  });

  it('auto-clears after the default 3000ms', async () => {
    const m = await loadModule();
    m.showFlashMessage('gone in 3s');

    vi.advanceTimersByTime(2999);
    expect(m._flashMessageRef.value).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(m._flashMessageRef.value).toBeNull();
  });

  it('honours a custom durationMs', async () => {
    const m = await loadModule();
    m.showFlashMessage('quick', 'info', 500);

    vi.advanceTimersByTime(499);
    expect(m._flashMessageRef.value?.text).toBe('quick');

    vi.advanceTimersByTime(1);
    expect(m._flashMessageRef.value).toBeNull();
  });

  it('a newer message replaces the old one and resets the auto-clear window', async () => {
    const m = await loadModule();
    m.showFlashMessage('first', 'info', 1000);

    // Land inside the first message's window, then supersede it.
    vi.advanceTimersByTime(600);
    m.showFlashMessage('second', 'info', 1000);
    expect(m._flashMessageRef.value?.text).toBe('second');

    // t = 1000 — the *first* message's original deadline. The second
    // message must still be live because its own timer was restarted.
    vi.advanceTimersByTime(400);
    expect(m._flashMessageRef.value?.text).toBe('second');

    // t = 1600 — the second message's own deadline.
    vi.advanceTimersByTime(600);
    expect(m._flashMessageRef.value).toBeNull();
  });

  it('clears on a 0ms duration — the timer fires immediately and the tolerance only forgives 50ms', async () => {
    const m = await loadModule();
    m.showFlashMessage('fresh', 'info', 0);

    vi.advanceTimersByTime(0);

    // elapsed (0) >= durationMs - 50 (-50) → cleared.
    expect(m._flashMessageRef.value).toBeNull();
  });

  it('is a shared channel — a second show is visible to every reader', async () => {
    const m = await loadModule();
    m.showFlashMessage('from store', 'info');
    // Re-importing would reset the module, so read the same ref twice
    // to model two independent UI readers (EditorToolbar + status bar).
    const readerA = m._flashMessageRef;
    const readerB = m._flashMessageRef;
    expect(readerA).toBe(readerB);
    expect(readerB.value?.text).toBe('from store');
  });
});

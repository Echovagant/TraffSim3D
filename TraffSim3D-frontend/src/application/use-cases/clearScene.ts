import { LocalStorageAdapter } from '@infrastructure/persistence';

export const clearScene = (): { ok: true } => {
  LocalStorageAdapter.clear();
  return { ok: true };
};

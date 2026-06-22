import { LocalStorageAdapter, hydrateNetwork } from '@infrastructure/persistence';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';

export const loadScene = (): { ok: true; network: RoadNetwork } | { ok: false; reason: string } => {
  const raw = LocalStorageAdapter.load();
  if (!raw) return { ok: false, reason: 'no saved scene' };
  const result = hydrateNetwork(raw);
  if (!result.ok || !result.network) return { ok: false, reason: result.reason ?? 'hydration failed' };
  return { ok: true, network: result.network };
};

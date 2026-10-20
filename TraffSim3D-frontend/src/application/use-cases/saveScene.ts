import { LocalStorageAdapter, serializeNetwork } from '@infrastructure/persistence'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

export const saveScene = (network: RoadNetwork): { ok: true } | { ok: false; reason: string } => {
  try {
    LocalStorageAdapter.save(serializeNetwork(network))
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

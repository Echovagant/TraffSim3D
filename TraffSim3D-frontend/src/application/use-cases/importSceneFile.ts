import { hydrateNetwork } from '@infrastructure/persistence'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

/**
 * Result type for the file-import use case. Mirrors the LocalStorage
 * `loadScene` shape so the caller can handle both paths uniformly.
 */
export type ImportResult =
  | { ok: true; network: RoadNetwork; filename: string }
  | { ok: false; reason: string }

/**
 * Read a `File` (from a `<input type="file">` change event) and
 * validate it as a `SerializedScene` via the existing `hydrateNetwork`
 * path. This intentionally REUSES 014's hardened validation — same
 * JSON format, same checks.
 *
 * The File is read as text (FileReader.readAsText); the resulting
 * string is fed to `hydrateNetwork` which runs `migrateScene`
 * internally and returns `{ ok, network }` or `{ ok: false, reason }`.
 */
export const importSceneFile = (file: File): Promise<ImportResult> => {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => {
      resolve({ ok: false, reason: `FileReader error: ${reader.error?.message ?? 'unknown'}` })
    }
    reader.onload = () => {
      const text = reader.result
      if (typeof text !== 'string') {
        resolve({ ok: false, reason: 'file is not text' })
        return
      }
      const result = hydrateNetwork(text)
      if (!result.ok || !result.network) {
        resolve({ ok: false, reason: result.reason ?? 'invalid scene file' })
        return
      }
      resolve({ ok: true, network: result.network, filename: file.name })
    }
    reader.readAsText(file)
  })
}

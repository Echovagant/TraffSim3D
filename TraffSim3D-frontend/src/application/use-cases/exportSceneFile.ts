import { serializeNetwork } from '@infrastructure/persistence'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

/**
 * Result type for the file-export use case. Always succeeds unless
 * the browser refuses Blob/URL.createObjectURL (very old browser).
 */
export type ExportResult = { ok: true; filename: string } | { ok: false; reason: string }

/**
 * Serialize `network` to a `.traffsim3d.json` file and trigger a
 * browser download. The on-disk format is the same as the LocalStorage
 * format (same `serializeNetwork` output) — a file exported from this
 * code can be re-imported verbatim, AND can be pasted into LocalStorage
 * if the user wants (same JSON structure, same schemaVersion).
 *
 * The filename is `traffsim3d-{ISO date}.json` so multiple exports
 * don't collide in the user's Downloads folder.
 */
export const exportSceneFile = (network: RoadNetwork): ExportResult => {
  try {
    const serialized = serializeNetwork(network)
    const json = JSON.stringify(serialized, null, 2) // pretty-print for human inspection
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const iso = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const filename = `traffsim3d-${iso}.json`

    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoke after a tick — revoking synchronously breaks some browsers' download tracking.
    setTimeout(() => URL.revokeObjectURL(url), 1000)

    return { ok: true, filename }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

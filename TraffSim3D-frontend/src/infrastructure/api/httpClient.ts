/**
 * Minimal typed HTTP client for the FastAPI backend.
 *
 * Why not axios/fetch wrapper library: the project targets backend-driven features
 * (scene sync, tick streaming, replay) and we want full control over timeouts,
 * error shapes, and (later) SSE/WebSocket support without dragging in a
 * generic HTTP lib. The surface is intentionally tiny — add methods, do
 * not grow this file.
 *
 * The client is pure infrastructure: it has no Vue/Pinia dependency. Callers
 * (composables, components) compose it with their own state.
 */

export class BackendError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'BackendError'
    this.status = status
    this.body = body
  }
}

export interface HttpClient {
  /** Issue a GET against `path` (relative to the configured base URL) and return the parsed JSON. */
  get<T>(path: string): Promise<T>
}

export interface HttpClientOptions {
  /** Default request timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number
}

/**
 * Build an HTTP client that prepends `baseUrl` to every path. `baseUrl`
 * defaults to `/api/v1` so the dev proxy can forward to FastAPI without
 * callers having to know the prefix.
 */
export const createHttpClient = (
  baseUrl = '/api/v1',
  options: HttpClientOptions = {},
): HttpClient => {
  const timeoutMs = options.timeoutMs ?? 3000
  const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl

  const request = async <T>(method: string, path: string): Promise<T> => {
    const url = `${prefix}${path.startsWith('/') ? path : `/${path}`}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await res.text()
      const body: unknown = text.length > 0 ? safeJsonParse(text) : null
      if (!res.ok) {
        throw new BackendError(
          `${method} ${url} → ${res.status} ${res.statusText}`,
          res.status,
          body,
        )
      }
      return body as T
    } catch (err) {
      if (err instanceof BackendError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new BackendError(`${method} ${url} timed out after ${timeoutMs}ms`, 0, null)
      }
      // Network error (server down, CORS, offline).
      const msg = err instanceof Error ? err.message : String(err)
      throw new BackendError(`${method} ${url} failed: ${msg}`, 0, null)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
  }
}

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

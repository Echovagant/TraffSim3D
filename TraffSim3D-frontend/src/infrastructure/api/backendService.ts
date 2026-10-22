/**
 * Typed surface over the FastAPI backend.
 *
 * Today this is just the two smoke endpoints (`/health`, `/api/v1/ping`).
 * As more capabilities land (scene sync, tick streaming, RL training) new methods
 * will be appended here — the return types are designed to mirror the
 * Pydantic models the backend will eventually expose, so the call sites
 * in the application/services layer stay stable.
 *
 * Keep this file free of Vue/Pinia imports — it's plain infrastructure.
 */
import type { HttpClient } from './httpClient'

export interface PingResponse {
  pong: true
}

export interface HealthResponse {
  status: 'ok'
}

export interface BackendService {
  /** Liveness probe. Returns `{ status: 'ok' }` if the API is up. */
  health(): Promise<HealthResponse>
  /** Smoke endpoint. Returns `{ pong: true }`. */
  ping(): Promise<PingResponse>
}

/**
 * `health` lives at the root (`GET /health`) — it's a meta liveness probe,
 * not a versioned API resource, so it bypasses the `/api/v1` prefix and
 * goes through a dedicated client. `ping` is a real versioned smoke
 * endpoint, so it shares the prefixed client.
 */
export const createBackendService = (
  apiHttp: HttpClient,
  metaHttp: HttpClient,
): BackendService => ({
  health: () => metaHttp.get<HealthResponse>('/health'),
  ping: () => apiHttp.get<PingResponse>('/ping'),
})

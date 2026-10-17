/**
 * Public surface of the API infrastructure layer.
 *
 * Components and composables should import from `@infrastructure/api`
 * (this barrel) rather than from the individual files. The default
 * instances are wired to the Vite dev proxy (`/api/v1` → `localhost:8000`);
 * tests or alternative envs can call `createHttpClient` / `createBackendService`
 * directly with their own base URL.
 */
export { createHttpClient, BackendError } from './httpClient';
export type { HttpClient, HttpClientOptions } from './httpClient';
export { createBackendService } from './backendService';
export type { BackendService, HealthResponse, PingResponse } from './backendService';
export { createRLWeightsClient } from './rlWeightsClient';
export type { CheckpointWeightsResponse, RLWeightsClient } from './rlWeightsClient';
export {
  OSM_DEFAULT_CLIP_DEG,
  OSM_UNSPECIFIED_CLIP_NOTE,
  describeOsmClip,
  formatOsmBBoxQuery,
  validateOsmBBox,
  withOsmBBoxQuery,
} from './osmImportClient';
export type { OsmBBox } from './osmImportClient';

import { createHttpClient } from './httpClient';
import { createBackendService } from './backendService';
import { createRLWeightsClient } from './rlWeightsClient';

// Versioned API surface (proxied to FastAPI at /api/v1/*).
export const defaultHttp = createHttpClient();
// Meta endpoints (proxied to FastAPI at /* — currently just /health).
// No prefix so `health()` resolves to `/health`, not `/api/v1/health`.
export const metaHttp = createHttpClient('');
export const defaultBackend = createBackendService(defaultHttp, metaHttp);
// Plan 049: default RL weights client — same /api/v1 prefix as the rest.
export const defaultRLWeights = createRLWeightsClient(defaultHttp);

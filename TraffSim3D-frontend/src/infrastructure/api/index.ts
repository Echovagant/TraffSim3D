/**
 * Public surface of the API infrastructure layer.
 *
 * Components and composables should import from `@infrastructure/api`
 * (this barrel) rather than from the individual files. The default
 * instances are wired to the Vite dev proxy (`/api/v1` → `localhost:8000`);
 * tests or alternative envs can call `createHttpClient` / `createBackendService`
 * directly with their own base URL.
 */
export { createHttpClient, BackendError } from './httpClient'
export type { HttpClient, HttpClientOptions, RequestOptions } from './httpClient'
export { createBackendService } from './backendService'
export type { BackendService, HealthResponse, PingResponse } from './backendService'
export {
  createRLWeightsClient,
  RL_WEIGHTS_TIMEOUT_MS,
  GRID_POLICY_TIMEOUT_MS,
} from './rlWeightsClient'
export type {
  CheckpointWeightsResponse,
  GridPolicyResponse,
  GridPolicyTrainingInfo,
  RLWeightsClient,
} from './rlWeightsClient'
export {
  VALIDATE_NETWORK_PATH,
  VALIDATE_NETWORK_TIMEOUT_MS,
  createRLTrainingClient,
} from './rlTrainingClient'
export type { NetworkPayload, RLTrainingClient, ValidateResult } from './rlTrainingClient'
export {
  ROUTE_API_PREFIX,
  ROUTE_PLAN_PATH,
  ROUTE_PLAN_TIMEOUT_MS,
  createRouteClient,
} from './routeClient'
export type {
  RouteClient,
  RouteEndpoint,
  RouteLeg,
  RouteNetworkPayload,
  RoutePlanResponse,
} from './routeClient'
export { parseRLStatus, RLStatusContractError } from './rlStatus'
export type { RLStatusCore } from './rlStatus'
// Types generated from the backend's committed OpenAPI schema
// (`docs/openapi.json`). Regenerate with `npm run api:types`.
export type {
  OpenApiPaths,
  ResponseOf,
  PathsApiV1PingGetResponse,
  PathsApiV1RlStatusGetResponse,
  PathsApiV1RlCapabilitiesGetResponse,
  PathsHealthGetResponse,
  TrainRequest,
} from './generated/openapi'
export {
  OSM_DEFAULT_CLIP_DEG,
  OSM_UNSPECIFIED_CLIP_NOTE,
  describeOsmClip,
  formatOsmBBoxQuery,
  validateOsmBBox,
  withOsmBBoxQuery,
} from './osmImportClient'
export type { OsmBBox } from './osmImportClient'

export {
  MAX_IMPORT_VEHICLES,
  MIN_IMPORT_VEHICLES,
  OSM_METERS_PER_DEGREE_LAT,
  OSM_PAYLOAD_NORTH_IS_POSITIVE_Z,
  ROADS_PER_IMPORT_VEHICLE,
  deriveSpawnPoints,
  importVehicleCountFor,
  normalizeOsmPayload,
  readOsmOrigin,
  spawnImportedVehicles,
} from './osmNetworkAdapter'
export type {
  DeriveSpawnPointsOptions,
  NormalizedOsmNetwork,
  OsmNetworkPayload,
  OsmPayloadStats,
  SpawnImportedVehiclesOptions,
} from './osmNetworkAdapter'

import { createHttpClient } from './httpClient'
import { createBackendService } from './backendService'
import { createRLWeightsClient } from './rlWeightsClient'
import { createRLTrainingClient } from './rlTrainingClient'

// Versioned API surface (proxied to FastAPI at /api/v1/*).
export const defaultHttp = createHttpClient()
// Meta endpoints (proxied to FastAPI at /* — currently just /health).
// No prefix so `health()` resolves to `/health`, not `/api/v1/health`.
export const metaHttp = createHttpClient('')
export const defaultBackend = createBackendService(defaultHttp, metaHttp)
// Default RL weights client — same /api/v1 prefix as the rest.
export const defaultRLWeights = createRLWeightsClient(defaultHttp)
// Default RL training bridge client (POSTs the scene network to the backend).
export const defaultRLTraining = createRLTrainingClient()

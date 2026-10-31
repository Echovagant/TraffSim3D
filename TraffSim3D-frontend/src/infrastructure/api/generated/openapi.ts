// ============================================================
// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:      docs/openapi.json (the backend's committed schema)
// Generator:  scripts/generate-openapi-types.ts
// Regenerate: npm run api:types
// Verify:     npm run api:types:check
//
// Endpoints the backend declares as `dict[str, Any]` have no
// properties in the schema, so their generated response type is
// `Record<string, unknown>`. Those endpoints carry a hand-written,
// runtime-validated contract instead — see
// `src/infrastructure/api/rlStatus.ts`.
// ============================================================

/** `Body_parse_osm_api_v1_maps_parse_osm_post` — from the OpenAPI `components.schemas`. */
export interface Body_parse_osm_api_v1_maps_parse_osm_post {
  file: string
}

/** `Body_parse_pbf_api_v1_maps_parse_pbf_post` — from the OpenAPI `components.schemas`. */
export interface Body_parse_pbf_api_v1_maps_parse_pbf_post {
  file: string
}

/** `HTTPValidationError` — from the OpenAPI `components.schemas`. */
export interface HTTPValidationError {
  detail?: Array<ValidationError>
}

/** `RouteEndpoint` — from the OpenAPI `components.schemas`. */
export interface RouteEndpoint {
  junction_id?: string | null
  road_id?: string | null
  direction?: "forward" | "backward"
}

/** `RouteRequest` — from the OpenAPI `components.schemas`. */
export interface RouteRequest {
  network?: Record<string, unknown>
  start: RouteEndpoint
  end: RouteEndpoint
}

/** `SignalTrainRequest` — from the OpenAPI `components.schemas`. */
export interface SignalTrainRequest {
  steps?: number
  device?: string
  seeds?: Array<number>
  save_every?: number
}

/** `TrainRequest` — from the OpenAPI `components.schemas`. */
export interface TrainRequest {
  steps?: number
  dry_run?: boolean
  device?: string
  n_agents?: number
  save_every?: number
  independent_agents?: boolean
  scene_kind?: string
  curriculum?: boolean
}

/** `ValidateNetworkRequest` — from the OpenAPI `components.schemas`. */
export interface ValidateNetworkRequest {
  network?: Record<string, unknown>
}

/** `ValidationError` — from the OpenAPI `components.schemas`. */
export interface ValidationError {
  loc: Array<string | number>
  msg: string
  type: string
  input?: unknown
  ctx?: Record<string, unknown>
}

/** `GET /api/v1/ping` → 200 */
export type PathsApiV1PingGetResponse = Record<string, boolean>

/** `POST /api/v1/maps/parse-osm` → 200 */
export type PathsApiV1MapsParseOsmPostResponse = Record<string, unknown>

/** `POST /api/v1/maps/parse-pbf` → 200 */
export type PathsApiV1MapsParsePbfPostResponse = Record<string, unknown>

/** `GET /api/v1/maps/overpass` → 200 */
export type PathsApiV1MapsOverpassGetResponse = Record<string, unknown>

/** `GET /api/v1/maps/overpass/cache` → 200 */
export type PathsApiV1MapsOverpassCacheGetResponse = Record<string, unknown>

/** `POST /api/v1/rl/train` → 200 */
export type PathsApiV1RlTrainPostResponse = Record<string, unknown>

/** `GET /api/v1/rl/status` → 200 */
export type PathsApiV1RlStatusGetResponse = Record<string, unknown>

/** `POST /api/v1/rl/signal/train` → 200 */
export type PathsApiV1RlSignalTrainPostResponse = Record<string, unknown>

/** `GET /api/v1/rl/capabilities` → 200 */
export type PathsApiV1RlCapabilitiesGetResponse = Record<string, unknown>

/** `GET /api/v1/rl/signal/grid-policy` → 200 */
export type PathsApiV1RlSignalGridPolicyGetResponse = Record<string, unknown>

/** `POST /api/v1/rl/train/pause` → 200 */
export type PathsApiV1RlTrainPausePostResponse = Record<string, unknown>

/** `POST /api/v1/rl/train/resume` → 200 */
export type PathsApiV1RlTrainResumePostResponse = Record<string, unknown>

/** `POST /api/v1/rl/train/terminate` → 200 */
export type PathsApiV1RlTrainTerminatePostResponse = Record<string, unknown>

/** `GET /api/v1/rl/checkpoints` → 200 */
export type PathsApiV1RlCheckpointsGetResponse = Record<string, unknown>

/** `DELETE /api/v1/rl/checkpoints` → 200 */
export type PathsApiV1RlCheckpointsDeleteResponse = Record<string, unknown>

/** `GET /api/v1/rl/scenes` → 200 */
export type PathsApiV1RlScenesGetResponse = Record<string, unknown>

/** `POST /api/v1/rl/validate-network` → 200 */
export type PathsApiV1RlValidateNetworkPostResponse = Record<string, unknown>

/** `GET /api/v1/rl/training-config` → 200 */
export type PathsApiV1RlTrainingConfigGetResponse = Record<string, unknown>

/** `GET /api/v1/rl/checkpoints/{name}/weights` → 200 */
export type PathsApiV1RlCheckpointsNameWeightsGetResponse = Record<string, unknown>

/** `POST /api/v1/routes/plan` → 200 */
export type PathsApiV1RoutesPlanPostResponse = Record<string, unknown>

/** `GET /health` → 200 */
export type PathsHealthGetResponse = Record<string, string>

/**
 * Every operation the backend exposes, keyed by path and method.
 *
 * Usage: `type S = OpenApiPaths['/api/v1/rl/status']['get']`
 */
export interface OpenApiPaths {
  "/api/v1/ping": { get: PathsApiV1PingGetResponse }
  "/api/v1/maps/parse-osm": { post: PathsApiV1MapsParseOsmPostResponse }
  "/api/v1/maps/parse-pbf": { post: PathsApiV1MapsParsePbfPostResponse }
  "/api/v1/maps/overpass": { get: PathsApiV1MapsOverpassGetResponse }
  "/api/v1/maps/overpass/cache": { get: PathsApiV1MapsOverpassCacheGetResponse }
  "/api/v1/rl/train": { post: PathsApiV1RlTrainPostResponse }
  "/api/v1/rl/status": { get: PathsApiV1RlStatusGetResponse }
  "/api/v1/rl/signal/train": { post: PathsApiV1RlSignalTrainPostResponse }
  "/api/v1/rl/capabilities": { get: PathsApiV1RlCapabilitiesGetResponse }
  "/api/v1/rl/signal/grid-policy": { get: PathsApiV1RlSignalGridPolicyGetResponse }
  "/api/v1/rl/train/pause": { post: PathsApiV1RlTrainPausePostResponse }
  "/api/v1/rl/train/resume": { post: PathsApiV1RlTrainResumePostResponse }
  "/api/v1/rl/train/terminate": { post: PathsApiV1RlTrainTerminatePostResponse }
  "/api/v1/rl/checkpoints": { get: PathsApiV1RlCheckpointsGetResponse; delete: PathsApiV1RlCheckpointsDeleteResponse }
  "/api/v1/rl/scenes": { get: PathsApiV1RlScenesGetResponse }
  "/api/v1/rl/validate-network": { post: PathsApiV1RlValidateNetworkPostResponse }
  "/api/v1/rl/training-config": { get: PathsApiV1RlTrainingConfigGetResponse }
  "/api/v1/rl/checkpoints/{name}/weights": { get: PathsApiV1RlCheckpointsNameWeightsGetResponse }
  "/api/v1/routes/plan": { post: PathsApiV1RoutesPlanPostResponse }
  "/health": { get: PathsHealthGetResponse }
}

/** The response body type of one operation. */
export type ResponseOf<P extends keyof OpenApiPaths, M extends keyof OpenApiPaths[P]> =
  OpenApiPaths[P][M]

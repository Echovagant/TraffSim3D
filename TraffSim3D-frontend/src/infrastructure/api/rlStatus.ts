// src/infrastructure/api/rlStatus.ts
//
// The `/api/v1/rl/status` contract.
//
// WHY THIS FILE EXISTS
// --------------------
// The frontend used to read the endpoint like this:
//
//     const j = (await r.json()) as Status
//
// `as Status` is a promise the compiler cannot check. When the backend
// renames a field, the cast keeps compiling, no test fails, and the
// browser shows a *plausible but wrong* number — the worst possible
// failure mode for a status panel.
//
// The backend declares the endpoint as `-> dict[str, Any]`
// (`app/api/v1/rl.py::status`), so FastAPI's OpenAPI schema has
// `additionalProperties: true` and **no properties**: the schema
// generator (`scripts/generate-openapi-types.ts`) cannot derive field
// types from it and honestly emits `Record<string, unknown>`.
//
// Until the backend declares a Pydantic response model, this file is
// the hand-written contract for that endpoint, and `parseRLStatus()`
// enforces it **at runtime**: a renamed or retyped field raises a
// `RLStatusContractError` instead of quietly producing a wrong number.
//
// (Reported to the backend owner: giving `/rl/status` a Pydantic
// response model would let the generator produce these types and make
// this file unnecessary.)

/**
 * The fields `/api/v1/rl/status` is guaranteed to return.
 *
 * These are the ones the UI reads unconditionally. Everything else the
 * backend may add is passed through untouched (forward compatible).
 */
export interface RLStatusCore {
  /** A training run is live. */
  running: boolean
  /** The live run is paused (the pause / resume control channel). */
  paused?: boolean
  /** The training step the run has reached. */
  step: number
  /** The step budget the run was started with. */
  total_steps?: number
  /** Episodes finished so far. */
  episode_count: number
  /** The most recent episode reward. */
  last_reward: number
  /** One reward per finished episode. */
  reward_history: number[]
  /** Wall-clock start of the run (epoch ms). */
  started_at_ms: number
  /** Wall-clock end of the run (epoch ms), null while it runs. */
  finished_at_ms: number | null
  /** The backend's own verdict on the run (`dry_run*` = no PPO ran). */
  reason?: string
  /** The device the run used (`gpu` / `cpu` / `dry_run`). */
  device?: string
  /** Why the backend picked that device. */
  device_reason?: string
  /** The number of agents in the run. */
  n_agents?: number
  /** Whether the agents learn independently. */
  independent_agents?: boolean
  /** The scene the run uses. */
  scene_kind?: string
  /** The newest checkpoint the run wrote. */
  latest_checkpoint?: string
  /** `signal` when the signal-light agent wrote this status. */
  policy_kind?: string
  /** Per-agent reward history (only when `independent_agents`). */
  agent_rewards?: Record<string, number[]>
}

/** Raised when the payload does not match the contract above. */
export class RLStatusContractError extends Error {
  /** The offending fields, with a human-readable reason each. */
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`/api/v1/rl/status payload does not match the contract: ${problems.join('; ')}`)
    this.name = 'RLStatusContractError'
    this.problems = problems
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === 'number')

/** `required` → the field must be there and of the given type. */
const checkRequired = (
  raw: Record<string, unknown>,
  key: keyof RLStatusCore & string,
  expected: 'boolean' | 'number' | 'number[]' | 'number|null',
  problems: string[],
): void => {
  const value = raw[key]
  if (value === undefined || value === null) {
    problems.push(`${key} is missing`)
    return
  }
  const ok =
    expected === 'boolean'
      ? typeof value === 'boolean'
      : expected === 'number'
        ? typeof value === 'number'
        : expected === 'number[]'
          ? isNumberArray(value)
          : typeof value === 'number'
  if (!ok) {
    problems.push(
      `${key} should be ${expected}, got ${Array.isArray(value) ? 'array' : typeof value}`,
    )
  }
}

/** `optional` → the field may be absent, but must be typed if present. */
const checkOptional = (
  raw: Record<string, unknown>,
  key: string,
  expected: 'boolean' | 'number' | 'string',
  problems: string[],
): void => {
  const value = raw[key]
  if (value === undefined || value === null) return
  if (typeof value !== expected) {
    problems.push(`${key} should be ${expected}, got ${typeof value}`)
  }
}

/**
 * Validate a `/api/v1/rl/status` payload and return it as the
 * contract type.
 *
 * `T` lets the caller add its own view-specific fields (the signal
 * agent's evaluation series, …) without this module having to know
 * about them. The generic parameter is still checked by the compiler:
 * it has to satisfy `RLStatusCore`, so a renamed core field is a
 * compile error, and the runtime check turns a changed *backend* into
 * a loud error instead of a wrong number.
 *
 * @throws {RLStatusContractError} when the payload does not match.
 */
export const parseRLStatus = <T extends RLStatusCore = RLStatusCore>(raw: unknown): T => {
  if (!isRecord(raw)) {
    throw new RLStatusContractError(['the payload is not a JSON object'])
  }
  const problems: string[] = []

  checkRequired(raw, 'running', 'boolean', problems)
  checkRequired(raw, 'step', 'number', problems)
  checkRequired(raw, 'episode_count', 'number', problems)
  checkRequired(raw, 'last_reward', 'number', problems)
  checkRequired(raw, 'reward_history', 'number[]', problems)
  checkRequired(raw, 'started_at_ms', 'number', problems)
  // `finished_at_ms` is null while the run is live.
  if (raw.finished_at_ms !== null && typeof raw.finished_at_ms !== 'number') {
    problems.push(`finished_at_ms should be number|null, got ${typeof raw.finished_at_ms}`)
  }

  checkOptional(raw, 'paused', 'boolean', problems)
  checkOptional(raw, 'total_steps', 'number', problems)
  checkOptional(raw, 'reason', 'string', problems)
  checkOptional(raw, 'device', 'string', problems)
  checkOptional(raw, 'device_reason', 'string', problems)
  checkOptional(raw, 'n_agents', 'number', problems)
  checkOptional(raw, 'independent_agents', 'boolean', problems)
  checkOptional(raw, 'scene_kind', 'string', problems)
  checkOptional(raw, 'latest_checkpoint', 'string', problems)
  checkOptional(raw, 'policy_kind', 'string', problems)

  if (problems.length > 0) throw new RLStatusContractError(problems)

  return raw as unknown as T
}

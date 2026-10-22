// scripts/generate-contract-snapshots.ts
//
// Generate the TS-side golden snapshots for the cross-language
// contract.
//
// Two goldens per vector:
//   - ts_<name>.json       — scenario level: the contract mirror's
//     trajectory (reason / final_step / final_z / samples)
//   - ts_kernel_<name>.json — kernel level: the **product replay path**'s
//     speed series, produced by driving `tick()` with an injected fixed
//     action (no checkpoint needed)
//
// Run:  npm run contract:gen     (write)
//       npm run contract:check   (verify the goldens are up to date)
//
// The goldens are committed: the backend's test suite must be able to run
// the full contract on its own, without the frontend toolchain.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertValidSignalActions,
  runEpisode,
  sceneLight,
  type MirrorEgoStart,
  type MirrorLightOverride,
  type MirrorSignalAction,
  type SceneKind,
} from '../src/application/services/simCoreMirror'
import { tick } from '../src/application/services/tick'
import { buildTestNetwork } from '../src/__fixtures__/testNetwork'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  MIN_GREEN_SECS,
  MIN_INTER_GREEN_SECS,
  PHASE_ADJUST_SECS,
  PYTHON_SIM,
  SIGNAL_ACTION_NAMES,
  type SignalActionName,
} from '../src/shared/constants/simulation'
import type { TickContext } from '../src/application/services/tick'

/**
 * One external signal action, as it appears in `test_vector.json`.
 *
 * THE STEP CONVENTION (identical on the Python side): an action labelled
 * `"step": N` is applied **before** the N-th simulation step — it is
 * *consumed by* that step. Python: `light.apply_action(name)` immediately
 * before `core.step(...)`; here: `applySignalAction(name)` immediately
 * before `mirror.step(...)`.
 */
interface VectorSignalAction {
  step: number
  action: SignalActionName
}

interface Vector {
  name: string
  scene_kind: SceneKind
  ego_id: string
  n_steps: number
  /** Step limit (Python `SimCore.max_steps`). Defaults to `MAX_STEPS_DEFAULT`. */
  max_steps?: number
  actions: number[][]
  /** Expand `actions` this many times. Absent → the sequence is `actions`. */
  repeat?: number
  /**
   * Optional: the light to install right after the scene's `reset()`.
   *
   * The roundabout's own light is both-green ("no traffic lights there"),
   * so its swap is a no-op — the vectors that need an *observable* signal
   * override it with a plain NS-green light, the same override the Python
   * side applies (see `tests/contract/test_signal_actions.py`).
   */
  light_override?: { ns_green: boolean; ew_green: boolean }
  /** Optional: the external signal actions to apply, and when. */
  signal_actions?: VectorSignalAction[]
  /**
   * Optional: the ego pose to install right after the scene's `reset()`.
   *
   * Every vector used to be a straight-line scenario, so
   * Pure Pursuit's angle was ~0, `steer` was 0, and the three turning
   * constants (`LOOKAHEAD_DISTANCE`, `MAX_STEER`, `EGO_WHEELBASE`) were
   * blind spots: changing them changed no trajectory. A vector that starts
   * the ego off its target line makes the steer non-zero, so they become
   * observable.
   *
   * The Python side applies the same override to `core.ego` right after
   * `reset()` and cross-checks the golden's copy against the vector's.
   */
  ego_start?: { x: number; z: number; heading: number; speed: number }
}

/**
 * Expand a vector's action list.
 *
 * The rule — identical to the Python side's, one line each:
 *   if the vector has `repeat`, the actual action sequence is `actions`
 *   repeated `repeat` times; otherwise it is `actions` itself.
 *
 * A malformed `repeat` (null, a non-integer, zero or negative) throws
 * here rather than silently producing an empty or partial action list:
 * `Array.from({length: null})` yields an *empty* array, which would run a
 * vacuous episode and report a bogus "agreement". The Python side raises
 * on the same malformed input, so both sides now fail loudly.
 *
 * What the contract guarantees is that a divergence which changes the
 * **observable** episode is caught — the sample count or a sampled value.
 * It does NOT follow that *every* divergence is caught: when both episodes
 * terminate at the same step, a count difference *beyond* that step
 * (e.g. TS `repeat: 401` vs Python `repeat: 400` on a vector that ends at
 * step 257) produces byte-identical output and no red.
 */
const expandActions = (v: Vector): number[][] => {
  if (v.repeat === undefined) return v.actions
  if (!Number.isInteger(v.repeat) || v.repeat < 1) {
    throw new Error(
      `vector "${v.name}": "repeat" must be a positive integer, got ${JSON.stringify(v.repeat)}`,
    )
  }
  return Array.from({ length: v.repeat }, () => v.actions).flat()
}

/**
 * Parse a vector's optional `signal_actions` list.
 *
 * A malformed entry throws **here** instead of being silently ignored: an
 * ignored action would make the trajectory comparison vacuous (both sides
 * would run the same default episode and "agree"). The Python side
 * validates the same entries when it reads them back from the golden.
 */
const parseSignalActions = (v: Vector): MirrorSignalAction[] => {
  const raw = v.signal_actions
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new Error(`vector "${v.name}": "signal_actions" must be an array`)
  }
  const parsed: MirrorSignalAction[] = raw.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`vector "${v.name}": every signal action must be an object`)
    }
    if (!Number.isInteger(entry.step) || entry.step < 1) {
      throw new Error(
        `vector "${v.name}": signal action "step" must be a positive integer, ` +
          `got ${JSON.stringify(entry.step)}`,
      )
    }
    if (!SIGNAL_ACTION_NAMES.includes(entry.action)) {
      throw new Error(
        `vector "${v.name}": unknown signal action "${entry.action}"; ` +
          `expected one of ${SIGNAL_ACTION_NAMES.join(', ')}`,
      )
    }
    return { step: entry.step, action: entry.action }
  })
  assertValidSignalActions(parsed)
  return parsed
}

/**
 * Parse a vector's optional `light_override`.
 *
 * The override is applied right after the scene's `reset()`, exactly like
 * the Python side's `core.light = TrafficLight(ns_green=..., ew_green=...)`.
 */
const parseLightOverride = (v: Vector): MirrorLightOverride | undefined => {
  const raw = v.light_override
  if (raw === undefined) return undefined
  if (typeof raw.ns_green !== 'boolean' || typeof raw.ew_green !== 'boolean') {
    throw new Error(`vector "${v.name}": "light_override" needs boolean "ns_green" and "ew_green"`)
  }
  return { nsGreen: raw.ns_green, ewGreen: raw.ew_green }
}

/**
 * Parse a vector's optional `ego_start`.
 *
 * The override is applied right after the scene's `reset()`, exactly like
 * the Python side's `core.ego = Vehicle(...)`.
 *
 * A malformed field throws **here**: an ignored override would leave the
 * ego on its straight-line start, where `steer` is 0 — and the comparison
 * would then "agree" on a trajectory that covers nothing.
 */
const parseEgoStart = (v: Vector): MirrorEgoStart | undefined => {
  const raw = v.ego_start
  if (raw === undefined) return undefined
  for (const key of ['x', 'z', 'heading', 'speed'] as const) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `vector "${v.name}": "ego_start.${key}" must be a finite number, ` +
          `got ${JSON.stringify(value)}`,
      )
    }
  }
  return { x: raw.x, z: raw.z, heading: raw.heading, speed: raw.speed }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT_DIR = process.env.TRAFFSIM3D_CONTRACT_DIR
  ? resolve(process.env.TRAFFSIM3D_CONTRACT_DIR)
  : resolve(HERE, '..', '..', 'TraffSim3D-backend', 'tests', 'contract')
const SNAPSHOT_DIR = resolve(CONTRACT_DIR, 'snapshots')
const VECTOR_PATH = resolve(CONTRACT_DIR, 'test_vector.json')

/**
 * Drive the **product** replay path with a fixed action sequence and
 * record the ego's speed after each step.
 *
 * The hand-rolled physics path is used on purpose: it is deterministic
 * and WASM-free. (The Rapier path re-derives heading from a quaternion
 * round-trip, which costs a few ULPs — the scenario-level golden covers
 * exactness; the kernel golden covers the product's speed integration.)
 */
const kernelSpeedSeries = (actions: number[][]): number[] => {
  const net = buildTestNetwork(1)
  const ctx: TickContext = {
    rapierWorld: null,
    signal: null,
    trajectoryExporter: null,
    sensorRegistry: null,
    lidarEnabled: false,
    getHostPose: () => null,
    fixedStepScheduler: null,
    draggingId: null,
    removeVehicle: () => {},
    policy: null,
    replayTargetId: 'v-1',
  }
  const series: number[] = []
  for (let i = 0; i < actions.length; i++) {
    ctx.replayAction = [actions[i]![0]!, actions[i]![1]!]
    tick(net, PYTHON_SIM.DT, (i + 1) * PYTHON_SIM.DT, ctx)
    series.push(net.vehicles['v-1']!.speed)
  }
  return series
}

/**
 * Is the on-disk golden's *content* the same as what we would write?
 *
 * A byte-exact comparison would report every golden as stale on a checkout
 * whose line endings differ from the generator's: Windows with
 * `core.autocrlf=true` rewrites the committed LF files as CRLF, and the
 * generator writes LF. Such a difference is indistinguishable from drift
 * with a byte compare, so the check would exit 1 on a pristine tree.
 *
 * Comparing the parsed JSON is insensitive to line endings, indentation and
 * a trailing newline, and leaves only genuine drift — including a golden
 * someone reformatted by hand, which is not a change worth failing on.
 */
const sameContent = (raw: string | null, payload: unknown): boolean => {
  if (raw === null) return false
  try {
    return JSON.stringify(JSON.parse(raw)) === JSON.stringify(payload)
  } catch {
    // An unparseable golden is stale state, not a crash.
    return false
  }
}

const main = (): void => {
  const checkOnly = process.argv.includes('--check')
  if (!existsSync(VECTOR_PATH)) {
    throw new Error(`vector file not found: ${VECTOR_PATH}`)
  }
  const vectorFile = JSON.parse(readFileSync(VECTOR_PATH, 'utf-8')) as {
    sample_every?: number
    vectors: Vector[]
  }
  const vectors = vectorFile.vectors
  // The sample stride comes from the vector file — the same source the
  // Python side reads. Python's fallback is 5 (`data.get("sample_every", 5)`),
  // so use 5 here too: dropping the key must not silently change one side's
  // stride and not the other's, which would surface as a bare
  // "sample count mismatch" that does not name the cause.
  const sampleEvery = vectorFile.sample_every ?? 5

  // Only the write path creates the directory: `contract:check` must not
  // touch the filesystem.
  if (!checkOnly && !existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true })

  const stale: string[] = []
  const orphaned: string[] = []
  const expected = new Set<string>()
  for (const v of vectors) {
    const actions = expandActions(v)
    const signalActions = parseSignalActions(v)
    const lightOverride = parseLightOverride(v)
    const egoStart = parseEgoStart(v)
    const episode = runEpisode(
      v.scene_kind,
      actions.map((a) => a[0]!),
      sampleEvery,
      v.max_steps,
      {
        lightOverride,
        signalActions,
        egoStart,
        // The steering channel (`action[1]`) is a residual on
        // top of the scripted Pure Pursuit steer. The Python side reads the
        // same vector, so both sides drive the same trajectory.
        steerActions: actions.map((a) => a[1]!),
      },
    )
    const light = sceneLight(v.scene_kind)
    const scenario = {
      name: v.name,
      scene_kind: v.scene_kind,
      ego_id: v.ego_id,
      // The shared signal-action vocabulary. The Python
      // side compares this block against its own `sim_core` constants, so a
      // disagreement between the two sides' vocabularies turns the contract
      // red. Each side owns its own copy of the list — a file both sides
      // read would make the assertion vacuous.
      signal_vocabulary: {
        actions: [...SIGNAL_ACTION_NAMES],
        all_red_seconds: ALL_RED_SECS,
        phase_adjust_seconds: PHASE_ADJUST_SECS,
        max_green_seconds: MAX_GREEN_SECS,
        min_green_seconds: MIN_GREEN_SECS,
        inter_green_seconds: MIN_INTER_GREEN_SECS,
      },
      // The road rules — the road's half-width and each
      // scene's goal line. The Python side cross-checks these against its
      // own `sim_core` copies, so a one-sided change of either turns the
      // contract red (each side owns its own copy on purpose: a file both
      // sides read would make the comparison vacuous).
      road_rules: {
        road_half_width: PYTHON_SIM.ROAD_HALF_WIDTH,
        scene_goal_z: { ...PYTHON_SIM.SCENE_GOAL_Z },
      },
      // The scene's **own** light schedule — the phase the
      // light starts in and the length of a phase. The Python side
      // compares this block against the light its own `SimCore.reset()`
      // installs, so a one-sided change of either turns the contract red
      // (each side owns its own schedule on purpose).
      //
      // This is the scene's light, *before* any vector-level
      // `light_override` — that override is recorded separately below.
      scene_light: {
        cycle_seconds: light.cycleDuration,
        ns_green_at_reset: light.nsGreen,
        ew_green_at_reset: light.ewGreen,
      },
      // The light override the mirror actually ran with (absent → the
      // scene's own light). The Python side cross-checks it against the
      // vector's copy.
      ...(lightOverride
        ? {
            light_override: {
              ns_green: lightOverride.nsGreen,
              ew_green: lightOverride.ewGreen,
            },
          }
        : {}),
      // The external signal actions the mirror actually applied, and when.
      // The Python side reads the sequence **from here** — the golden is
      // the single source it applies — so a stale golden cannot hide a
      // changed vector (it cross-checks the two against each other).
      ...(signalActions.length > 0
        ? { signal_actions: signalActions.map((e) => ({ step: e.step, action: e.action })) }
        : {}),
      // The ego pose the mirror actually started from (absent → the
      // scene's own start). The Python side cross-checks it against the
      // vector's copy.
      ...(egoStart
        ? {
            ego_start: {
              x: egoStart.x,
              z: egoStart.z,
              heading: egoStart.heading,
              speed: egoStart.speed,
            },
          }
        : {}),
      final_state: {
        terminated: episode.terminated,
        truncated: episode.truncated,
        reason: episode.reason,
        final_step: episode.finalStep,
        final_z: episode.finalZ,
        final_x: episode.finalX,
        final_speed: episode.finalSpeed,
      },
      samples: episode.samples.map((s) => ({
        step: s.step,
        ego_id: v.ego_id,
        x: s.x,
        z: s.z,
        heading: s.heading,
        speed: s.speed,
        light: {
          nsGreen: s.light.nsGreen,
          ewGreen: s.light.ewGreen,
        },
      })),
    }
    const kernel = {
      name: v.name,
      scene_kind: v.scene_kind,
      dt: PYTHON_SIM.DT,
      speed_series: kernelSpeedSeries(actions),
    }

    for (const [fileName, payload] of [
      [`ts_${v.name}.json`, scenario],
      [`ts_kernel_${v.name}.json`, kernel],
    ] as const) {
      expected.add(fileName)
      const target = resolve(SNAPSHOT_DIR, fileName)
      if (checkOnly) {
        const current = existsSync(target) ? readFileSync(target, 'utf-8') : null
        if (!sameContent(current, payload)) stale.push(fileName)
      } else {
        writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
        console.log(`wrote ${fileName}`)
      }
    }
  }

  // A golden left behind by a removed or renamed vector is stale state too:
  // no vector produces it, and the snapshot directory should contain exactly
  // the expected set. It is reported separately because `contract:gen`
  // cannot repair it — the file has to be deleted.
  if (checkOnly && existsSync(SNAPSHOT_DIR)) {
    for (const entry of readdirSync(SNAPSHOT_DIR)) {
      if (!entry.startsWith('ts_') || !entry.endsWith('.json')) continue
      if (expected.has(entry)) continue
      orphaned.push(entry)
    }
  }

  if (checkOnly && stale.length > 0) {
    console.error(`stale contract snapshots: ${stale.join(', ')}\n` + 'Run: npm run contract:gen')
    process.exitCode = 1
  }
  if (checkOnly && orphaned.length > 0) {
    console.error(
      `orphaned contract snapshots (no vector produces them): ${orphaned.join(', ')}\n` +
        'Delete them, or restore the vector they belong to.',
    )
    process.exitCode = 1
  }
}

main()

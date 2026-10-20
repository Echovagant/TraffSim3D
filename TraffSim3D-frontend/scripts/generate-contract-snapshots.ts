// scripts/generate-contract-snapshots.ts
//
// Plan 071: generate the TS-side golden snapshots for the cross-language
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

import { runEpisode, type SceneKind } from '../src/application/services/simCoreMirror'
import { tick } from '../src/application/services/tick'
import { buildTestNetwork } from '../src/__fixtures__/testNetwork'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  PHASE_ADJUST_SECS,
  PYTHON_SIM,
  SIGNAL_ACTION_NAMES,
} from '../src/shared/constants/simulation'
import type { TickContext } from '../src/application/services/tick'

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
    const episode = runEpisode(
      v.scene_kind,
      actions.map((a) => a[0]!),
      sampleEvery,
      v.max_steps,
    )
    const scenario = {
      name: v.name,
      scene_kind: v.scene_kind,
      ego_id: v.ego_id,
      // The shared signal-action vocabulary (Plan 073 Sprint 2). The Python
      // side compares this block against its own `sim_core` constants, so a
      // disagreement between the two sides' vocabularies turns the contract
      // red. Each side owns its own copy of the list — a file both sides
      // read would make the assertion vacuous.
      signal_vocabulary: {
        actions: [...SIGNAL_ACTION_NAMES],
        all_red_seconds: ALL_RED_SECS,
        phase_adjust_seconds: PHASE_ADJUST_SECS,
        max_green_seconds: MAX_GREEN_SECS,
      },
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

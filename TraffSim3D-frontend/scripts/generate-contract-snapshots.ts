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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runEpisode, type SceneKind } from '../src/application/services/simCoreMirror'
import { tick } from '../src/application/services/tick'
import { buildTestNetwork } from '../src/__fixtures__/testNetwork'
import { PYTHON_SIM } from '../src/shared/constants/simulation'
import type { TickContext } from '../src/application/services/tick'

interface Vector {
  name: string
  scene_kind: SceneKind
  ego_id: string
  n_steps: number
  actions: number[][]
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

const main = (): void => {
  const checkOnly = process.argv.includes('--check')
  if (!existsSync(VECTOR_PATH)) {
    throw new Error(`vector file not found: ${VECTOR_PATH}`)
  }
  const vectors = (JSON.parse(readFileSync(VECTOR_PATH, 'utf-8')) as { vectors: Vector[] }).vectors

  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true })

  const stale: string[] = []
  for (const v of vectors) {
    const episode = runEpisode(
      v.scene_kind,
      v.actions.map((a) => a[0]!),
    )
    const scenario = {
      name: v.name,
      scene_kind: v.scene_kind,
      ego_id: v.ego_id,
      final_state: {
        terminated: episode.terminated,
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
      })),
    }
    const kernel = {
      name: v.name,
      scene_kind: v.scene_kind,
      dt: PYTHON_SIM.DT,
      speed_series: kernelSpeedSeries(v.actions),
    }

    for (const [fileName, payload] of [
      [`ts_${v.name}.json`, scenario],
      [`ts_kernel_${v.name}.json`, kernel],
    ] as const) {
      const target = resolve(SNAPSHOT_DIR, fileName)
      const content = `${JSON.stringify(payload, null, 2)}\n`
      if (checkOnly) {
        const current = existsSync(target) ? readFileSync(target, 'utf-8') : null
        if (current !== content) stale.push(fileName)
      } else {
        writeFileSync(target, content, 'utf-8')
        console.log(`wrote ${fileName}`)
      }
    }
  }

  if (checkOnly && stale.length > 0) {
    console.error(`stale contract snapshots: ${stale.join(', ')}\n` + 'Run: npm run contract:gen')
    process.exitCode = 1
  }
}

main()

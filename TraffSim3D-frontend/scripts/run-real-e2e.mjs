/**
 * Run the opt-in real-PPO e2e spec.
 *
 * `tests/e2e/ai-playground-real.spec.ts` starts a REAL PPO run: it writes
 * the shared training-status document and the checkpoint directory, so
 * every spec that runs after it reads a status that belongs to that run.
 * That is exactly how `ai-playground-scene.spec.ts` ended up clicking a
 * training button the page had already disabled. The spec is therefore
 * gated behind `E2E_REAL_TRAINING=1` and skipped by the default suite.
 *
 * Setting an environment variable from an npm script needs `cross-env` on
 * Windows (`FOO=1 cmd` is not valid in cmd.exe), and this project does
 * not depend on `cross-env` — so the variable is set here and Playwright
 * is spawned as a child process.
 *
 * The preflight below is not decoration. The spec itself FAILS (never
 * skips) once the opt-in gate is on, because a skipped real-training
 * test is indistinguishable from a passing one in a CI report — and
 * that is precisely the failure mode this script exists to close. The
 * preflight turns the two most common misconfigurations ("no backend
 * running", "backend without stable-baselines3") into an immediate,
 * readable error instead of a browser session that fails 60 s later.
 *
 * Usage:
 *   npm run test:e2e:real
 *   npm run test:e2e:real -- --headed
 *
 * Environment:
 *   E2E_BACKEND_URL   the real backend (default http://localhost:8000)
 *   E2E_REAL_STEPS    env steps the run asks for (default 200)
 *   E2E_REAL_DEVICE   'auto' | 'gpu' | 'cpu' (default: pick from the backend)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js')

if (!existsSync(cli)) {
  console.error('Cannot find @playwright/test — run `npm install` first.')
  process.exit(2)
}

const backendUrl = process.env.E2E_BACKEND_URL ?? 'http://localhost:8000'

/**
 * Check that the backend is up AND has stable-baselines3 before the
 * browser starts.
 *
 * The capabilities endpoint is the one that imports torch, so this call
 * also pays the cold-import cost that the spec would otherwise hit
 * inside its own timeout window.
 */
const preflight = async () => {
  let caps
  try {
    const res = await fetch(`${backendUrl}/api/v1/rl/capabilities`, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      throw new Error(`GET /api/v1/rl/capabilities returned ${res.status}`)
    }
    caps = await res.json()
  } catch (e) {
    console.error(
      `Backend not reachable on ${backendUrl}: ${e instanceof Error ? e.message : String(e)}\n` +
        'Start it first, e.g.:\n' +
        '  cd TraffSim3D-backend && .\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --port 8000\n' +
        'The real-training spec fails (it does not skip) when the backend is down.',
    )
    process.exit(2)
  }
  if (!caps.sb3_available) {
    console.error(
      `stable-baselines3 is not installed on the backend at ${backendUrl}.\n` +
        'Without it the trainer silently falls back to dry-run (a fabricated reward ' +
        'curve), which would prove nothing.\n' +
        'Install the backend with the RL extra:\n' +
        '  python -m pip install -e ".[rl]"',
    )
    process.exit(2)
  }
  console.log(
    `Preflight OK — ${backendUrl} | torch ${caps.torch_version || 'not installed'} | ` +
      `SB3 yes | CUDA ${caps.cuda_available ? 'yes' : 'no'}`,
  )
}

await preflight()

const args = ['test', 'tests/e2e/ai-playground-real.spec.ts', ...process.argv.slice(2)]

const child = spawn(process.execPath, [cli, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, E2E_REAL_TRAINING: '1' },
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Playwright was terminated by signal ${signal}.`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})

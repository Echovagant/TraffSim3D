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
 * Usage:
 *   npm run test:e2e:real
 *   npm run test:e2e:real -- --headed
 *
 * The backend has to be reachable on $E2E_BACKEND_URL (default
 * http://localhost:8000) with SB3 installed, otherwise the spec skips
 * itself with the reason printed.
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

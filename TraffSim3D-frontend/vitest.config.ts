// TraffSim3D-frontend/vitest.config.ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@application': fileURLToPath(new URL('./src/application', import.meta.url)),
      '@infrastructure': fileURLToPath(new URL('./src/infrastructure', import.meta.url)),
      '@interfaces': fileURLToPath(new URL('./src/interfaces', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@__fixtures__': fileURLToPath(new URL('./src/__fixtures__', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Exclude e2e specs (they run under Playwright, not vitest).
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
    // The Rapier WASM + Three.js + Pinia stack is heavy; let Vite
    // pre-bundle it once for all tests.
    deps: {
      optimizer: {
        web: { enabled: true },
      },
    },
    // Coverage baseline. Scoped to the DDD layers —
    // entry point, type-only barrels and config files are excluded so the
    // number reflects testable logic, not file count.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/domain/**/*.ts',
        'src/application/**/*.ts',
        'src/infrastructure/**/*.ts',
        'src/interfaces/**/*.ts',
        'src/shared/**/*.ts',
      ],
      exclude: ['**/*.spec.ts', '**/*.d.ts', '**/index.ts', '**/main.ts', '**/fixtures/**'],
      // The documented "coverage >= 70%" gate is only real if it can
      // fail. Without a threshold, `npm run test:coverage` merely *reports*
      // the number and coverage could decay silently. The backend already
      // gates on `pytest --cov=app --cov-fail-under=70`; this makes the
      // frontend side symmetric. Measured 2026-10-24: 89.95% statements /
      // 86.52% branches / 89.23% functions / 89.95% lines.
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
})

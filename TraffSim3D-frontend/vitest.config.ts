// TraffSim3D-frontend/vitest.config.ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

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
    // Plan 042: exclude e2e specs (they run under Playwright, not vitest).
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
    // The Rapier WASM + Three.js + Pinia stack is heavy; let Vite
    // pre-bundle it once for all tests.
    deps: {
      optimizer: {
        web: { enabled: true },
      },
    },
  },
});

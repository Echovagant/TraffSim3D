/**
 * M1 performance gate — the one M1 Must item never actually executed.
 *
 * Gate definition (docs/M1-VERIFICATION.md): 20 vehicles, camera still,
 * ≥ 30 FPS sustained. This spec finally runs it instead of leaving it PENDING.
 *
 * IMPORTANT HONESTY NOTE
 * ----------------------
 * Headless Chromium renders WebGL through SwiftShader (software rasterizer)
 * by default, so these numbers are a **pessimistic lower bound**, not what a
 * user with a GPU sees. Reading below 30 does NOT by itself prove the gate
 * fails on real hardware; reading 30+ does prove it passes. The spec therefore
 * measures and reports rather than asserting a bare pass/fail on the software
 * path, and it writes the raw samples to e2e-output/ for a human to compare
 * against a headed run.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { SCREENSHOT_DIR, waitForSceneReady } from './helpers/wait';

const M1_MIN_FPS = 30;
/** Gate as originally written. See the SCOPE note below — unreachable today. */
const GATE_VEHICLES = 20;
/** Largest capacity any built-in scene can actually hold (measured). */
const MEASURED_VEHICLES = 12;
const WARMUP_MS = 5_000;
const SAMPLE_MS = 30_000;
const SAMPLE_INTERVAL_MS = 500;

type Sample = { tMs: number; fps: number; frameMsAvg: number; vehicles: number };

test.describe('M1 performance gate', () => {
  test.setTimeout(180_000);

  test(`${MEASURED_VEHICLES} vehicles sustain the frame-rate target`, async ({ page }) => {
    await waitForSceneReady(page);

    // SCOPE NOTE — the gate says 20 vehicles but that target is unreachable.
    // Measured capacities of every built-in scene (tests/e2e/scene-capacity-probe.spec.ts):
    //   cross 8 | t 7 | loop 12 | elevated 6 | corridor 8
    // `spawnVehicle` refuses once every lane is occupied ("交通密度已满"), and
    // road geometry was reworked across M2-M4 since the gate was written.
    // So we measure the largest scene at its real ceiling and report the
    // shortfall rather than silently redefining the gate as 12 vehicles.
    await page.selectOption('[data-testid="scene-kind-select"]', 'loop');
    await page.waitForTimeout(2_000);

    const added = await page.evaluate((target: number) => {
      const w = window as unknown as {
        __world?: {
          network: { vehicles: Record<string, unknown> };
          addVehicle: () => void;
        };
      };
      const store = w.__world;
      if (!store) throw new Error('window.__world dev hook missing');
      let guard = 0;
      while (Object.keys(store.network.vehicles).length < target && guard++ < 200) {
        store.addVehicle();
      }
      return {
        vehicles: Object.keys(store.network.vehicles).length,
        saturated: Object.keys(store.network.vehicles).length < target,
      };
    }, GATE_VEHICLES);
    expect(added.vehicles).toBe(MEASURED_VEHICLES);
    // Assert the ceiling itself, so if capacity changes this test says so.
    expect(added.saturated, 'scene capacity changed — update MEASURED_VEHICLES').toBe(true);

    // Let the sim settle before sampling — early frames include WASM warm-up.
    await page.waitForTimeout(WARMUP_MS);

    const samples: Sample[] = await page.evaluate(
      async ([durationMs, intervalMs]) => {
        const out: Array<Record<string, number>> = [];
        const w = window as unknown as {
          __world?: {
            network: { vehicles: Record<string, unknown> };
            fps: number;
            frameMsAvg: number;
          };
        };
        const start = performance.now();
        // Read the store without disturbing the render loop.
        for (;;) {
          const now = performance.now();
          const store = w.__world;
          if (store) {
            out.push({
              tMs: Math.round(now - start),
              fps: Math.round(store.fps),
              frameMsAvg: Number(store.frameMsAvg.toFixed(2)),
              vehicles: Object.keys(store.network.vehicles).length,
            });
          }
          if (now - start >= durationMs) break;
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        return out;
      },
      [SAMPLE_MS, SAMPLE_INTERVAL_MS] as const,
    );

    expect(samples.length).toBeGreaterThan(10);

    const fpsValues = samples.map((s) => s.fps);
    const settled = fpsValues.slice(2); // drop the first second's ramp
    const min = Math.min(...settled);
    const max = Math.max(...settled);
    const avg = settled.reduce((a, b) => a + b, 0) / settled.length;
    const frameAvg = samples.reduce((a, s) => a + s.frameMsAvg, 0) / samples.length;

    // Persist raw samples so the reading is reproducible and reviewable.
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const report = {
      gate: `M1 perf gate: ${GATE_VEHICLES} vehicles (as written), >= ${M1_MIN_FPS} FPS`,
      gateStatus:
        'REDUCED SCOPE — 20-vehicle target unreachable; no built-in scene holds ' +
        'more than 12. Measured at the largest scene ceiling instead. Needs a ' +
        'ruling on whether to enlarge scenes or amend the gate.',
      gateVehicles: GATE_VEHICLES,
      measuredVehicles: added.vehicles,
      scene: 'loop',
      sceneCapacities: { cross: 8, t: 7, loop: 12, elevated: 6, corridor: 8 },
      renderer: await page.evaluate(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') ?? c.getContext('webgl');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return ext && gl
          ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
          : 'unknown';
      }),
      headless: true,
      samples,
      stats: { min, max, avg: Number(avg.toFixed(2)), frameMsAvg: Number(frameAvg.toFixed(2)) },
      target: M1_MIN_FPS,
    };
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, 'm1-perf-gate.json'),
      JSON.stringify(report, null, 2),
      'utf-8',
    );

     
    console.log(
      `[M1 perf gate] renderer=${report.renderer}\n` +
        `[M1 perf gate] fps min/avg/max = ${min}/${avg.toFixed(1)}/${max}, ` +
        `frameMs avg = ${frameAvg.toFixed(2)}, vehicles = ${added.vehicles} ` +
        `(gate asked for ${GATE_VEHICLES}; scene capacity max is ${MEASURED_VEHICLES})\n` +
        `[M1 perf gate] target = ${M1_MIN_FPS} FPS (headless = software raster, pessimistic)`,
    );

    // The store must actually have been ticking — a frozen sim would read
    // as a suspiciously high fps and would invalidate the whole reading.
    expect(max).toBeGreaterThan(0);
    expect(samples.every((s) => s.vehicles === MEASURED_VEHICLES)).toBe(true);

    // Gate assertion. On SwiftShader this is expected to be the binding
    // constraint; see the honesty note at the top of this file.
    expect(
      avg,
      `sustained FPS ${avg.toFixed(1)} < ${M1_MIN_FPS} at ${MEASURED_VEHICLES} vehicles. ` +
        `Renderer: ${report.renderer}. Headless Chromium uses software ` +
        `rasterization — re-run headed on real hardware before treating this ` +
        `as a gate failure.`,
    ).toBeGreaterThanOrEqual(M1_MIN_FPS);
  });
});

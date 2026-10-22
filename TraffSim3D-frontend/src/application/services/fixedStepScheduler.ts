// src/application/services/fixedStepScheduler.ts
//
// A tiny scheduler that converts a
// stream of variable-rate wall-clock dt calls into a stream of
// fixed-rate tick boundary events. Used to drive the trajectory
// exporter at a steady 10 Hz regardless of how fast the render loop
// is firing — RL training needs evenly-spaced samples so that
// the advantage estimator doesn't see Δt jitter.
//
// Usage:
//   const s = new FixedStepScheduler({ fixedStepSec: 0.1 });
//   loop {
//     const wallDt = readClock();
//     while (s.advance(wallDt)) {
//       // fixed-step boundary crossed; do work at this rate
//     }
//   }
//
// Or single-step:
//   if (s.advance(wallDt)) exporter.record(...);

export interface FixedStepSchedulerOptions {
  /** Fixed-step size in seconds. Default 0.1 = 10 Hz. */
  fixedStepSec?: number
  /**
   * Cap on the accumulator (seconds). When a single wallDt pushes the
   * accumulator past this cap (e.g. browser GC pause, tab switch),
   * we clamp the *consumed* wallDt to this cap so the next call
   * doesn't fire dozens of "missed" steps. Default 0.5s = 5 steps.
   */
  maxAccumulator?: number
}

export class FixedStepScheduler {
  private accumulator = 0
  private readonly fixedStepSec: number
  private readonly maxAccumulator: number
  private simTime = 0

  constructor(opts: Partial<FixedStepSchedulerOptions> = {}) {
    this.fixedStepSec = opts.fixedStepSec ?? 0.1
    this.maxAccumulator = opts.maxAccumulator ?? 0.5
    if (this.fixedStepSec <= 0) {
      throw new Error('FixedStepScheduler: fixedStepSec must be > 0')
    }
    if (this.maxAccumulator < this.fixedStepSec) {
      throw new Error('FixedStepScheduler: maxAccumulator must be >= fixedStepSec')
    }
  }

  /**
   * Push `wallDt` seconds into the accumulator. Returns true if a
   * fixed-step boundary was crossed since the last call, in which
   * case `getSimTime()` has advanced by exactly `fixedStepSec`.
   *
   * One call returns at most one true. To drain a long pause, loop:
   *   while (s.advance(wallDt)) doStep();
   *
   * wallDt is clamped to `maxAccumulator` so a 2-second browser-GC
   * pause doesn't fire 20 false steps in a row. The "missing" steps
   * are silently dropped — that's the trade-off the user accepted
   * (vs. running the world at 2× speed to catch up).
   */
  advance(wallDt: number): boolean {
    if (wallDt <= 0) return false
    const clamped = Math.min(wallDt, this.maxAccumulator)
    this.accumulator += clamped
    if (this.accumulator >= this.fixedStepSec) {
      this.accumulator -= this.fixedStepSec
      this.simTime += this.fixedStepSec
      return true
    }
    return false
  }

  /** Monotonic simulation time in seconds, advanced by `fixedStepSec` per step. */
  getSimTime(): number {
    return this.simTime
  }

  /** Current accumulator value, in [0, fixedStepSec). Useful for tests. */
  getAccumulator(): number {
    return this.accumulator
  }

  /** Reset both accumulator and simTime to 0. Called on world reset. */
  reset(): void {
    this.accumulator = 0
    this.simTime = 0
  }
}

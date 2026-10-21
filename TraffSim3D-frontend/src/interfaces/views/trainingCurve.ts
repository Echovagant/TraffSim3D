/**
 * Plan 075: the geometry of the training-curve chart.
 *
 * WHY A HELPER AT ALL
 * -------------------
 * The AI Playground has to show **two different curves** and they must not
 * be confused:
 *
 * 1. the raw per-episode *training* reward — a stochastic policy's sampled
 *    return, noisy, and **not** comparable with anything;
 * 2. the policy's *deterministic evaluation* return against the training
 *    step, with the fixed 30/30 cycle as the horizontal reference line it
 *    has to beat.
 *
 * The second one is what this module computes. It is a pure function on
 * plain data (no Vue, no DOM) so it can be reasoned about — and tested —
 * on its own.
 *
 * The rule that makes the curve readable: **the part of the curve that is
 * above the baseline is marked**, so "the policy beat the baseline" is
 * visible at a glance instead of something the reader has to work out by
 * comparing two numbers.
 */

/** One point of the backend's evaluation series (`signal_eval_series`). */
export interface EvalPoint {
  /** The training step the policy was evaluated at. */
  step: number
  /** The deterministic evaluation return (the reward is a negative delay). */
  return: number
  /** The fixed 30/30 cycle measured **on this point's condition**. */
  baseline: number
  /** `train` / `eval` / `holdout` — the condition the point was measured on. */
  condition: string
}

/** The chart's box and its padding, in SVG user units. */
export interface EvalChartLayout {
  width: number
  height: number
  padLeft: number
  padRight: number
  padTop: number
  padBottom: number
}

export interface EvalCurveGeometry {
  /** The whole curve, as an SVG `points` string. */
  line: string
  /**
   * The parts of the curve that lie **above** the baseline, clipped at the
   * crossings — one SVG `points` string per contiguous piece.
   */
  above: string[]
  /** The baseline's y position (SVG coordinates: smaller is higher). */
  baselineY: number
  /** The value range the chart covers. */
  domain: { lo: number; hi: number }
  /** The x positions of the curve's points. */
  pointX: number[]
  /** The y positions of the curve's points. */
  pointY: number[]
}

const EMPTY: EvalCurveGeometry = {
  line: '',
  above: [],
  baselineY: 0,
  domain: { lo: 0, hi: 1 },
  pointX: [],
  pointY: [],
}

const fmt = (value: number): string => value.toFixed(1)

/**
 * Build the curve's geometry.
 *
 * The baseline is the **last** point's baseline — every point of one
 * condition carries the same baseline (the fixed cycle measured on that
 * condition), and the last point is the freshest measurement of it.
 */
export function buildEvalCurve(
  points: readonly EvalPoint[],
  layout: EvalChartLayout,
): EvalCurveGeometry {
  if (points.length === 0) return EMPTY

  const baseline = points[points.length - 1]!.baseline
  const values = points.map((point) => point.return).concat([baseline])
  const rawLo = Math.min(...values)
  const rawHi = Math.max(...values)
  const span = Math.max(1e-6, rawHi - rawLo)
  // A little headroom so the curve never touches the frame.
  const lo = rawLo - span * 0.1
  const hi = rawHi + span * 0.1

  const steps = points.map((point) => point.step)
  const minStep = Math.min(...steps)
  const maxStep = Math.max(...steps)
  const stepSpan = Math.max(1, maxStep - minStep)

  const plotWidth = layout.width - layout.padLeft - layout.padRight
  const plotHeight = layout.height - layout.padTop - layout.padBottom

  const x = (step: number): number => layout.padLeft + ((step - minStep) / stepSpan) * plotWidth
  const y = (value: number): number => layout.padTop + ((hi - value) / (hi - lo)) * plotHeight

  const pointX = points.map((point) => x(point.step))
  const pointY = points.map((point) => y(point.return))
  const line = points
    .map((_point, index) => `${fmt(pointX[index]!)},${fmt(pointY[index]!)}`)
    .join(' ')

  // The part above the baseline, clipped at the crossings: a segment that
  // crosses the baseline is split at the crossing, so the marked piece
  // starts and ends exactly on the baseline line.
  const above: string[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length > 1) above.push(run.join(' '))
    run = []
  }

  for (let index = 0; index + 1 < points.length; index++) {
    const current = points[index]!
    const next = points[index + 1]!
    const x0 = pointX[index]!
    const x1 = pointX[index + 1]!
    const y0 = pointY[index]!
    const y1 = pointY[index + 1]!
    const aboveCurrent = current.return > baseline
    const aboveNext = next.return > baseline

    if (aboveCurrent && aboveNext) {
      if (run.length === 0) run.push(`${fmt(x0)},${fmt(y0)}`)
      run.push(`${fmt(x1)},${fmt(y1)}`)
      continue
    }
    if (aboveCurrent !== aboveNext) {
      // The segment crosses the baseline: split it there.
      const ratio = (baseline - current.return) / (next.return - current.return)
      const crossX = x0 + ratio * (x1 - x0)
      const crossY = y(baseline)
      if (aboveCurrent) {
        if (run.length === 0) run.push(`${fmt(x0)},${fmt(y0)}`)
        run.push(`${fmt(crossX)},${fmt(crossY)}`)
        flush()
      } else {
        flush()
        run.push(`${fmt(crossX)},${fmt(crossY)}`)
        run.push(`${fmt(x1)},${fmt(y1)}`)
      }
      continue
    }
    // Both below the baseline — the run ends here.
    flush()
  }
  flush()

  return {
    line,
    above,
    baselineY: y(baseline),
    domain: { lo, hi },
    pointX,
    pointY,
  }
}

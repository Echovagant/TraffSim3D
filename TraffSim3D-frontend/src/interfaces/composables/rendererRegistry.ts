/**
 * Module-level registry for the main ThreeJSRenderer instance.
 *
 * CameraView needs access to the WebGLRenderer + Scene + Camera for
 * offscreen rendering (camera sensor), but must NOT create its own
 * ThreeJSRenderer — a second renderer means a second RAF loop, which
 * doubles `frameCount` in the FPS counter while one loop contributes
 * ~0 to `fpsAcc`, making the displayed FPS rise without bound.
 *
 * useWorldSimulation registers the renderer on creation; CameraView
 * reads it here instead of calling useWorldSimulation again.
 */
import type { ThreeJSRenderer } from '@infrastructure/rendering'

let mainRenderer: ThreeJSRenderer | null = null

export const setMainRenderer = (r: ThreeJSRenderer | null): void => {
  mainRenderer = r
}

export const getMainRenderer = (): ThreeJSRenderer | null => mainRenderer

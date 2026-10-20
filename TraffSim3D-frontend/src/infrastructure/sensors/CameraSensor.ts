// src/infrastructure/sensors/CameraSensor.ts
//
// M2-D (plan 025): virtual camera attached to a vehicle. Each tick
// (when enabled) the sensor positions itself at the host vehicle's
// pose and renders the scene to an offscreen WebGLRenderTarget.
// The pixel buffer is then exposed as a CameraFrame which consumers
// can display in a <canvas> or save as PNG.
//
// Implementation note: we don't read pixels every frame (expensive
// GPU→CPU transfer); we read on demand, when the PiP / export
// consumer asks. The default sample interval (CAMERA_SAMPLE_INTERVAL)
// throttles to ~5 Hz to keep the perf cost manageable.

import * as THREE from 'three'

export interface CameraConfig {
  vehicleId: string
  width: number
  height: number
  fov: number
  /** Forward distance from host vehicle center to the sensor (m). */
  forwardOffset: number
  /** Vertical offset from host vehicle ground (m). */
  heightOffset: number
}

export interface CameraFrame {
  vehicleId: string
  simTime: number
  width: number
  height: number
  rgba: Uint8Array
}

export const defaultCameraConfig = (vehicleId: string): CameraConfig => ({
  vehicleId,
  width: 256,
  height: 192,
  fov: 60,
  forwardOffset: 1.5,
  heightOffset: 1.5,
})

export class CameraSensor {
  private cfg: CameraConfig
  private camera: THREE.PerspectiveCamera
  private target: THREE.WebGLRenderTarget
  private pixelBuffer: Uint8Array
  private externalRenderer: THREE.WebGLRenderer | null

  constructor(cfg: CameraConfig, externalRenderer?: THREE.WebGLRenderer) {
    this.cfg = cfg
    this.camera = new THREE.PerspectiveCamera(cfg.fov, cfg.width / cfg.height, 0.1, 1000)
    this.target = new THREE.WebGLRenderTarget(cfg.width, cfg.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    })
    this.pixelBuffer = new Uint8Array(cfg.width * cfg.height * 4)
    this.externalRenderer = externalRenderer ?? null
  }

  /** Re-configure the sensor (e.g. when cameraEnabled flips true
   *  and we want a different resolution). */
  configure(cfg: Partial<CameraConfig>): void {
    const newCfg = { ...this.cfg, ...cfg }
    const sizeChanged = newCfg.width !== this.cfg.width || newCfg.height !== this.cfg.height
    this.cfg = newCfg
    this.camera.fov = newCfg.fov
    this.camera.aspect = newCfg.width / newCfg.height
    this.camera.updateProjectionMatrix()
    if (sizeChanged) {
      this.target.setSize(newCfg.width, newCfg.height)
      this.pixelBuffer = new Uint8Array(newCfg.width * newCfg.height * 4)
    }
  }

  /** Render one frame from `hostPose`. When an external renderer is
   *  available, render directly to its canvas (no readPixels — avoids
   *  the GPU→CPU sync stall). Otherwise fall back to the offscreen
   *  render-target + readPixels path. */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    simTime: number,
    hostPose: { position: { x: number; y: number; z: number }; heading: number },
  ): CameraFrame {
    const cos = Math.cos(hostPose.heading)
    const sin = Math.sin(hostPose.heading)
    this.camera.position.set(
      hostPose.position.x + cos * this.cfg.forwardOffset,
      hostPose.position.y + this.cfg.heightOffset,
      hostPose.position.z + sin * this.cfg.forwardOffset,
    )
    this.camera.rotation.set(0, -hostPose.heading, 0)

    if (this.externalRenderer) {
      this.externalRenderer.render(scene, this.camera)
      return {
        vehicleId: this.cfg.vehicleId,
        simTime,
        width: this.cfg.width,
        height: this.cfg.height,
        rgba: this.pixelBuffer,
      }
    }

    const prevTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, this.camera)
    renderer.readRenderTargetPixels(
      this.target,
      0,
      0,
      this.cfg.width,
      this.cfg.height,
      this.pixelBuffer,
    )
    renderer.setRenderTarget(prevTarget)

    return {
      vehicleId: this.cfg.vehicleId,
      simTime,
      width: this.cfg.width,
      height: this.cfg.height,
      rgba: this.pixelBuffer,
    }
  }

  /** Write a frame to a canvas (PiP display). WebGL's coordinate
   *  origin is bottom-left, canvas 2D's is top-left — we flip
   *  vertically via a temporary canvas. */
  renderToCanvas(frame: CameraFrame, canvas: HTMLCanvasElement): void {
    if (canvas.width !== frame.width) canvas.width = frame.width
    if (canvas.height !== frame.height) canvas.height = frame.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const imgData = new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height)
    const tmp = document.createElement('canvas')
    tmp.width = frame.width
    tmp.height = frame.height
    const tmpCtx = tmp.getContext('2d')
    if (!tmpCtx) return
    tmpCtx.putImageData(imgData, 0, 0)
    // Flip vertically so the image isn't upside-down on the canvas.
    ctx.save()
    ctx.scale(1, -1)
    ctx.drawImage(tmp, 0, -frame.height)
    ctx.restore()
  }

  get config(): CameraConfig {
    return this.cfg
  }

  destroy(): void {
    this.target.dispose()
  }
}

import * as THREE from 'three';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import { buildScene, syncMeshTransforms, type BuiltScene } from './SceneBuilder';
import { MAX_DPR } from '@shared/constants/simulation';

export interface RendererCallbacks {
  /** Called once per frame with the elapsed seconds since the last call. */
  onTick: (dt: number) => void;
}

/** Pure-TS Three.js renderer. Owns its own scene/camera/renderer; no Vue imports. */
export class ThreeJSRenderer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private built: BuiltScene | null = null;
  private currentNetwork: RoadNetwork | null = null;
  private getNetwork: (() => RoadNetwork) | null = null;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private callbacks: RendererCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks) {
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(40, 35, 40);
    this.camera.lookAt(0, 0, 0);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(50, 80, 30);
    this.scene.add(dir);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /**
   * Provide a getter that returns the current network. Called every frame.
   * If the network identity changes (e.g. after reset/load), the scene is
   * rebuilt; otherwise only mesh transforms are synced (cheap).
   *
   * Pass a getter, NOT the network object directly — `worldStore.step`
   * mutates the network in place each tick, and the renderer needs to
   * see those mutations.
   */
  setNetworkGetter(getter: () => RoadNetwork): void {
    this.getNetwork = getter;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.lastFrameMs = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.lastFrameMs) / 1000);  // clamp to avoid tab-switch jumps
      this.lastFrameMs = now;
      this.callbacks.onTick(dt);
      // Reconcile the scene with the current network. onTick above has
      // already mutated positions; this just syncs the mesh transforms.
      if (this.getNetwork) {
        const network = this.getNetwork();
        if (network !== this.currentNetwork) {
          if (this.built) this.scene.remove(this.built.root);
          this.built = buildScene(network);
          this.scene.add(this.built.root);
          this.currentNetwork = network;
        } else if (this.built) {
          syncMeshTransforms(network, this.built);
        }
      }
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
  }
}

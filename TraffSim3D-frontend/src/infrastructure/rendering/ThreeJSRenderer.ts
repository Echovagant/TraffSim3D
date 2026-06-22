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
  private controls: { update: () => void } | null = null;
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

  /** Public camera accessor so external controls (e.g. OrbitControls) can be attached. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Attach external controls by exposing the camera. OrbitControls wraps this. */
  attachControls(controls: { update: () => void }): void {
    this.controls = controls;
    this.controls.update();
  }

  /** Cast a ray from screen coordinates and return the first hit vehicle or light, or null. */
  pick(
    screenX: number,
    screenY: number,
    network: RoadNetwork,
  ): { kind: 'vehicle'; id: string } | { kind: 'light'; id: string } | null {
    if (!this.built) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    // Prefer vehicles (smaller, fewer tests)
    const vehicleMeshes = Array.from(this.built.vehicleMeshes.values());
    const hits = raycaster.intersectObjects(vehicleMeshes, false);
    if (hits.length > 0) {
      const mesh = hits[0]!.object as THREE.Mesh;
      for (const [vid, m] of this.built.vehicleMeshes) if (m === mesh) return { kind: 'vehicle', id: vid };
    }
    const lightMeshes = Array.from(this.built.lightMeshes.values());
    const lh = raycaster.intersectObjects(lightMeshes, false);
    if (lh.length > 0) {
      const mesh = lh[0]!.object as THREE.Mesh;
      for (const [lid, m] of this.built.lightMeshes) if (m === mesh) return { kind: 'light', id: lid };
    }
    return null;
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
      this.controls?.update();
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

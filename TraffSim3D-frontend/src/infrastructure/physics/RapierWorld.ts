// src/infrastructure/physics/RapierWorld.ts
//
// Rapier3D WASM physics world. Wraps `@dimforge/rapier3d-compat`
// behind the M2 contract interface (plans/m2-interface-contract.md
// §2). Lazy-imports Rapier to keep the initial bundle small and to
// avoid the dev-server first-load hang (R2).
//
// Rapier 内部用 `Vector` 数字元组 (r3.Vector) 表示 vec3. 我们的
// 公共接口用 `Vec3` (object). 内部到 Rapier 转换在 castRay /
// readPose 边界完成 — see toRapier / fromRapier below.

import type { Vec3, WorldConfig } from './WorldConfig';
import { DEFAULT_WORLD_CONFIG } from './WorldConfig';
import type { RigidBodySpec } from './RapierBodySpec';
import { buildRigidBodySpec } from './RapierBodySpec';
import type { World, EventQueue } from '@dimforge/rapier3d-compat/pipeline';

export interface ContactEvent {
  colliderA: string;
  colliderB: string;
  normal: Vec3;
  impulse: number;
}

export interface WorldStepResult {
  dt: number;
  contactEvents: ReadonlyArray<ContactEvent>;
  simTime: number;
}

export interface RayHit {
  point: Vec3 | null;
  distance: number;
  colliderHandle: string | null;
}

export interface VehicleControl {
  throttle: number;  // 0..1
  brake: number;  // 0..1
  steering: number;  // rad/s (M2 不用; M3 变道用)
}

// Rapier 的 collider handle 是 number. 我们用 vehicleId 作为稳定
// 字符串键,内部维护 Map<vehicleId, colliderHandle>.
type HandleMap = Map<string, number>;

export class RapierWorld {
  private R: typeof import('@dimforge/rapier3d-compat') | null = null;
  private world: World | null = null;
  private eventQueue: EventQueue | null = null;
  private bodies: HandleMap = new Map();
  private colliders: HandleMap = new Map();
  private colliderHandleToVehicleIdMap: Map<number, string> = new Map();
  private bodyForCollider: Map<number, number> = new Map();  // collider handle → body handle
  private cfg: WorldConfig;
  private simTime = 0;
  private destroyed = false;
  // Accumulator: 即使 render dt 是 1/30, 物理仍按 fixedDt=1/60
  // 推进 (1 帧物理 step 1 次). accumulator 留着给未来的"多次 step
  // 追上 wall-clock"用 — M2-A 默认 1 步/帧.
  private accumulator = 0;

  constructor(cfg: WorldConfig = DEFAULT_WORLD_CONFIG) {
    this.cfg = cfg;
  }

  /** Lazy init. 必须 await 后才能用其它方法. */
  async init(): Promise<void> {
    if (this.world) return;
    const mod = await import('@dimforge/rapier3d-compat');
    await mod.init();  // wasm 加载
    this.R = mod;
    this.world = new mod.World(this.cfg.gravity);
    // Rapier 求解器 seed 不可直接 set; 初始化场景的随机化由 collider
    // 位置保证 (我们都是确定性的位置传进去) — R3 通过"同一位置序列
    // 产出相同位置序列"间接满足.
    this.eventQueue = new mod.EventQueue(true);
    this.buildGround();
  }

  private buildGround(): void {
    if (!this.R || !this.world) return;
    // 大地面 cuboid. 1000x1000 足够大覆盖默认 scene.
    const groundDesc = this.R.RigidBodyDesc.fixed().setTranslation(0, -this.cfg.groundThickness, 0);
    const body = this.world.createRigidBody(groundDesc);
    const colliderDesc = this.R.ColliderDesc.cuboid(500, this.cfg.groundThickness, 500)
      .setFriction(0.8)
      .setRestitution(0.0);
    this.world.createCollider(colliderDesc, body);
    // ground 不入 body map — readPose 不会问到.
  }

  registerVehicle(spec: RigidBodySpec): string {
    if (this.destroyed) throw new Error('RapierWorld already destroyed');
    if (!this.R || !this.world) throw new Error('RapierWorld not initialized — call init() first');
    // 幂等: 已存在则更新位置/heading, 不创建新 body.
    const existing = this.bodies.get(spec.vehicleId);
    if (existing !== undefined) {
      const body = this.world.getRigidBody(existing);
      if (body) {
        body.setTranslation(this.toRapierVec3(spec.position), true);
        body.setRotation(this.toRapierQuat(spec.heading), true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        return spec.vehicleId;
      }
    }
    const bodyDesc = this.R.RigidBodyDesc.dynamic()
      .setTranslation(spec.position.x, spec.position.y, spec.position.z)
      .setRotation(this.toRapierQuat(spec.heading))
      .setLinearDamping(0.2)
      .setAngularDamping(0.4);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.R.ColliderDesc.cuboid(
      spec.halfExtents.x,
      spec.halfExtents.y,
      spec.halfExtents.z,
    )
      .setMass(spec.mass)
      .setFriction(0.5)
      .setRestitution(0.2);
    const collider = this.world.createCollider(colliderDesc, body);
    const bodyHandle = body.handle;
    const colliderHandle = collider.handle;
    this.bodies.set(spec.vehicleId, bodyHandle);
    this.colliders.set(spec.vehicleId, colliderHandle);
    this.colliderHandleToVehicleIdMap.set(colliderHandle, spec.vehicleId);
    this.bodyForCollider.set(colliderHandle, bodyHandle);
    return spec.vehicleId;
  }

  removeVehicle(vehicleId: string): void {
    if (!this.world) return;
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return;
    const body = this.world.getRigidBody(bodyHandle);
    if (body) {
      this.world.removeRigidBody(body);
    }
    this.bodies.delete(vehicleId);
    const colliderHandle = this.colliders.get(vehicleId);
    this.colliders.delete(vehicleId);
    if (colliderHandle !== undefined) {
      this.colliderHandleToVehicleIdMap.delete(colliderHandle);
    }
    // bodyForCollider 由 Rapier 的 handle 空间回收 — 不用手清.
  }

  /** Per-vehicle control input. Rapier 用 setLinvel 简化 (M2 不做
   *  力模型; M3 引入转向时再升级到 applyImpulse).
   *
   *  - throttle=1, brake=0 → targetSpeed 方向 setLinvel
   *  - brake=1 → setLinvel(0)
   *  - crashed vehicle → applyControl 收到 status='crashed' 时
   *    throttle=0, brake=1 (caller 负责)
   *
   *  这里 throttle/brake 直接由 caller 算好 targetSpeed 后转
   *  linvel; caller 不需要知道力学. 实施档简化: 我们把
   *  targetSpeed 当作 "想要的速度", 直接 setLinvel. 物理上不
   *  是"力推进" — 是"速度设置" — 但 M2-A 接受 (006 §Trade-offs). */
  applyControl(vehicleId: string, control: VehicleControl, targetSpeed: number, heading: number): void {
    if (!this.world) return;
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return;
    const body = this.world.getRigidBody(bodyHandle);
    if (!body) return;
    let v = 0;
    if (control.brake >= 0.99) {
      v = 0;
    } else if (control.throttle > 0) {
      v = Math.max(0, targetSpeed);
    } else {
      const lv = body.linvel();
      v = (lv.x !== 0 || lv.z !== 0)
        ? Math.hypot(lv.x, lv.z)
        : 0;
    }
    // heading 是 world-space (lane forward). 投影到 Rapier 2D.
    const vx = v * Math.cos(heading);
    const vz = v * Math.sin(heading);
    body.setLinvel({ x: vx, y: 0, z: vz }, true);
  }

  /**
   * Set a vehicle's linear velocity to `speed` along `heading`
   * (world-space, in radians). Heading follows the same convention
   * as `applyControl`: `vx = speed * cos(heading)`, `vz = speed * sin(heading)`.
   *
   * Unlike `applyControl`, this method is intended for **discrete
   * user-initiated edits** (the inspector), not the per-tick
   * physics step. The speed is applied immediately; the next
   * `applyControl` will respect it (because `applyControl` reads
   * `targetSpeed` and the entity's `targetSpeed` is the road limit,
   * but if the user set `speed` directly we want the body to show
   * that speed until the next traffic-light / car-following
   * decision resets `targetSpeed`).
   *
   * For the inspector use case, we want the user's edit to be
   * **observable** — change the body's linvel now. Subsequent ticks
   * will move `targetSpeed` again, but at least the visual
   * responds to the click.
   */
  setVehicleSpeed(vehicleId: string, speed: number, heading: number): void {
    if (!this.world) return;
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return;
    const body = this.world.getRigidBody(bodyHandle);
    if (!body) return;
    const v = Math.max(0, speed);
    const vx = v * Math.cos(heading);
    const vz = v * Math.sin(heading);
    body.setLinvel({ x: vx, y: 0, z: vz }, true);
  }

  /**
   * Teleport a vehicle's rigid body to `position` (world-space, metres).
   * Used by the editor's drag-to-move: while dragging, the position
   * is updated every frame; on drag end, the body is teleported to
   * the final spot and linvel is zeroed so the next applyControl
   * restarts from rest at the new spot.
   *
   * Implementation: setTranslation (wakes the body via `true`), then
   * setLinvel to zero. The `heading` is NOT updated here — drag
   * doesn't rotate the vehicle; rotation is set on drag end via
   * `setRotation` if needed (out of scope for this plan — vehicle
   * keeps its current heading).
   */
  setVehiclePosition(vehicleId: string, position: { x: number; y: number; z: number }): void {
    if (!this.world) return;
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return;
    const body = this.world.getRigidBody(bodyHandle);
    if (!body) return;
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * Re-register a vehicle with a new type's body spec (mass + collider
   * halfExtents). Used by the inspector when the user changes
   * car → bus etc. The body keeps its current position, heading, and
   * linear velocity. The new collider's mass affects the simulation
   * immediately (heavier vehicles decelerate less from the same
   * impulse).
   *
   * Implementation: remove the existing body, then `registerVehicle`
   * again with the new spec. Rapier will create a fresh body at the
   * given position; we then restore the previous linvel.
   */
  updateVehicleType(vehicleId: string, newType: import('@domain/entities/Vehicle').VehicleType): void {
    if (!this.world || !this.R) {
      throw new Error('RapierWorld not initialized — call init() first');
    }
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return;
    const body = this.world.getRigidBody(bodyHandle);
    if (!body) return;
    const pos = body.translation();
    const rot = body.rotation();
    const linvel = body.linvel();
    // Re-derive heading from quaternion (same formula as readPose).
    const heading = Math.atan2(2 * (rot.w * rot.y + rot.x * rot.z), 1 - 2 * (rot.y * rot.y + rot.x * rot.x));
    // Remove old body + collider.
    this.removeVehicle(vehicleId);
    // Build a new spec from RapierBodySpec and re-register.
    // The caller is responsible for updating the entity's type field;
    // here we just need the physical body to match the new type.
    const spec = buildRigidBodySpec(vehicleId, newType, { x: pos.x, y: pos.y, z: pos.z }, heading);
    this.registerVehicle(spec);
    // Restore velocity on the new body.
    this.setVehicleSpeed(vehicleId, Math.hypot(linvel.x, linvel.z), heading);
  }

  step(dt: number): WorldStepResult {
    if (!this.world || !this.eventQueue) {
      return { dt, contactEvents: [], simTime: this.simTime };
    }
    // Clamp dt (I5) — useWorldSimulation 也 clamp, 这里是兜底.
    const clampedDt = Math.min(dt, 1 / 30);
    this.world.timestep = this.cfg.fixedDt;
    this.accumulator += clampedDt;
    // M2-A: 1 step per frame. 多次 step 留 M2-C.
    this.world.step(this.eventQueue);
    this.simTime += this.cfg.fixedDt;
    // Drain contact events
    const events: ContactEvent[] = [];
    this.eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      if (!started) return;
      // h1/h2 是 collider handle. 查 vehicleId.
      const a = this.colliderHandleToVehicleId(h1);
      const b = this.colliderHandleToVehicleId(h2);
      // 跳过 ground vs vehicle 接触 (R1 缓解: 路面是 fixed, 没必要
      // 报 contact). 实施档简化: 全部都报, application 层过滤.
      // 但 ground 没有 colliderHandle 入 map → a/b 都为 null → skip.
      if (a === null || b === null) return;
      events.push({
        colliderA: a,
        colliderB: b,
        normal: { x: 0, y: 0, z: 0 },  // M2-A 不读 normal (M2-B 才用)
        impulse: 0,  // M2-A 简化为存在即触发; 严格 impulse 需要 contact force event queue.
      });
    });
    return { dt: this.cfg.fixedDt, contactEvents: events, simTime: this.simTime };
  }

  readPose(vehicleId: string): { position: Vec3; heading: number; speed: number } | null {
    if (!this.world) return null;
    const bodyHandle = this.bodies.get(vehicleId);
    if (bodyHandle === undefined) return null;
    const body = this.world.getRigidBody(bodyHandle);
    if (!body) return null;
    const t = body.translation();
    const r = body.rotation();
    // Rapier quaternion → heading (yaw).
    // q = (x, y, z, w). yaw = atan2(2*(w*y + x*z), 1 - 2*(y*y + x*x))
    const heading = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
    const lv = body.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    return { position: { x: t.x, y: t.y, z: t.z }, heading, speed };
  }

  castRay(origin: Vec3, dir: Vec3, maxRange: number): RayHit {
    if (!this.world || !this.R) {
      return { point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null };
    }
    const ray = new this.R.Ray(this.toRapierVec3(origin), this.toRapierVec3(dir));
    const hit = this.world.castRay(ray, maxRange, true);
    if (!hit) {
      return { point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null };
    }
    const pt = ray.pointAt(hit.timeOfImpact);
    return {
      point: { x: pt.x, y: pt.y, z: pt.z },
      distance: hit.timeOfImpact,
      colliderHandle: String(hit.collider.handle),
    };
  }

  castRayBatch(
    origins: ReadonlyArray<Vec3>,
    dirs: ReadonlyArray<Vec3>,
    maxRange: number,
  ): ReadonlyArray<RayHit> {
    if (origins.length !== dirs.length) {
      throw new Error(`castRayBatch: origins (${origins.length}) and dirs (${dirs.length}) length mismatch`);
    }
    if (!this.world || !this.R) {
      return origins.map(() => ({ point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null }));
    }
    return origins.map((o, i) => this.castRay(o, dirs[i]!, maxRange));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.world) {
      this.world.free();
      this.world = null;
    }
    this.bodies.clear();
    this.colliders.clear();
    this.colliderHandleToVehicleIdMap.clear();
    this.bodyForCollider.clear();
    this.R = null;
    this.eventQueue = null;
  }

  // --- private helpers ---

  private colliderHandleToVehicleId(h: number): string | null {
    return this.colliderHandleToVehicleIdMap.get(h) ?? null;
  }

  /**
   * Lookup the collider handle for a vehicle. Used by LiDAR
   * excludeColliders (M2-C, plan 017 H4 fix). Returns the handle
   * as a string for contract consistency with `ContactEvent.colliderA/B`
   * (which is string in our domain).
   */
  getColliderHandle(vehicleId: string): string | null {
    const h = this.colliders.get(vehicleId);
    return h !== undefined ? String(h) : null;
  }

  private toRapierVec3(v: Vec3): { x: number; y: number; z: number } {
    return { x: v.x, y: v.y, z: v.z };
  }

  private toRapierQuat(heading: number): { x: number; y: number; z: number; w: number } {
    // Yaw-only quaternion (rotation around Y axis).
    const half = heading / 2;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
  }
}

// Public API (the contract interface from 006 §2).
export interface RapierWorldAPI extends RapierWorld {}

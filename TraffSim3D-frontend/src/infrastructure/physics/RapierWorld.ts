// src/infrastructure/physics/RapierWorld.ts
//
// Rapier3D WASM physics world. Wraps `@dimforge/rapier3d-compat`
// behind the physics contract interface (see the interface contract
// §2). Lazy-imports Rapier to keep the initial bundle small and to
// avoid the dev-server first-load hang (R2).
//
// Rapier 内部用 `Vector` 数字元组 (r3.Vector) 表示 vec3. 我们的
// 公共接口用 `Vec3` (object). 内部到 Rapier 转换在 castRay /
// readPose 边界完成 — see toRapier / fromRapier below.

import type { Vec3, WorldConfig } from './WorldConfig'
import { DEFAULT_WORLD_CONFIG } from './WorldConfig'
import type { RigidBodySpec } from './RapierBodySpec'
import { buildRigidBodySpec } from './RapierBodySpec'
import type { World, EventQueue } from '@dimforge/rapier3d-compat/pipeline'
import {
  MAX_PHYSICS_FRAME_DT,
  MAX_PHYSICS_PENDING_STEPS,
  MAX_PHYSICS_SUB_STEPS,
} from '@shared/constants/simulation'

export interface ContactEvent {
  colliderA: string
  colliderB: string
  normal: Vec3
  impulse: number
}

export interface WorldStepResult {
  /**
   * Simulated time (s) this call actually advanced — `subSteps * fixedDt`.
   *
   * It is **not** the caller's frame dt: a frame that does not carry
   * enough time for a whole fixed sub-step advances 0 s, and a frame that
   * carries two of them advances 2 * fixedDt. Callers that need to know
   * how much simulated time elapsed must read this (or `simTime`), not
   * the frame dt they passed in.
   */
  dt: number
  /** Number of fixed-size physics sub-steps executed by this call. */
  subSteps: number
  contactEvents: ReadonlyArray<ContactEvent>
  /** The physics world's own monotonic sim time (s). */
  simTime: number
  /**
   * Time (s) still sitting in the accumulator — not yet consumed by a
   * sub-step. Always in [0, fixedDt) unless the pending cap kicked in.
   */
  pendingTime: number
}

export interface RayHit {
  point: Vec3 | null
  distance: number
  colliderHandle: string | null
}

export interface VehicleControl {
  throttle: number // 0..1
  brake: number // 0..1
  steering: number // rad/s
}

// Rapier 的 collider handle 是 number. 我们用 vehicleId 作为稳定
// 字符串键,内部维护 Map<vehicleId, colliderHandle>.
type HandleMap = Map<string, number>

/**
 * Slack (s) added to the accumulator before it is divided by `fixedDt`.
 *
 * The accumulator holds a sum of binary floating-point frame dts, so a
 * frame dt that is mathematically a multiple of `fixedDt` can land a
 * fraction of a nanosecond below it. Without this slack such a frame
 * would silently lose a whole sub-step — the simulation would then run
 * measurably slow (1 lost step per 60 = 1.7%). 1e-9 s is far below any
 * physically meaningful time and far above the float noise it absorbs.
 */
const FIXED_DT_EPSILON = 1e-9

/**
 * The vehicle collider's half-height (m) — the distance from a body's
 * centre to its underside.
 *
 * It is read from the spec builder — the one place the body dimensions are
 * derived — instead of being written down a second time here, so the
 * ground cannot drift away from the colliders it has to carry.
 */
const VEHICLE_COLLIDER_HALF_HEIGHT = ((): number => {
  const zero = { x: 0, y: 0, z: 0 }
  const types = ['car', 'truck', 'bus'] as const
  return Math.max(
    ...types.map((type) => buildRigidBodySpec('__ground_probe__', type, zero, 0).halfExtents.y),
  )
})()

export class RapierWorld {
  private R: typeof import('@dimforge/rapier3d-compat') | null = null
  private world: World | null = null
  private eventQueue: EventQueue | null = null
  private bodies: HandleMap = new Map()
  private colliders: HandleMap = new Map()
  private colliderHandleToVehicleIdMap: Map<number, string> = new Map()
  private bodyForCollider: Map<number, number> = new Map() // collider handle → body handle
  private cfg: WorldConfig
  private simTime = 0
  private destroyed = false
  // Accumulator: the wall-clock time that has been handed to `step()`
  // but not yet consumed by a fixed-size physics sub-step. It is
  // **consumed**: `step()` runs `floor(accumulator / fixedDt)` sub-steps
  // and keeps the remainder. That is what makes the simulation speed
  // independent of the render frame rate (see `step()`).
  private accumulator = 0

  constructor(cfg: WorldConfig = DEFAULT_WORLD_CONFIG) {
    this.cfg = cfg
  }

  /** Lazy init. 必须 await 后才能用其它方法. */
  async init(): Promise<void> {
    if (this.world) return
    const mod = await import('@dimforge/rapier3d-compat')
    await mod.init() // wasm 加载
    this.R = mod
    this.world = new mod.World(this.cfg.gravity)
    // Rapier 求解器 seed 不可直接 set; 初始化场景的随机化由 collider
    // 位置保证 (我们都是确定性的位置传进去) — R3 通过"同一位置序列
    // 产出相同位置序列"间接满足.
    this.eventQueue = new mod.EventQueue(true)
    this.buildGround()
  }

  private buildGround(): void {
    if (!this.R || !this.world) return
    // 大地面 cuboid. 1000x1000 足够大覆盖默认 scene.
    //
    // The ground's TOP SURFACE sits one vehicle collider half-height below
    // the road level, so a vehicle body — whose centre the application
    // layer keeps at the road's own y (`tick.ts` → `setVehicleHeight`) —
    // RESTS ON the ground instead of being buried in it.
    //
    // The ground used to have its top surface AT the road level (y = 0),
    // with the vehicle's underside 0.75 m below its centre: every vehicle
    // was embedded 0.75 m into the ground, and the contact solver pushed
    // it back out with a deep-penetration impulse that **torqued** the
    // body. Measured: a car **stopped at a red light** drifted from
    // heading 0 to 0.79 rad (45°) while standing perfectly still; it then
    // drove crooked, tripped the 5 m lane guard, had its speed zeroed and
    // got stuck there.
    //
    // Lowering the ground is the right layer for this fix: the road's
    // height belongs to the application layer (the lane geometry carries
    // it, and the tick writes it onto the body), so the physics ground
    // only has to sit *below* the road — exactly one collider half-height,
    // so the body rests on it with its centre on the road.
    const groundTopY = -VEHICLE_COLLIDER_HALF_HEIGHT
    const groundDesc = this.R.RigidBodyDesc.fixed().setTranslation(
      0,
      groundTopY - this.cfg.groundThickness,
      0,
    )
    const body = this.world.createRigidBody(groundDesc)
    // GROUND FRICTION IS ZERO — and that is deliberate.
    //
    // This simulator drives the vehicles by **setting** their velocity
    // (`applyControl` → `setLinvel`); the longitudinal dynamics live in
    // the application layer (the acceleration ramp, the car-following
    // model, the traffic-light constraint). A friction force from the
    // road is a *second*, competing longitudinal model — and it wins in
    // the one case that matters: starting from rest.
    //
    // Measured: with the ground at friction 0.8, a vehicle that ramped
    // up from 0 travelled 0.4 mm in a 1/60 s step, which the contact
    // solver absorbed entirely. The speed the step ended with was
    // ~0.000 m/s, the next frame ramped from ~0 again, and the vehicle
    // never moved — measured across 6 vehicles: `s` frozen, speed
    // oscillating 0.012 → 0.024 → 0.000 m/s. The ground's friction was
    // pinning the traffic in place.
    //
    // The friction **combine rule** matters as much as the coefficient.
    // Rapier combines two colliders' coefficients with `Average` by
    // default, so a ground of 0 against a vehicle of 0.5 still yields
    // 0.25 — enough to hold a starting vehicle in place. The ground
    // therefore uses `Min`, which makes the vehicle-road contact
    // frictionless (min(0, 0.5) = 0) while leaving **vehicle-to-vehicle**
    // contacts at the average of two 0.5s, i.e. unchanged: a collision
    // between two cars still behaves like one.
    const colliderDesc = this.R.ColliderDesc.cuboid(500, this.cfg.groundThickness, 500)
      .setFriction(0)
      .setFrictionCombineRule(this.R.CoefficientCombineRule.Min)
      .setRestitution(0.0)
    this.world.createCollider(colliderDesc, body)
    // ground 不入 body map — readPose 不会问到.
  }

  registerVehicle(spec: RigidBodySpec): string {
    if (this.destroyed) throw new Error('RapierWorld already destroyed')
    if (!this.R || !this.world) throw new Error('RapierWorld not initialized — call init() first')
    // 幂等: 已存在则更新位置/heading, 不创建新 body.
    const existing = this.bodies.get(spec.vehicleId)
    if (existing !== undefined) {
      const body = this.world.getRigidBody(existing)
      if (body) {
        body.setTranslation(this.toRapierVec3(spec.position), true)
        body.setRotation(this.toRapierQuat(spec.heading), true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        return spec.vehicleId
      }
    }
    // DAMPING IS ZERO — and that is deliberate, for the same reason the
    // ground's friction is zero (see `buildGround`).
    //
    // The longitudinal dynamics live in the application layer: the speed
    // ramp (`rampSpeed`) adds `accel · dt` per step and the traffic-light /
    // car-following constraints decide what the ramp aims at. The physics
    // body's job is to carry that speed (mass, footprint, contacts,
    // turning radius) — not to re-derive it.
    //
    // A damping coefficient is a **second longitudinal model**: Rapier
    // multiplies the linear velocity by `1 / (1 + damping · dt)` on every
    // sub-step, so the speed the body actually integrates is not the speed
    // the application layer commanded. The two fight, and the damping
    // wins, because it is applied to the velocity *after* the command:
    //
    //     v_next = (v + accel·dt) / (1 + damping·dt)
    //     ⇒  v*   = accel / damping        (the equilibrium)
    //
    // With the old `linearDamping = 0.2` that equilibrium was **10.0 m/s
    // for a car, 7.0 for a truck, 6.0 for a bus** — a hard speed ceiling
    // that the application layer never asked for, and that the
    // physics-free fallback path does not have (it reaches the road's
    // 16.67 m/s limit). Measured on the cross scene: the physics path
    // topped out at 9.84 / 6.98 / 6.00 m/s while the fallback reached
    // 16.67 — the physics path covered ~50 % of the distance the
    // application model asked for.
    //
    // `angularDamping = 0.4` had the same effect on the turn rate: the
    // body rotated at 99.34 % of the angular velocity Pure Pursuit
    // commanded. It is zero for the same reason — the steering law owns
    // the heading, the physics owns the inertia.
    //
    // The one consequence of a zero angular damping is that a body with
    // no steering command keeps the angular velocity it had. That is
    // handled where the standstill is decided (`applyControl` zeroes the
    // angular velocity of a body that is commanded to a stop), not by
    // letting the damping silently slow the vehicle down.
    const bodyDesc = this.R.RigidBodyDesc.dynamic()
      .setTranslation(spec.position.x, spec.position.y, spec.position.z)
      .setRotation(this.toRapierQuat(spec.heading))
      .setLinearDamping(0)
      .setAngularDamping(0)
    const body = this.world.createRigidBody(bodyDesc)
    const colliderDesc = this.R.ColliderDesc.cuboid(
      spec.halfExtents.x,
      spec.halfExtents.y,
      spec.halfExtents.z,
    )
      .setMass(spec.mass)
      .setFriction(0.5)
      .setRestitution(0.2)
    const collider = this.world.createCollider(colliderDesc, body)
    const bodyHandle = body.handle
    const colliderHandle = collider.handle
    this.bodies.set(spec.vehicleId, bodyHandle)
    this.colliders.set(spec.vehicleId, colliderHandle)
    this.colliderHandleToVehicleIdMap.set(colliderHandle, spec.vehicleId)
    this.bodyForCollider.set(colliderHandle, bodyHandle)
    return spec.vehicleId
  }

  removeVehicle(vehicleId: string): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (body) {
      this.world.removeRigidBody(body)
    }
    this.bodies.delete(vehicleId)
    const colliderHandle = this.colliders.get(vehicleId)
    this.colliders.delete(vehicleId)
    if (colliderHandle !== undefined) {
      this.colliderHandleToVehicleIdMap.delete(colliderHandle)
    }
    // bodyForCollider 由 Rapier 的 handle 空间回收 — 不用手清.
  }

  /** Per-vehicle control input. Rapier 用 setLinvel 简化 (暂不做
   *  力模型; 引入转向时再升级到 applyImpulse).
   *
   *  - throttle=1, brake=0 → targetSpeed 方向 setLinvel
   *  - brake=1 → setLinvel(0)
   *  - crashed vehicle → applyControl 收到 status='crashed' 时
   *    throttle=0, brake=1 (caller 负责)
   *
   *  这里 throttle/brake 直接由 caller 算好 targetSpeed 后转
   *  linvel; caller 不需要知道力学. 实施档简化: 我们把
   *  targetSpeed 当作 "想要的速度", 直接 setLinvel. 物理上不
   *  是"力推进" — 是"速度设置" — 但接受该取舍. */
  applyControl(
    vehicleId: string,
    control: VehicleControl,
    targetSpeed: number,
    heading: number,
  ): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    let v = 0
    if (control.brake >= 0.99) {
      v = 0
    } else if (control.throttle > 0) {
      v = Math.max(0, targetSpeed)
    } else {
      const lv = body.linvel()
      v = lv.x !== 0 || lv.z !== 0 ? Math.hypot(lv.x, lv.z) : 0
    }
    // A body that is commanded to a standstill also stops turning.
    //
    // The bodies carry no angular damping (see `registerVehicle`), so a
    // body that kept an angular velocity would keep rotating forever.
    // The steering loop only writes an angular velocity to a *moving*
    // vehicle (`tick.ts` skips a vehicle slower than 0.5 m/s), so a
    // vehicle that comes to a stop — at a red light, behind a leader —
    // would otherwise keep the turn rate it had when it stopped and
    // rotate on the spot.
    //
    // Zeroing it here (rather than in the damping) keeps the standstill
    // a decision of the application layer, which is the layer that
    // commanded the stop in the first place.
    if (v === 0) {
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
    // heading 是 world-space (lane forward). 投影到 Rapier 2D.
    const vx = v * Math.cos(heading)
    const vz = v * Math.sin(heading)
    body.setLinvel({ x: vx, y: 0, z: vz }, true)
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
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    const v = Math.max(0, speed)
    const vx = v * Math.cos(heading)
    const vz = v * Math.sin(heading)
    body.setLinvel({ x: vx, y: 0, z: vz }, true)
  }

  /**
   * Apply a lateral (perpendicular-to-current-linvel) velocity
   * nudge to a vehicle body. Used during lane-change to slide the body
   * sideways without disturbing forward motion. The caller combines
   * this with the longitudinal linvel that `applyControl` already set
   * for this tick.
   *
   * `lateralMs` is signed: positive = vehicle's left (in world XZ
   * relative to current linvel direction), negative = right. Magnitude
   * is capped by the caller (tick.ts passes clamp(±MAX_LATERAL_MS)).
   *
   * If the body is currently stationary (no linvel), this method is
   * a no-op — there's no forward direction to be perpendicular to.
   * The lane-change controller skips such vehicles (its decision
   * requires `MIN_LANE_CHANGE_SPEED`).
   */
  setVehicleLateralVelocity(vehicleId: string, lateralMs: number): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    const lv = body.linvel()
    const speed = Math.hypot(lv.x, lv.z)
    if (speed < 0.01) return // no forward dir → can't compute perp
    const dirX = lv.x / speed
    const dirZ = lv.z / speed
    // Perpendicular in XZ (rotate 90° CCW): (-dirZ, dirX)
    const perpX = -dirZ
    const perpZ = dirX
    body.setLinvel({ x: lv.x + perpX * lateralMs, y: 0, z: lv.z + perpZ * lateralMs }, true)
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
   * `setRotation` if needed (out of scope for now — vehicle
   * keeps its current heading).
   */
  setVehiclePosition(vehicleId: string, position: { x: number; y: number; z: number }): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true)
    body.setLinvel({ x: 0, y: 0, z: 0 }, true)
  }

  /**
   * Move a body to a given **height**, keeping its horizontal position
   * and its velocity.
   *
   * The physics world has a flat ground and **no geometry for the
   * elevated roads** — a ramp or a viaduct is a polyline in the scene
   * graph, not a collider. A vehicle driving on one therefore sinks to
   * the ground plane, and the pose it reads back carries that height.
   *
   * The height of a road is known exactly (the lane geometry carries
   * it), so the application layer owns it: it tells the body which
   * height the road it is driving on is at. Only `y` changes — the
   * horizontal motion and the velocity stay untouched, so this cannot
   * disturb the vehicle's speed.
   */
  setVehicleHeight(vehicleId: string, y: number): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    const t = body.translation()
    body.setTranslation({ x: t.x, y, z: t.z }, true)
  }

  /**
   * Set a vehicle's heading (yaw) without changing position or velocity.
   * Used by OOB cleanup to re-orient the body after a respawn so that
   * the next applyControl sends the vehicle in the correct direction.
   */
  setVehicleHeading(vehicleId: string, heading: number): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    body.setRotation(this.toRapierQuat(heading), true)
    body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  /**
   * Directly set a rigid body's angular velocity around the
   * Y-axis (in world-space). Used by the Pure Pursuit steering loop
   * to turn the vehicle toward the lookahead point.
   *
   * @param omega  Angular velocity (rad/s):
   *               positive → counter-clockwise (left turn in XZ)
   *               negative → clockwise (right turn in XZ)
   *               0 → straight ahead (or coast)
   *
   * The body carries **no angular damping** (see `registerVehicle`), so
   * this value is the turn rate the body actually holds until the next
   * command. A vehicle that stops is stopped from turning by
   * `applyControl`, which zeroes the angular velocity of a body that is
   * commanded to a standstill.
   */
  setVehicleAngularVelocity(vehicleId: string, omega: number): void {
    if (!this.world) return
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    body.setAngvel({ x: 0, y: omega, z: 0 }, true)
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
  updateVehicleType(
    vehicleId: string,
    newType: import('@domain/entities/Vehicle').VehicleType,
  ): void {
    if (!this.world || !this.R) {
      throw new Error('RapierWorld not initialized — call init() first')
    }
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return
    const pos = body.translation()
    const rot = body.rotation()
    const linvel = body.linvel()
    // Re-derive heading from quaternion (same formula as readPose).
    const heading = Math.atan2(
      2 * (rot.w * rot.y + rot.x * rot.z),
      1 - 2 * (rot.y * rot.y + rot.x * rot.x),
    )
    // Remove old body + collider.
    this.removeVehicle(vehicleId)
    // Build a new spec from RapierBodySpec and re-register.
    // The caller is responsible for updating the entity's type field;
    // here we just need the physical body to match the new type.
    const spec = buildRigidBodySpec(vehicleId, newType, { x: pos.x, y: pos.y, z: pos.z }, heading)
    this.registerVehicle(spec)
    // Restore velocity on the new body.
    this.setVehicleSpeed(vehicleId, Math.hypot(linvel.x, linvel.z), heading)
  }

  step(dt: number): WorldStepResult {
    if (!this.world || !this.eventQueue) {
      return {
        dt,
        subSteps: 0,
        contactEvents: [],
        simTime: this.simTime,
        pendingTime: this.accumulator,
      }
    }
    // Clamp the frame dt — a tab switch or a GC pause must not hand the
    // physics a multi-second jump. The sub-step size (fixedDt) is what
    // bounds the integration error, not this clamp.
    const clampedDt = Math.min(Math.max(dt, 0), MAX_PHYSICS_FRAME_DT)
    this.accumulator += clampedDt
    // The epsilon keeps a frame dt that lands a hair below a multiple of
    // fixedDt (floating point) from silently losing a whole sub-step.
    const rawSteps = Math.floor((this.accumulator + FIXED_DT_EPSILON) / this.cfg.fixedDt)
    const subSteps = Math.max(0, Math.min(rawSteps, MAX_PHYSICS_SUB_STEPS))
    this.accumulator -= subSteps * this.cfg.fixedDt
    if (this.accumulator < 0) this.accumulator = 0
    const maxPending = MAX_PHYSICS_PENDING_STEPS * this.cfg.fixedDt
    if (this.accumulator > maxPending) this.accumulator = maxPending

    this.world.timestep = this.cfg.fixedDt
    for (let i = 0; i < subSteps; i++) {
      this.world.step(this.eventQueue)
    }
    const advanced = subSteps * this.cfg.fixedDt
    this.simTime += advanced
    // Drain contact events
    const events: ContactEvent[] = []
    this.eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      if (!started) return
      // h1/h2 是 collider handle. 查 vehicleId.
      const a = this.colliderHandleToVehicleId(h1)
      const b = this.colliderHandleToVehicleId(h2)
      // 跳过 ground vs vehicle 接触 (R1 缓解: 路面是 fixed, 没必要
      // 报 contact). 实施档简化: 全部都报, application 层过滤.
      // 但 ground 没有 colliderHandle 入 map → a/b 都为 null → skip.
      if (a === null || b === null) return
      events.push({
        colliderA: a,
        colliderB: b,
        normal: { x: 0, y: 0, z: 0 }, // 当前不读 normal (后续接触处理才用)
        impulse: 0, // 简化为存在即触发; 严格 impulse 需要 contact force event queue.
      })
    })
    return {
      dt: advanced,
      subSteps,
      contactEvents: events,
      simTime: this.simTime,
      pendingTime: this.accumulator,
    }
  }

  readPose(vehicleId: string): { position: Vec3; heading: number; speed: number } | null {
    if (!this.world) return null
    const bodyHandle = this.bodies.get(vehicleId)
    if (bodyHandle === undefined) return null
    const body = this.world.getRigidBody(bodyHandle)
    if (!body) return null
    const t = body.translation()
    const r = body.rotation()
    // Rapier quaternion → heading (yaw).
    // q = (x, y, z, w). yaw = atan2(2*(w*y + x*z), 1 - 2*(y*y + x*x))
    const heading = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x))
    const lv = body.linvel()
    const speed = Math.hypot(lv.x, lv.z)
    return { position: { x: t.x, y: t.y, z: t.z }, heading, speed }
  }

  castRay(origin: Vec3, dir: Vec3, maxRange: number): RayHit {
    if (!this.world || !this.R) {
      return { point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null }
    }
    const ray = new this.R.Ray(this.toRapierVec3(origin), this.toRapierVec3(dir))
    const hit = this.world.castRay(ray, maxRange, true)
    if (!hit) {
      return { point: null, distance: Number.POSITIVE_INFINITY, colliderHandle: null }
    }
    const pt = ray.pointAt(hit.timeOfImpact)
    return {
      point: { x: pt.x, y: pt.y, z: pt.z },
      distance: hit.timeOfImpact,
      colliderHandle: String(hit.collider.handle),
    }
  }

  castRayBatch(
    origins: ReadonlyArray<Vec3>,
    dirs: ReadonlyArray<Vec3>,
    maxRange: number,
  ): ReadonlyArray<RayHit> {
    if (origins.length !== dirs.length) {
      throw new Error(
        `castRayBatch: origins (${origins.length}) and dirs (${dirs.length}) length mismatch`,
      )
    }
    if (!this.world || !this.R) {
      return origins.map(() => ({
        point: null,
        distance: Number.POSITIVE_INFINITY,
        colliderHandle: null,
      }))
    }
    return origins.map((o, i) => this.castRay(o, dirs[i]!, maxRange))
  }

  destroy(): void {
    this.destroyed = true
    if (this.world) {
      this.world.free()
      this.world = null
    }
    this.bodies.clear()
    this.colliders.clear()
    this.colliderHandleToVehicleIdMap.clear()
    this.bodyForCollider.clear()
    this.R = null
    this.eventQueue = null
  }

  // --- private helpers ---

  private colliderHandleToVehicleId(h: number): string | null {
    return this.colliderHandleToVehicleIdMap.get(h) ?? null
  }

  /**
   * Lookup the collider handle for a vehicle. Used by LiDAR
   * excludeColliders (the LiDAR fix). Returns the handle
   * as a string for contract consistency with `ContactEvent.colliderA/B`
   * (which is string in our domain).
   */
  getColliderHandle(vehicleId: string): string | null {
    const h = this.colliders.get(vehicleId)
    return h !== undefined ? String(h) : null
  }

  private toRapierVec3(v: Vec3): { x: number; y: number; z: number } {
    return { x: v.x, y: v.y, z: v.z }
  }

  private toRapierQuat(heading: number): { x: number; y: number; z: number; w: number } {
    // Yaw-only quaternion (rotation around Y axis).
    const half = heading / 2
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
  }
}

// Public API (the physics contract interface).
export interface RapierWorldAPI extends RapierWorld {}

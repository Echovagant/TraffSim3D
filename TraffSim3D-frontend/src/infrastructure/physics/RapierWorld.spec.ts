// src/infrastructure/physics/RapierWorld.spec.ts
//
// RapierWorld lazy-imports `@dimforge/rapier3d-compat` inside init().
// `tests/setup.ts` already stubs that module with a no-op; this spec
// re-registers a *behavioural* fake (chainable descriptors + a
// handle-allocating world) so the wrapper's own logic is observable:
//
//   - which descriptor it builds (fixed ground vs dynamic vehicle)
//   - the exact collider numbers it derives (halfExtents, mass, friction,
//     restitution) and the damping it asks Rapier for
//   - the applyControl / setVehicle* velocity + quaternion math
//   - the dt clamp, the simTime accumulator, and the contact-event mapping
//
// The fake's *solver* is intentionally absent — nothing here asserts on
// Rapier's integration, only on RapierWorld's decisions.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Vec = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

interface FakeBody {
  handle: number;
  desc: any;
  _t: Vec;
  _r: Quat;
  _lv: Vec;
  _av: Vec;
  removed: boolean;
  translation(): Vec;
  rotation(): Quat;
  linvel(): Vec;
  angvel(): Vec;
  setTranslation(t: Vec, wake: boolean): void;
  setRotation(q: Quat, wake: boolean): void;
  setLinvel(v: Vec, wake: boolean): void;
  setAngvel(v: Vec, wake: boolean): void;
  setEnabled(w: boolean): void;
}

// Hoisted so the vi.mock factory (also hoisted) can reference it safely.
const R = vi.hoisted(() => {
  const state = {
    /** live rigid bodies by handle */
    bodies: new Map<number, FakeBody>(),
    /** collider descriptors in creation order */
    colliders: [] as any[],
    nextHandle: 0,
    /** gravity handed to the FakeWorld constructor */
    gravity: null as Vec | null,
    /** FakeWorld.timestep after the last step() */
    timestep: 0,
    stepCalls: 0,
    freed: false,
    /** autoDrain flag passed to EventQueue */
    eventQueueAutoDrain: null as boolean | null,
    /** queued castRay results, consumed in order */
    rayResults: [] as Array<any>,
    /** drained by drainCollisionEvents: [h1, h2, started] */
    collisionEvents: [] as Array<[number, number, boolean]>,
    /** last Ray constructed, so we can assert origin/dir conversion */
    lastRay: null as { origin: Vec; dir: Vec } | null,
    worldCount: 0,
  };

  const makeBodyDesc = (kind: string) => {
    const rec: any = {
      kind,
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linDamping: null as number | null,
      angDamping: null as number | null,
    };
    rec.setTranslation = (x: number, y: number, z: number) => {
      rec.translation = { x, y, z };
      return rec;
    };
    rec.setRotation = (q: Quat) => {
      rec.rotation = q;
      return rec;
    };
    rec.setLinearDamping = (v: number) => {
      rec.linDamping = v;
      return rec;
    };
    rec.setAngularDamping = (v: number) => {
      rec.angDamping = v;
      return rec;
    };
    return rec;
  };

  const makeColliderDesc = (hx: number, hy: number, hz: number) => {
    const rec: any = {
      halfExtents: { x: hx, y: hy, z: hz },
      mass: null as number | null,
      friction: null as number | null,
      restitution: null as number | null,
    };
    rec.setMass = (v: number) => {
      rec.mass = v;
      return rec;
    };
    rec.setFriction = (v: number) => {
      rec.friction = v;
      return rec;
    };
    rec.setRestitution = (v: number) => {
      rec.restitution = v;
      return rec;
    };
    return rec;
  };

  class FakeWorld {
    timestep = 0;
    constructor(gravity: Vec) {
      state.worldCount += 1;
      state.gravity = gravity;
    }
    createRigidBody(desc: any): FakeBody {
      const handle = state.nextHandle++;
      const body: any = {
        handle,
        desc,
        _t: { ...desc.translation },
        _r: { ...desc.rotation },
        _lv: { x: 0, y: 0, z: 0 },
        _av: { x: 0, y: 0, z: 0 },
        removed: false,
        translation() {
          return { ...this._t };
        },
        rotation() {
          return { ...this._r };
        },
        linvel() {
          return { ...this._lv };
        },
        angvel() {
          return { ...this._av };
        },
        setTranslation(t: Vec, _wake: boolean) {
          this._t = { x: t.x, y: t.y, z: t.z };
        },
        setRotation(q: Quat, _wake: boolean) {
          this._r = { x: q.x, y: q.y, z: q.z, w: q.w };
        },
        setLinvel(v: Vec, _wake: boolean) {
          this._lv = { x: v.x, y: v.y, z: v.z };
        },
        setAngvel(v: Vec, _wake: boolean) {
          this._av = { x: v.x, y: v.y, z: v.z };
        },
      };
      state.bodies.set(handle, body);
      return body;
    }
    createCollider(desc: any, _body: FakeBody) {
      const handle = 1000 + state.colliders.length;
      const rec = { handle, desc };
      state.colliders.push(rec);
      return rec;
    }
    getRigidBody(handle: number): FakeBody | null {
      const b = state.bodies.get(handle);
      return b && !b.removed ? b : null;
    }
    removeRigidBody(body: FakeBody) {
      body.removed = true;
      state.bodies.delete(body.handle);
    }
    step(_eq: unknown) {
      state.stepCalls += 1;
      state.timestep = this.timestep;
    }
    castRay(_ray: unknown, _maxRange: number, _solid: boolean) {
      return state.rayResults.length > 0 ? state.rayResults.shift() : undefined;
    }
    free() {
      state.freed = true;
    }
  }

  class FakeEventQueue {
    constructor(autoDrain: boolean) {
      state.eventQueueAutoDrain = autoDrain;
    }
    drainCollisionEvents(cb: (h1: number, h2: number, started: boolean) => void) {
      for (const [h1, h2, started] of state.collisionEvents) cb(h1, h2, started);
    }
  }

  class FakeRay {
    origin: Vec;
    dir: Vec;
    constructor(origin: Vec, dir: Vec) {
      this.origin = origin;
      this.dir = dir;
      state.lastRay = { origin, dir };
    }
    pointAt(t: number): Vec {
      return {
        x: this.origin.x + this.dir.x * t,
        y: this.origin.y + this.dir.y * t,
        z: this.origin.z + this.dir.z * t,
      };
    }
  }

  return { state, makeBodyDesc, makeColliderDesc, FakeWorld, FakeEventQueue, FakeRay };
});

vi.mock('@dimforge/rapier3d-compat', () => ({
  default: {},
  init: vi.fn().mockResolvedValue(undefined),
  World: R.FakeWorld,
  EventQueue: R.FakeEventQueue,
  RigidBodyDesc: {
    dynamic: () => R.makeBodyDesc('dynamic'),
    fixed: () => R.makeBodyDesc('fixed'),
  },
  ColliderDesc: { cuboid: R.makeColliderDesc },
  Ray: R.FakeRay,
}));

const { RapierWorld } = await import('./RapierWorld');
const { buildRigidBodySpec } = await import('./RapierBodySpec');
const { DEFAULT_WORLD_CONFIG } = await import('./WorldConfig');

type Spec = ReturnType<typeof buildRigidBodySpec>;

/** The single fixed ground body created by init(). */
const groundBody = () => [...R.state.bodies.values()][0]!;
const vehicleBodies = () =>
  [...R.state.bodies.values()].filter((b) => b.desc.kind === 'dynamic');
const groundColliderDesc = () => R.state.colliders[0]!.desc;
const vehicleColliderDescs = () => R.state.colliders.slice(1).map((c) => c.desc);

const spec = (over: Partial<Spec> = {}): Spec => ({
  ...buildRigidBodySpec('v-1', 'car', { x: 0, y: 0, z: 0 }, 0),
  ...over,
});

/** Build a spec straight from the builder — use this whenever the *type*
 *  must change the derived mass/halfExtents (spreading a spec keeps the
 *  numbers the builder already computed for the original type). */
const bodySpec = (
  vehicleId: string,
  type: 'car' | 'truck' | 'bus',
  position: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  heading = 0,
): Spec => buildRigidBodySpec(vehicleId, type, position, heading);

beforeEach(() => {
  R.state.bodies.clear();
  R.state.colliders.length = 0;
  R.state.nextHandle = 0;
  R.state.gravity = null;
  R.state.timestep = 0;
  R.state.stepCalls = 0;
  R.state.freed = false;
  R.state.eventQueueAutoDrain = null;
  R.state.rayResults.length = 0;
  R.state.collisionEvents.length = 0;
  R.state.lastRay = null;
  R.state.worldCount = 0;
});

// ---------------------------------------------------------------------------
// 1. Pre-init guard paths — every one of these runs with no WASM world at all.
// ---------------------------------------------------------------------------

describe('RapierWorld — before init()', () => {
  it('registerVehicle throws "not initialized" naming init()', () => {
    const w = new RapierWorld();
    expect(() => w.registerVehicle(spec())).toThrowError(
      /RapierWorld not initialized — call init\(\) first/,
    );
  });

  it('updateVehicleType throws "not initialized" (it needs R to rebuild the collider)', () => {
    const w = new RapierWorld();
    expect(() => w.updateVehicleType('v-1', 'bus')).toThrowError(
      /RapierWorld not initialized — call init\(\) first/,
    );
  });

  it('castRay returns a null hit at +Infinity distance', () => {
    const w = new RapierWorld();
    expect(w.castRay({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100)).toEqual({
      point: null,
      distance: Number.POSITIVE_INFINITY,
      colliderHandle: null,
    });
  });

  it('castRayBatch returns one null hit per origin (preserving count)', () => {
    const w = new RapierWorld();
    const hits = w.castRayBatch(
      [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 1 },
        { x: 2, y: 0, z: 2 },
      ],
      [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 1, z: 0 },
      ],
      50,
    );
    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(h.point).toBeNull();
      expect(h.colliderHandle).toBeNull();
      expect(h.distance).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('castRayBatch throws on an origins/dirs length mismatch, naming both counts', () => {
    const w = new RapierWorld();
    expect(() =>
      w.castRayBatch(
        [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
        [{ x: 1, y: 0, z: 0 }],
        10,
      ),
    ).toThrowError('castRayBatch: origins (2) and dirs (1) length mismatch');
  });

  it('step returns the caller dt UNCLAMPED and does not advance simTime', () => {
    const w = new RapierWorld();
    const res = w.step(0.25);
    expect(res.dt).toBe(0.25);
    expect(res.contactEvents).toEqual([]);
    expect(res.simTime).toBe(0);
  });

  it('readPose returns null', () => {
    expect(new RapierWorld().readPose('v-1')).toBeNull();
  });

  it('getColliderHandle returns null for an unknown vehicle', () => {
    expect(new RapierWorld().getColliderHandle('nope')).toBeNull();
  });

  it('every mutator is a silent no-op (no throw, no body created)', () => {
    const w = new RapierWorld();
    expect(() => {
      w.removeVehicle('v-1');
      w.applyControl('v-1', { throttle: 1, brake: 0, steering: 0 }, 20, 0);
      w.setVehicleSpeed('v-1', 10, 0);
      w.setVehicleLateralVelocity('v-1', 2);
      w.setVehiclePosition('v-1', { x: 1, y: 0, z: 1 });
      w.setVehicleHeading('v-1', 1);
      w.setVehicleAngularVelocity('v-1', 0.5);
    }).not.toThrow();
    expect(R.state.bodies.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. init() — the world + ground body
// ---------------------------------------------------------------------------

describe('RapierWorld — init()', () => {
  it('builds exactly one fixed ground body at y = -groundThickness', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(R.state.worldCount).toBe(1);
    expect(vehicleBodies()).toHaveLength(0);
    const g = groundBody();
    expect(g.desc.kind).toBe('fixed');
    expect(g.desc.translation).toEqual({ x: 0, y: -DEFAULT_WORLD_CONFIG.groundThickness, z: 0 });
  });

  it('ground collider is a 500 x thickness x 500 cuboid, friction 0.8, restitution 0', async () => {
    const w = new RapierWorld();
    await w.init();
    const d = groundColliderDesc();
    expect(d.halfExtents).toEqual({ x: 500, y: DEFAULT_WORLD_CONFIG.groundThickness, z: 500 });
    expect(d.friction).toBe(0.8);
    expect(d.restitution).toBe(0.0);
    // Ground gets no explicit mass — Rapier derives it from the cuboid volume.
    expect(d.mass).toBeNull();
  });

  it('passes the config gravity to the Rapier world verbatim', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(R.state.gravity).toEqual(DEFAULT_WORLD_CONFIG.gravity);
  });

  it('creates an auto-draining EventQueue', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(R.state.eventQueueAutoDrain).toBe(true);
  });

  it('is idempotent: a second init() neither rebuilds the world nor duplicates the ground', async () => {
    const w = new RapierWorld();
    await w.init();
    await w.init();
    expect(R.state.worldCount).toBe(1);
    expect(R.state.bodies.size).toBe(1);
  });

  it('honours a custom config (gravity + groundThickness drive the ground build)', async () => {
    const w = new RapierWorld({
      seed: 1,
      fixedDt: 1 / 120,
      gravity: { x: 0, y: -1.62, z: 0 },
      groundThickness: 2.5,
    });
    await w.init();
    expect(R.state.gravity).toEqual({ x: 0, y: -1.62, z: 0 });
    expect(groundBody().desc.translation).toEqual({ x: 0, y: -2.5, z: 0 });
    expect(groundColliderDesc().halfExtents.y).toBe(2.5);
  });

  it('after destroy(), registerVehicle throws "already destroyed" (destroy wins over uninitialized)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.destroy();
    expect(() => w.registerVehicle(spec())).toThrowError('RapierWorld already destroyed');
  });

  it('a fresh instance after one is destroyed can init() again', async () => {
    const a = new RapierWorld();
    await a.init();
    a.destroy();
    const b = new RapierWorld();
    await expect(b.init()).resolves.toBeUndefined();
    expect(() => b.registerVehicle(spec())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. registerVehicle — descriptor + collider derivation
// ---------------------------------------------------------------------------

describe('RapierWorld — registerVehicle', () => {
  it('returns the vehicleId and derives a string collider handle', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(w.registerVehicle(spec({ vehicleId: 'v-42' }))).toBe('v-42');
    const h = w.getColliderHandle('v-42');
    expect(typeof h).toBe('string');
    expect(Number(h)).toBe(R.state.colliders[1]!.handle);
  });

  it('car: dynamic body, damping 0.2 / 0.4, collider (2.1, 0.75, 0.9) mass 1500 μ=0.5 e=0.2', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ type: 'car' }));
    const b = vehicleBodies()[0]!;
    expect(b.desc.kind).toBe('dynamic');
    expect(b.desc.linDamping).toBe(0.2);
    expect(b.desc.angDamping).toBe(0.4);
    const d = vehicleColliderDescs()[0]!;
    expect(d.halfExtents.x).toBeCloseTo(2.1, 10);
    expect(d.halfExtents.y).toBe(0.75);
    expect(d.halfExtents.z).toBeCloseTo(0.9, 10);
    expect(d.mass).toBe(1500);
    expect(d.friction).toBe(0.5);
    expect(d.restitution).toBe(0.2);
  });

  it('bus: collider halfExtents (4.5, 0.75, 1.25) with mass 8000', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(bodySpec('v-1', 'bus'));
    const d = vehicleColliderDescs()[0]!;
    expect(d.halfExtents.x).toBeCloseTo(4.5, 10);
    expect(d.halfExtents.z).toBeCloseTo(1.25, 10);
    expect(d.mass).toBe(8000);
  });

  it('truck: collider halfExtents (3.25, 0.75, 1.1) with mass 4500', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(bodySpec('v-1', 'truck'));
    const d = vehicleColliderDescs()[0]!;
    expect(d.halfExtents.x).toBeCloseTo(3.25, 10);
    expect(d.halfExtents.z).toBeCloseTo(1.1, 10);
    expect(d.mass).toBe(4500);
  });

  it('registers the spec numbers verbatim — it does NOT re-derive mass/halfExtents from spec.type', async () => {
    // The builder is the only place type → numbers happens. registerVehicle
    // trusts RigidBodySpec as given, so a caller that mutates `type` on an
    // already-built spec gets the OLD collider. (updateVehicleType is the
    // supported way to change a type in place.)
    const w = new RapierWorld();
    await w.init();
    const mutated: Spec = { ...buildRigidBodySpec('v-1', 'car', { x: 0, y: 0, z: 0 }, 0), type: 'bus' };
    w.registerVehicle(mutated);
    const d = vehicleColliderDescs()[0]!;
    expect(d.mass).toBe(1500); // car mass, not bus 8000
    expect(d.halfExtents.x).toBeCloseTo(2.1, 10); // car half-length, not bus 4.5
  });

  it('seeds the body position and yaw-only rotation from the spec', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ position: { x: 3, y: 0.5, z: -9 }, heading: Math.PI / 2 }));
    const b = vehicleBodies()[0]!;
    expect(b.translation()).toEqual({ x: 3, y: 0.5, z: -9 });
    // yaw-only quat: x = z = 0, y = sin(h/2), w = cos(h/2)
    const q = b.rotation();
    expect(q.x).toBe(0);
    expect(q.z).toBe(0);
    expect(q.y).toBeCloseTo(Math.sin(Math.PI / 4), 12);
    expect(q.w).toBeCloseTo(Math.cos(Math.PI / 4), 12);
  });

  it('readPose round-trips heading through the quaternion for a full turn', async () => {
    const w = new RapierWorld();
    await w.init();
    for (const h of [0, Math.PI / 4, Math.PI / 2, Math.PI, -2.5]) {
      w.registerVehicle(spec({ vehicleId: `v-h${h}`, heading: h }));
      const pose = w.readPose(`v-h${h}`)!;
      expect(pose.heading).toBeCloseTo(h, 10);
      expect(pose.speed).toBe(0);
    }
  });

  it('re-registering the same id is idempotent: updates in place, creates no second body', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1', position: { x: 0, y: 0, z: 0 } }));
    w.applyControl('v-1', { throttle: 1, brake: 0, steering: 0 }, 12, 0);
    const handleBefore = w.getColliderHandle('v-1');

    w.registerVehicle(spec({ vehicleId: 'v-1', position: { x: 50, y: 1, z: -50 }, heading: 1 }));
    expect(vehicleBodies()).toHaveLength(1);
    expect(w.getColliderHandle('v-1')).toBe(handleBefore);
    const pose = w.readPose('v-1')!;
    expect(pose.position).toEqual({ x: 50, y: 1, z: -50 });
    expect(pose.heading).toBeCloseTo(1, 10);
    // the re-register path also zeroes linvel
    expect(pose.speed).toBe(0);
  });

  it('re-registers (self-heals) when Rapier no longer knows the cached body handle', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1' }));
    const stale = vehicleBodies()[0]!;
    // Simulate Rapier reclaiming the handle without going through removeVehicle.
    R.state.bodies.delete(stale.handle);

    w.registerVehicle(spec({ vehicleId: 'v-1', position: { x: 4, y: 0, z: 4 } }));
    expect(vehicleBodies()).toHaveLength(1);
    expect(w.readPose('v-1')!.position).toEqual({ x: 4, y: 0, z: 4 });
  });

  it('distinct ids get distinct bodies and handles', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    w.registerVehicle(spec({ vehicleId: 'b' }));
    expect(vehicleBodies()).toHaveLength(2);
    expect(w.getColliderHandle('a')).not.toBe(w.getColliderHandle('b'));
    expect(w.readPose('c')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. applyControl — the velocity-selection truth table
// ---------------------------------------------------------------------------

describe('RapierWorld — applyControl', () => {
  const brake = { throttle: 0, brake: 1, steering: 0 };
  const gas = { throttle: 1, brake: 0, steering: 0 };
  const coast = { throttle: 0, brake: 0, steering: 0 };

  it('brake >= 0.99 zeroes velocity even when the throttle is pinned', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', { throttle: 1, brake: 0.99, steering: 0 }, 25, 0);
    expect(w.readPose('v-1')!.speed).toBe(0);
  });

  it('brake 0.98 is NOT a full stop — throttle still wins', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', { throttle: 1, brake: 0.98, steering: 0 }, 25, 0);
    expect(w.readPose('v-1')!.speed).toBeCloseTo(25, 10);
  });

  it('throttle > 0 applies targetSpeed along heading (heading 0 → +X)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', gas, 18, 0);
    const b = vehicleBodies()[0]!;
    expect(b.linvel()).toEqual({ x: 18, y: 0, z: 0 });
  });

  it('heading rotates the same speed onto the XZ plane (heading π/2 → +Z)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', gas, 18, Math.PI / 2);
    const lv = vehicleBodies()[0]!.linvel();
    expect(lv.x).toBeCloseTo(0, 10);
    expect(lv.z).toBeCloseTo(18, 10);
    expect(lv.y).toBe(0);
  });

  it('a negative targetSpeed is clamped to 0 rather than reversing the body', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', gas, -9, 0);
    expect(vehicleBodies()[0]!.linvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('coasting preserves the current speed magnitude (3,0,4 → 5 m/s along heading)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setLinvel({ x: 3, y: 0, z: 4 }, true);
    w.applyControl('v-1', coast, 99, 0);
    const lv = vehicleBodies()[0]!.linvel();
    expect(lv.x).toBeCloseTo(5, 10);
    expect(lv.z).toBeCloseTo(0, 10);
  });

  it('coasting from a stationary body stays at 0 (no phantom speed)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', coast, 99, 0);
    expect(vehicleBodies()[0]!.linvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('brake takes precedence over coast (a coasting body is still stopped)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setLinvel({ x: 20, y: 0, z: 0 }, true);
    w.applyControl('v-1', brake, 20, 0);
    expect(w.readPose('v-1')!.speed).toBe(0);
  });

  it('an unknown vehicleId is a silent no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1' }));
    vehicleBodies()[0]!.setLinvel({ x: 7, y: 0, z: 0 }, true);
    expect(() => w.applyControl('ghost', gas, 30, 0)).not.toThrow();
    expect(vehicleBodies()[0]!.linvel().x).toBe(7);
  });

  it('a reclaimed body handle is a silent no-op (no crash on stale map entry)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    R.state.bodies.delete(vehicleBodies()[0]!.handle);
    expect(() => w.applyControl('v-1', gas, 30, 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. setVehicleSpeed / Lateral / Position / Heading / AngularVelocity
// ---------------------------------------------------------------------------

describe('RapierWorld — setVehicleSpeed', () => {
  it('applies speed immediately along heading', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.setVehicleSpeed('v-1', 12, Math.PI);
    const lv = vehicleBodies()[0]!.linvel();
    expect(lv.x).toBeCloseTo(-12, 10);
    expect(lv.z).toBeCloseTo(0, 10);
  });

  it('clamps a negative speed to 0', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.setVehicleSpeed('v-1', -8, 0);
    expect(vehicleBodies()[0]!.linvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.setVehicleSpeed('ghost', 5, 0)).not.toThrow();
  });
});

describe('RapierWorld — setVehicleLateralVelocity', () => {
  it('is a no-op below 0.01 m/s (no forward direction to be perpendicular to)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setLinvel({ x: 0.005, y: 0, z: 0 }, true);
    w.setVehicleLateralVelocity('v-1', 3);
    const lv = vehicleBodies()[0]!.linvel();
    expect(lv.x).toBeCloseTo(0.005, 10);
    expect(lv.z).toBe(0);
  });

  it('adds a +90° CCW perpendicular component without touching forward speed', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setLinvel({ x: 10, y: 0, z: 0 }, true);
    w.setVehicleLateralVelocity('v-1', 2);
    const lv = vehicleBodies()[0]!.linvel();
    // dir = (1,0) → perp = (-dirZ, dirX) = (0, 1)
    expect(lv.x).toBeCloseTo(10, 10);
    expect(lv.z).toBeCloseTo(2, 10);
  });

  it('sign of lateralMs selects the other side of the road', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setLinvel({ x: 0, y: 0, z: 10 }, true);
    w.setVehicleLateralVelocity('v-1', -2);
    const lv = vehicleBodies()[0]!.linvel();
    // dir = (0,1) → perp = (-1, 0); × (-2) = (+2, 0)
    expect(lv.x).toBeCloseTo(2, 10);
    expect(lv.z).toBeCloseTo(10, 10);
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.setVehicleLateralVelocity('ghost', 1)).not.toThrow();
  });
});

describe('RapierWorld — setVehiclePosition', () => {
  it('teleports and zeroes linvel so the next applyControl restarts from rest', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.applyControl('v-1', { throttle: 1, brake: 0, steering: 0 }, 20, 0);
    w.setVehiclePosition('v-1', { x: -12.5, y: 0.75, z: 33 });
    const pose = w.readPose('v-1')!;
    expect(pose.position).toEqual({ x: -12.5, y: 0.75, z: 33 });
    expect(pose.speed).toBe(0);
  });

  it('leaves heading untouched (drag-to-move does not rotate)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ heading: 1.2 }));
    w.setVehiclePosition('v-1', { x: 9, y: 0, z: 9 });
    expect(w.readPose('v-1')!.heading).toBeCloseTo(1.2, 10);
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.setVehiclePosition('ghost', { x: 0, y: 0, z: 0 })).not.toThrow();
  });
});

describe('RapierWorld — setVehicleHeading', () => {
  it('rotates in place and zeroes angular velocity', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    vehicleBodies()[0]!.setAngvel({ x: 0, y: 4, z: 0 }, true);
    w.setVehicleHeading('v-1', -0.75);
    expect(w.readPose('v-1')!.heading).toBeCloseTo(-0.75, 10);
    expect(vehicleBodies()[0]!.angvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.setVehicleHeading('ghost', 1)).not.toThrow();
  });
});

describe('RapierWorld — setVehicleAngularVelocity', () => {
  it('sets the Y component only (left turn positive, right turn negative)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec());
    w.setVehicleAngularVelocity('v-1', -1.5);
    expect(vehicleBodies()[0]!.angvel()).toEqual({ x: 0, y: -1.5, z: 0 });
    w.setVehicleAngularVelocity('v-1', 0);
    expect(vehicleBodies()[0]!.angvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.setVehicleAngularVelocity('ghost', 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. step — dt clamp, simTime accumulator, contact-event mapping
// ---------------------------------------------------------------------------

describe('RapierWorld — step', () => {
  it('reports fixedDt (1/60) regardless of the caller dt — one physics step per frame', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(w.step(1 / 60).dt).toBeCloseTo(1 / 60, 12);
    // A 30fps render frame still advances exactly one 1/60 step.
    expect(w.step(1 / 30).dt).toBeCloseTo(1 / 60, 12);
    // Even an absurd 5s stall stays at fixedDt (the accumulator is only
    // bookkeeping — M2-A never runs catch-up steps).
    expect(w.step(5).dt).toBeCloseTo(1 / 60, 12);
  });

  it('advances simTime by fixedDt per step and by nothing else', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(w.step(1 / 60).simTime).toBeCloseTo(1 / 60, 12);
    expect(w.step(1 / 30).simTime).toBeCloseTo(2 / 60, 12);
    expect(w.step(0).simTime).toBeCloseTo(3 / 60, 12);
  });

  it('pushes fixedDt into Rapier world.timestep on every step', async () => {
    const w = new RapierWorld();
    await w.init();
    w.step(1 / 30);
    expect(R.state.timestep).toBeCloseTo(1 / 60, 12);
    expect(R.state.stepCalls).toBe(1);
  });

  it('clamps the accumulator input at 1/30 (I5 backstop)', async () => {
    // Observable through the fact that a huge dt and a 1/30 dt both produce
    // exactly one step and one fixedDt of simTime.
    const w = new RapierWorld();
    await w.init();
    w.step(1000);
    expect(R.state.stepCalls).toBe(1);
    expect(w.step(1 / 30).simTime).toBeCloseTo(2 / 60, 12);
  });

  it('maps a started collision between two vehicles to a ContactEvent', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    w.registerVehicle(spec({ vehicleId: 'b' }));
    const ha = Number(w.getColliderHandle('a'));
    const hb = Number(w.getColliderHandle('b'));
    R.state.collisionEvents.push([ha, hb, true]);

    const res = w.step(1 / 60);
    expect(res.contactEvents).toHaveLength(1);
    expect(res.contactEvents[0]).toEqual({
      colliderA: 'a',
      colliderB: 'b',
      normal: { x: 0, y: 0, z: 0 },
      impulse: 0,
    });
  });

  it('ignores an ended (started=false) collision', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    w.registerVehicle(spec({ vehicleId: 'b' }));
    R.state.collisionEvents.push([Number(w.getColliderHandle('a')), Number(w.getColliderHandle('b')), false]);
    expect(w.step(1 / 60).contactEvents).toHaveLength(0);
  });

  it('skips contacts involving the ground (ground handle is not in the vehicle map)', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    // Ground collider handle is the first one RapierWorld created.
    R.state.collisionEvents.push([R.state.colliders[0]!.handle, Number(w.getColliderHandle('a')), true]);
    expect(w.step(1 / 60).contactEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. castRay / castRayBatch
// ---------------------------------------------------------------------------

describe('RapierWorld — castRay', () => {
  it('converts origin/dir to Rapier vectors and reports the hit point + handle', async () => {
    const w = new RapierWorld();
    await w.init();
    R.state.rayResults.push({ timeOfImpact: 12.5, collider: { handle: 7 } });
    const hit = w.castRay({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, 100);
    expect(R.state.lastRay).toEqual({
      origin: { x: 1, y: 2, z: 3 },
      dir: { x: 0, y: 0, z: 1 },
    });
    expect(hit.distance).toBe(12.5);
    expect(hit.colliderHandle).toBe('7');
    expect(hit.point).toEqual({ x: 1, y: 2, z: 15.5 });
  });

  it('returns a null hit at +Infinity when nothing is hit', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(w.castRay({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 50)).toEqual({
      point: null,
      distance: Number.POSITIVE_INFINITY,
      colliderHandle: null,
    });
  });

  it('a body already in contact does not count as a fresh event on the next step', async () => {
    // Sanity: an ended event for the same handle pair is filtered by started.
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    w.registerVehicle(spec({ vehicleId: 'b' }));
    const h = Number(w.getColliderHandle('b'));
    R.state.collisionEvents.push([Number(w.getColliderHandle('a')), h, false]);
    expect(w.step(1 / 60).contactEvents).toHaveLength(0);
    R.state.collisionEvents.push([Number(w.getColliderHandle('a')), h, true]);
    expect(w.step(1 / 60).contactEvents).toHaveLength(1);
  });
});

describe('RapierWorld — castRayBatch', () => {
  it('fans out to castRay, preserving index order', async () => {
    const w = new RapierWorld();
    await w.init();
    R.state.rayResults.push({ timeOfImpact: 3, collider: { handle: 1 } });
    R.state.rayResults.push({ timeOfImpact: 9, collider: { handle: 2 } });
    const hits = w.castRayBatch(
      [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
      ],
      [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
      ],
      100,
    );
    expect(hits.map((h) => h.distance)).toEqual([3, 9]);
    expect(hits.map((h) => h.colliderHandle)).toEqual(['1', '2']);
    expect(hits[1]!.point).toEqual({ x: -4, y: 0, z: 0 });
  });

  it('an empty batch returns an empty array', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(w.castRayBatch([], [], 10)).toEqual([]);
  });

  it('throws when the arrays disagree in length, naming both counts', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.castRayBatch([{ x: 0, y: 0, z: 0 }], [], 10)).toThrowError(
      'castRayBatch: origins (1) and dirs (0) length mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. removeVehicle / updateVehicleType / destroy
// ---------------------------------------------------------------------------

describe('RapierWorld — removeVehicle', () => {
  it('drops the body, the handle and the pose', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1' }));
    w.removeVehicle('v-1');
    expect(vehicleBodies()).toHaveLength(0);
    expect(w.getColliderHandle('v-1')).toBeNull();
    expect(w.readPose('v-1')).toBeNull();
  });

  it('removing an unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1' }));
    expect(() => w.removeVehicle('ghost')).not.toThrow();
    expect(vehicleBodies()).toHaveLength(1);
  });

  it('a removed vehicle no longer produces contact events', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'a' }));
    w.registerVehicle(spec({ vehicleId: 'b' }));
    const ha = Number(w.getColliderHandle('a'));
    const hb = Number(w.getColliderHandle('b'));
    w.removeVehicle('b');
    R.state.collisionEvents.push([ha, hb, true]);
    expect(w.step(1 / 60).contactEvents).toHaveLength(0);
  });
});

describe('RapierWorld — updateVehicleType', () => {
  it('swaps in the new type collider while preserving position, heading and speed', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(
      bodySpec('v-1', 'car', { x: 5, y: 0.3, z: -7 }, 0.7),
    );
    w.applyControl('v-1', { throttle: 1, brake: 0, steering: 0 }, 0, 0);
    vehicleBodies()[0]!.setLinvel({ x: 3, y: 0, z: 4 }, true); // 5 m/s

    w.updateVehicleType('v-1', 'bus');

    const d = vehicleColliderDescs().at(-1)!;
    expect(d.halfExtents.x).toBeCloseTo(4.5, 10); // bus length 9.0
    expect(d.halfExtents.z).toBeCloseTo(1.25, 10); // bus width 2.5
    expect(d.mass).toBe(8000);

    const pose = w.readPose('v-1')!;
    expect(pose.position).toEqual({ x: 5, y: 0.3, z: -7 });
    expect(pose.heading).toBeCloseTo(0.7, 10);
    expect(pose.speed).toBeCloseTo(5, 10);
  });

  it('unknown id is a no-op', async () => {
    const w = new RapierWorld();
    await w.init();
    expect(() => w.updateVehicleType('ghost', 'bus')).not.toThrow();
    expect(vehicleBodies()).toHaveLength(0);
  });
});

describe('RapierWorld — destroy', () => {
  it('frees the Rapier world, clears the handle maps and reverts to the pre-init state', async () => {
    const w = new RapierWorld();
    await w.init();
    w.registerVehicle(spec({ vehicleId: 'v-1' }));
    w.step(1 / 60);

    w.destroy();

    expect(R.state.freed).toBe(true);
    expect(w.readPose('v-1')).toBeNull();
    expect(w.getColliderHandle('v-1')).toBeNull();
    expect(w.castRay({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10).point).toBeNull();
    const after = w.step(1 / 60);
    expect(after.dt).toBe(1 / 60);
    expect(after.contactEvents).toEqual([]);
    expect(after.simTime).toBeCloseTo(1 / 60, 12); // frozen at the pre-destroy value
  });

  it('is idempotent', async () => {
    const w = new RapierWorld();
    await w.init();
    w.destroy();
    expect(() => w.destroy()).not.toThrow();
  });

  it('destroying an uninitialized instance is a no-op (no Rapier world to free)', () => {
    const w = new RapierWorld();
    expect(() => w.destroy()).not.toThrow();
    expect(R.state.freed).toBe(false);
  });
});

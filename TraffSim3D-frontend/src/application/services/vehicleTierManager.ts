// src/application/services/vehicleTierManager.ts
//
// The NTE-style vehicle tier system: vehicles near the camera run the
// full physics path (dynamic Rapier body, every control step); vehicles
// far away are "mass entities" — light data (position/arc-length/speed)
// advanced by the application, with their Rapier bodies disabled. This
// is what lets the fleet grow past a few hundred vehicles without the
// physics step growing with it.
//
// The three rules that make it safe (from the official NTE talk, whose
// numbers were -22.7% frame time with 300 NPCs):
//
//   1. The tier DECISION and the tier EXECUTION are decoupled: this
//      manager only decides; the store applies the body changes through
//      the returned upgrade/downgrade lists, at most `upgradesPerFrame`
//      upgrades per frame.
//   2. Hysteresis: the downgrade threshold is `nearRadius + hysteresis`
//      — a vehicle sitting on the boundary does not flip every frame.
//   3. Force-near overrides distance: the ridden vehicle, a vehicle
//      mid lane-change, mid turn, approaching a junction, crashed, or
//      being dragged by the editor always runs the full tier, whatever
//      its distance — those states need the physics or the guard stack.

export type VehicleTier = 'near' | 'far'

export interface TierEntry {
  id: string
  /** Distance to the camera, metres. `null` = camera unknown (the
   *  vehicle is treated as force-near — the safe default). */
  distance: number | null
  /** Force the full tier regardless of distance (ride, lane change,
   *  turn, junction approach, crashed, dragged). */
  forceNear: boolean
}

export interface TierManagerOptions {
  /** Vehicles within this radius of the camera run the full tier. */
  nearRadiusM: number
  /** Cap on distance-based near vehicles (force-near vehicles do not
   *  count against it) — bounds the physics cost on dense scenes. */
  nearCap: number
  /** Max far→near upgrades per frame (the NTE budget rule). */
  upgradesPerFrame: number
  /** Downgrade threshold slack: a near vehicle only downgrades past
   *  `nearRadiusM + hysteresisM`, so boundary sitters do not flip. */
  hysteresisM: number
}

export const DEFAULT_TIER_OPTIONS: TierManagerOptions = {
  nearRadiusM: 300,
  nearCap: 60,
  upgradesPerFrame: 3,
  hysteresisM: 20,
}

export interface TierUpdateResult {
  /** Vehicles promoted far → near this frame (apply: enable the body and
   *  align it to the entity pose). Sorted nearest first. */
  upgrades: string[]
  /** Vehicles demoted near → far this frame (apply: disable the body). */
  downgrades: string[]
}

export interface VehicleTierManager {
  /** Per-frame tier decision. Returns the promotion/demotion lists. */
  update: (entries: readonly TierEntry[]) => TierUpdateResult
  /** The current tier of a vehicle; `null` for unknown ids — callers
   *  treat `null` as near (the full tier is the safe default). */
  tierOf: (id: string) => VehicleTier | null
  /** Force a vehicle to the near tier immediately (e.g. the tick's
   *  travel-end safety net) — takes effect the same frame. */
  forceNear: (id: string) => void
  /** Drop a vehicle's tier state (it was removed from the network). */
  forget: (id: string) => void
  /** Drop ALL tier state (a scene load replaced the network). */
  clear: () => void
  /** Debug/test read: how many vehicles currently hold the near tier. */
  nearCount: () => number
  /** How many vehicles currently hold the far tier. The tick's light
   *  simulation is gated on this: zero far vehicles = skip the whole
   *  bucket-building pass (the scene editor never tiers, and its frame
   *  budget on a CI runner cannot spare even an empty scan). */
  farCount: () => number
}

export const createVehicleTierManager = (
  options: Partial<TierManagerOptions> = {},
): VehicleTierManager => {
  const opts = { ...DEFAULT_TIER_OPTIONS, ...options }
  /** The tier bookkeeping — per manager INSTANCE (never module-level:
   *  two views would otherwise share one fleet's tiers). */
  const tiers = new Map<string, VehicleTier>()
  /** The ids currently holding the near tier (the promotion budget
   *  counts against this set's membership changes). */
  const nearIds = new Set<string>()
  /** The ids currently holding the far tier (the light simulation's
   *  workload roster — and its skip-gate when empty). */
  const farIds = new Set<string>()

  return {
    update: (entries) => {
      // 1. Willing tier per entry: force-near wins; otherwise distance
      //    with hysteresis against the CURRENT tier (a far vehicle only
      //    promotes inside the radius, a near vehicle only demotes past
      //    radius + slack). Force-near vehicles do not count against
      //    the near cap — the ride must never lose its physics because
      //    the camera-radius list is full.
      type Want = {
        id: string
        tier: VehicleTier
        distance: number
        wasNear: boolean
        forceNear: boolean
        promoted?: boolean
      }
      const wants: Want[] = []
      const distanceNear: Array<{ id: string; distance: number }> = []
      for (const e of entries) {
        const wasNear = tiers.get(e.id) === 'near'
        let tier: VehicleTier
        if (e.forceNear || e.distance === null) {
          tier = 'near'
        } else {
          const downEdge = opts.nearRadiusM + opts.hysteresisM
          if (e.distance <= opts.nearRadiusM) tier = 'near'
          else if (e.distance > downEdge) tier = 'far'
          else tier = wasNear ? 'near' : 'far' // inside the slack: keep
        }
        if (tier === 'near' && !e.forceNear) {
          distanceNear.push({ id: e.id, distance: e.distance ?? Infinity })
        }
        wants.push({
          id: e.id,
          tier,
          distance: e.distance ?? Infinity,
          wasNear,
          forceNear: e.forceNear,
        })
      }

      // 2. The near cap: if the distance-based near list overflows, the
      //    FARTHEST entries demote (the nearest keep the full tier).
      if (distanceNear.length > opts.nearCap) {
        distanceNear.sort((a, b) => b.distance - a.distance) // farthest first
        for (let i = 0; i < distanceNear.length - opts.nearCap; i++) {
          const over = distanceNear[i]!
          const w = wants.find((x) => x.id === over.id)!
          w.tier = 'far'
        }
      }

      // 3. Diff against the previous state with the upgrade budget:
      //    far→near promotions are limited per frame (nearest first),
      //    near→far demotions are free. Force-near promotions are
      //    UNCONDITIONAL — the ride must have physics the same frame.
      const upgrades: string[] = []
      const downgrades: string[] = []
      const promoteCandidates = wants.filter((w) => w.tier === 'near' && !w.wasNear)
      for (const w of promoteCandidates) {
        if (w.forceNear) {
          upgrades.push(w.id)
          w.promoted = true
        }
      }
      const budgeted = promoteCandidates
        .filter((w) => !w.promoted)
        .sort((a, b) => a.distance - b.distance)
      let budget = opts.upgradesPerFrame
      for (const w of budgeted) {
        if (budget > 0) {
          budget -= 1
          upgrades.push(w.id)
          w.promoted = true
        } else {
          // Budget exhausted: stays far this frame, re-proposed next
          // frame — the queue IS the budget (the NTE rule).
          w.tier = 'far'
        }
      }
      for (const w of wants) {
        tiers.set(w.id, w.tier)
        if (w.tier === 'near') {
          farIds.delete(w.id)
          if (!w.wasNear) nearIds.add(w.id)
        }
        if (w.tier === 'far') {
          nearIds.delete(w.id)
          farIds.add(w.id)
          if (w.wasNear) downgrades.push(w.id)
        }
      }
      return { upgrades, downgrades }
    },

    tierOf: (id) => tiers.get(id) ?? null,

    forceNear: (id) => {
      tiers.set(id, 'near')
      nearIds.add(id)
      farIds.delete(id)
    },

    forget: (id) => {
      tiers.delete(id)
      nearIds.delete(id)
      farIds.delete(id)
    },

    clear: () => {
      tiers.clear()
      nearIds.clear()
      farIds.clear()
    },

    nearCount: () => nearIds.size,

    farCount: () => farIds.size,
  }
}

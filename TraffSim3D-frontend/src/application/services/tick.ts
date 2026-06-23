import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { inIntersectionBox, lanePoint, roadLength, laneForwardSign } from '@domain/services/laneGeometry';
import {
  MAX_ACCEL,
  MAX_DECEL,
  MAX_SPEED,
  MIN_GAP,
  STOP_LINE_BUFFER,
  STOP_LINE_DISTANCE,
  TIME_HEADWAY,
} from '@shared/constants/simulation';

/**
 * Per-type "collision radius" — half the longest body dimension plus a
 * small safety margin. Used by the per-pair distance check to detect
 * imminent overlap on perpendicular roads at the intersection.
 */
const COLLISION_RADIUS: Record<Vehicle['type'], number> = {
  car: 2.6,    // ~4.2 long / 2 + ~0.5 buffer
  truck: 3.6,  // ~6.5 long / 2 + ~0.4 buffer
  bus: 5.0,    // ~9.0 long / 2 + ~0.5 buffer
};
const COLLISION_BUFFER = 0.8;  // extra clearance on top of the radii sum
/**
 * If two cars' centers end up within this distance, they've physically
 * overlapped — treat it as a crash. The car is marked `status='crashed'`
 * and locked at speed 0. (Real emergency response is the *attempt* to
 * prevent this; reaching this distance means the attempt failed.)
 */
const CRASH_DISTANCE = 1.0;

/**
 * M1.5 — crash recovery constants. A crash is treated as an
 * *incident at a point*, not a permanent road block. The crashed
 * cars creep forward at this speed (m/s) so they gradually leave
 * the intersection box, and the perpendicular opposite-direction
 * traffic can back up to give them room.
 */
const NUDGE_SPEED = 0.5;  // m/s — crashed cars' target speed
const NUDGE_REVERSE = 2.0;  // metres of reverse displacement the helper car allows
const NUDGE_REVERSE_SPEED = 0.8;  // m/s — the reverse step rate

/**
 * Advance the simulation by `dt` seconds. Mutates the network in place.
 *
 * For each vehicle:
 *   1. Decide `targetSpeed` (defaults to road speed limit).
 *   2. Check the traffic light ahead — red or yellow-with-safe-stop
 *      pulls `targetSpeed` toward 0. (Chinese "黄灯准备停": if you
 *      can stop safely, stop; otherwise continue.)
 *   3. Check for a leader vehicle ahead in the same lane — if close
 *      enough, match their speed (car-following, Newell 2002).
 *   4. Per-pair distance check: if two cars on *different* lanes or
 *      *different* roads are within sum-of-radii + buffer, brake the
 *      "yielding" car (the one with a red light ahead, or the slower
 *      one if both are equal) to prevent intersection clipping.
 *   5. Accelerate / brake toward `targetSpeed` with `MAX_ACCEL` /
 *      `MAX_DECEL` ceilings.
 *   6. Move forward along the lane by `speed * dt`; wrap `s` at the
 *      road ends so each car loops its lane forever.
 *   7. Re-derive world-space position + heading so the renderer
 *      doesn't need to know about lane geometry.
 *
 * Status side effects:
 *   - status becomes 'waiting' when stopped (at a red light or
 *     because of a collision-avoidance brake).
 *   - status becomes 'driving' again once we accelerate away.
 */
export const tick = (network: RoadNetwork, dt: number, simTime: number): void => {
  // 1. Advance traffic-light phases.
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      light.phaseRemaining -= dt;
      if (light.phaseRemaining <= 0) {
        if (light.phase === LightPhase.Green) {
          light.phase = LightPhase.Yellow;
          light.phaseRemaining = 3;
        } else if (light.phase === LightPhase.Yellow) {
          light.phase = LightPhase.Red;
          light.phaseRemaining = light.cycleSeconds - 33;  // green + yellow
        } else {
          light.phase = LightPhase.Green;
          light.phaseRemaining = 30;
        }
      }
    }
  }

  // 1b. Stamp each vehicle's intersection-entry time. This runs
  // BEFORE the per-vehicle target-speed step so the right-of-way
  // logic in applyBoxInAndCollisionAvoidance sees up-to-date
  // entry timestamps on the same tick.
  updateIntersectionEntry(network, simTime);

  // 2. Compute each vehicle's target speed (light + leader + box-in).
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;

    v.targetSpeed = road.speedLimit;
    applyTrafficLightConstraint(v, road, network);
    applyCarFollowingConstraint(v, road, network);
  }

  // 3. Adjacent-lane box-in + cross-road collision (M1.5).
  // Two scenarios:
  //   (a) Same road, same direction, adjacent lane: the faster car
  //       can't pass the slower one ("bus blocking the car"). The
  //       faster car matches the slower car's speed. This is the
  //       realistic driver response when swerving isn't modelled.
  //   (b) Different roads: the two cars are on perpendicular roads
  //       and may collide at the intersection. Emergency-brake the
  //       yielder using a 3-tier priority:
  //         1. red/yellow-light car yields to green-light car
  //         2. the car that ENTERED the intersection first keeps
  //            right-of-way ("先到先行" — the M1 user's words)
  //         3. tie → slower car yields
  //       If the centres actually overlap (within CRASH_DISTANCE),
  //       both cars are marked `crashed` and force-stop.
  applyBoxInAndCollisionAvoidance(network);

  // 4. Apply acceleration, move, derive world position.
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;

    // Crashed cars are NOT locked at speed 0 anymore. We let them creep
    // forward at a tiny "nudge" speed (NUDGE_SPEED) so they slowly
    // drift out of the intersection and unblock cross traffic. This
    // matches the M1.5 contract: a crash is an *incident* at a point,
    // not a permanent road block. (Hard lock previously caused a
    // single crash to freeze the entire intersection forever.)
    if (v.status === 'crashed') {
      // Half the road's speed limit, capped low so it never gets
      // anywhere fast. Use it as the new target; the normal accel/
      // decel math below then brings `speed` toward it.
      v.targetSpeed = Math.min(NUDGE_SPEED, road.speedLimit * 0.5);
    }

    if (v.speed < v.targetSpeed) {
      v.speed = Math.min(v.targetSpeed, v.speed + MAX_ACCEL * dt);
    } else if (v.speed > v.targetSpeed) {
      v.speed = Math.max(v.targetSpeed, v.speed - MAX_DECEL * dt);
    }
    v.speed = Math.max(0, Math.min(MAX_SPEED, v.speed));

    // Move forward along the lane.
    const sign = laneForwardSign(v.laneIndex, road.laneCount);
    v.s += v.speed * sign * dt;

    // Wrap at the road ends so a single car loops its lane forever.
    const len = roadLength(road);
    if (v.s > len) v.s -= len;
    if (v.s < 0) v.s += len;

    // Update status for the outline / inspector. Crashed stays
    // crashed (the marker is the persistent incident — what
    // changes is that the car now moves again).
    if (v.status !== 'crashed') {
      v.status = v.speed < 0.5 ? 'waiting' : 'driving';
    }

    // Re-derive world position + heading.
    const lp = lanePoint(road, v.laneIndex, v.s);
    v.position.x = lp.position.x;
    v.position.z = lp.position.z;
    v.heading = lp.heading;
  }

  // 5. Intersection-box reverse nudge (M1.5).
  // The user's M1 feedback: even after a crash, the *approaching*
  // car should be able to recover by having the *opposite-direction*
  // car back up a few units. We implement this as: any car that is
  // (a) NOT crashed, (b) inside an intersection box, and (c) within
  // N meters of a crashed car on a perpendicular road, gets a
  // small reverse displacement (≤ NUDGE_REVERSE meters) at
  // NUDGE_REVERSE_SPEED. This "反向让一步" is the local manifestation
  // of "倒车给先到车辆让出道路".
  applyIntersectionNudge(network);
};

/**
 * Stamp each vehicle with the simulation-time at which it entered
 * (or left) the intersection box. The entry time is the tiebreaker
 * for the cross-road right-of-way rule: "the car that got there
 * first goes first".
 *
 * On entry: stamp `enteredIntersectionAt = simTime`.
 * On exit:  clear it back to `null` so the next time the car enters,
 *           a fresh timestamp is recorded.
 *
 * `simTime` is monotonic across ticks within a sim run; it is reset
 * by Reset (handled by the caller — `worldStore.reset()` rebuilds
 * the network via `buildDefaultNetwork`, which sets
 * `enteredIntersectionAt: null` on every vehicle).
 */
const updateIntersectionEntry = (network: RoadNetwork, simTime: number): void => {
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;
    if (inIntersectionBox(road, v.s)) {
      if (v.enteredIntersectionAt === null) {
        v.enteredIntersectionAt = simTime;
      }
    } else {
      v.enteredIntersectionAt = null;
    }
  }
};

/**
 * If the vehicle is approaching an intersection in the same direction
 * as the relevant traffic light, slow down or stop at the stop line.
 *
 * Chinese traffic-rule nuance (《道交法实施条例》第三十八条):
 *   - 红灯 (red): must stop.
 *   - 黄灯 (yellow): "prepare to stop". If you can stop safely, stop;
 *     if you're past the stop line or braking would put you in the
 *     intersection, continue through.
 *   - 绿灯 (green): cross freely.
 *
 * The road passes *through* the intersection at `s = roadLength / 2`.
 * The stop line sits 5u before that midpoint in lane-forward terms.
 */
const applyTrafficLightConstraint = (v: Vehicle, road: Road, network: RoadNetwork): void => {
  const len = roadLength(road);
  const stopLineS = len / 2 - STOP_LINE_DISTANCE;
  if (v.s >= stopLineS) return;
  const distToStopLine = stopLineS - v.s;
  if (distToStopLine <= 0) return;

  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue;
    for (const light of inter.trafficLights) {
      const roadIsNS = Math.abs(road.endNode.z - road.startNode.z) > Math.abs(road.endNode.x - road.startNode.x);
      const lightAxisMatches = (roadIsNS && light.axis === 'ns') || (!roadIsNS && light.axis === 'ew');
      if (!lightAxisMatches) continue;

      if (light.phase === LightPhase.Red) {
        // Red → must stop. Pull target speed to 0 if we can brake
        // in time, otherwise we'll just slow as much as MAX_DECEL
        // allows and "stop" at whatever s we end up at.
        const braking = (v.speed * v.speed) / (2 * MAX_DECEL) + STOP_LINE_BUFFER;
        if (distToStopLine <= braking) v.targetSpeed = 0;
        return;
      }
      if (light.phase === LightPhase.Yellow) {
        // Yellow → "prepare to stop". Only pull target to 0 if we
        // can actually stop without crossing the stop line. If we
        // can't, continue through (Chinese road-safety practice).
        const braking = (v.speed * v.speed) / (2 * MAX_DECEL) + STOP_LINE_BUFFER;
        if (distToStopLine <= braking) v.targetSpeed = 0;
        return;
      }
      // Green → no constraint.
      return;
    }
  }
};

/**
 * Find the next vehicle ahead in the same lane and adjust
 * `v.targetSpeed` so we don't rear-end them.
 *
 * M1.5 tweak: the previous hard-brake threshold `gap < 1.5` was
 * over-cautious — it stopped a follower 1.5m behind a leader, which
 * meant a single stopped leader could halt a stream of followers
 * from far back (gap > 80u). We now only hard-brake when the
 * follower is essentially touching the leader (gap < 0.5). The
 * smoother speed-match (`targetSpeed = leader.speed`) handles the
 * normal follow case.
 */
const applyCarFollowingConstraint = (v: Vehicle, road: Road, network: RoadNetwork): void => {
  const sign = laneForwardSign(v.laneIndex, road.laneCount);
  let bestGap = Infinity;
  let leader: Vehicle | null = null;
  for (const other of Object.values(network.vehicles)) {
    if (other.id === v.id) continue;
    if (other.roadId !== road.id) continue;
    if (other.laneIndex !== v.laneIndex) continue;
    const ds = sign === 1 ? other.s - v.s : v.s - other.s;
    if (ds <= 0) continue;
    if (ds > 80) continue;
    if (ds < bestGap) {
      bestGap = ds;
      leader = other;
    }
  }
  if (!leader) return;

  const gap = Math.max(0, bestGap - 4);
  const safeGap = leader.speed * TIME_HEADWAY + MIN_GAP;
  if (gap >= safeGap) return;

  // Crashed leaders are also "moving" (we don't lock them) but at
  // a very slow NUDGE_SPEED. Match that instead of stopping — this
  // lets a stream of followers inch past the crash site, the way
  // real traffic does around a fender-bender.
  if (leader.status === 'crashed') {
    v.targetSpeed = Math.min(v.targetSpeed, Math.max(leader.speed, NUDGE_SPEED));
    return;
  }

  if (gap < 0.5) {
    v.targetSpeed = 0;
  } else {
    v.targetSpeed = leader.speed;
  }
};

/**
 * True if `v` is currently approaching a red or yellow traffic light
 * that controls its direction. Used by the collision-avoidance
 * routine to pick which car should yield.
 */
const isApproachingAdvisoryLight = (v: Vehicle, network: RoadNetwork): boolean => {
  const road = network.roads[v.roadId];
  if (!road) return false;
  const len = roadLength(road);
  const stopLineS = len / 2 - STOP_LINE_DISTANCE;
  if (v.s >= stopLineS) return false;
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue;
    for (const light of inter.trafficLights) {
      const roadIsNS = Math.abs(road.endNode.z - road.startNode.z) > Math.abs(road.endNode.x - road.startNode.x);
      const lightAxisMatches = (roadIsNS && light.axis === 'ns') || (!roadIsNS && light.axis === 'ew');
      if (!lightAxisMatches) continue;
      if (light.phase === LightPhase.Red || light.phase === LightPhase.Yellow) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Per-pair interaction for two distinct cases:
 *
 *   1. **Box-in** (same road, same direction, adjacent lane). The
 *      faster car can't overtake the slower car in an adjacent lane
 *      — it would have to swerve, which is M2. The realistic
 *      response in M1 is to match the leader's speed ("if you can't
 *      pass, you slow down to keep the gap"). The leader is the car
 *      ahead in the lane-forward sense; the follower matches.
 *
 *   2. **Cross-road emergency brake** (different roads). If two cars
 *      on perpendicular roads are within the sum of their collision
 *      radii + buffer, an actual crash is imminent. The yielding
 *      car (red/yellow light, or slower if both have green) hard-
 *      brakes to 0. If the centres are within CRASH_DISTANCE, both
 *      cars are marked `crashed` and locked — that's the
 *      "we couldn't avoid it" state.
 *
 * Same road, OPPOSITE direction (lane diff crosses the yellow
 * centreline): the cars are on parallel tracks moving past each
 * other. No collision possible — skipped.
 */
const applyBoxInAndCollisionAvoidance = (network: RoadNetwork): void => {
  const cars = Object.values(network.vehicles);
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    const roadA = network.roads[a.roadId];
    if (!roadA) continue;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j]!;
      const roadB = network.roads[b.roadId];
      if (!roadB) continue;

      if (a.roadId === b.roadId) {
        // Same road — case (1) box-in, OR skip if opposite direction.
        const aForward = a.laneIndex < roadA.laneCount / 2;
        const bForward = b.laneIndex < roadA.laneCount / 2;
        if (aForward !== bForward) continue;  // opposite directions, no interaction
        if (Math.abs(a.laneIndex - b.laneIndex) !== 1) continue;  // non-adjacent
        // Determine who is "in front" (larger s for forward lanes,
        // smaller s for backward lanes — the car further along the
        // shared direction blocks the one behind it).
        const aInFront = aForward ? (a.s > b.s) : (a.s < b.s);
        const leader = aInFront ? a : b;
        const follower = aInFront ? b : a;
        // The follower can't overtake. Match the leader's speed.
        if (follower.speed > leader.speed) {
          follower.targetSpeed = Math.min(follower.targetSpeed, leader.speed);
        }
        continue;
      }

      // Different roads — case (2) cross-road emergency brake.
      const dx = a.position.x - b.position.x;
      const dz = a.position.z - b.position.z;
      const dist2 = dx * dx + dz * dz;
      const minDist = COLLISION_RADIUS[a.type] + COLLISION_RADIUS[b.type] + COLLISION_BUFFER;

      if (dist2 < minDist * minDist) {
        // Crash? Centres within CRASH_DISTANCE → both cars crashed.
        if (dist2 < CRASH_DISTANCE * CRASH_DISTANCE) {
          a.status = 'crashed';
          b.status = 'crashed';
          continue;
        }
        // Emergency brake: the yielder goes to 0.
        // Tiered right-of-way (M1.5):
        //   1. red/yellow-light car yields to green-light car
        //   2. car that ENTERED the intersection first keeps right
        //      of way ("先到先行")
        //   3. tie → slower car yields
        const aLight = isApproachingAdvisoryLight(a, network);
        const bLight = isApproachingAdvisoryLight(b, network);
        if (aLight && !bLight) {
          a.targetSpeed = 0;
          continue;
        }
        if (bLight && !aLight) {
          b.targetSpeed = 0;
          continue;
        }
        // Both on the same light state (typically both green — the
        // deadlock case the M1 screenshot showed). Fall through to
        // the entry-time tiebreaker.
        const aEnteredAt = a.enteredIntersectionAt;
        const bEnteredAt = b.enteredIntersectionAt;
        if (aEnteredAt !== null && bEnteredAt !== null && aEnteredAt !== bEnteredAt) {
          // Earlier entry → keep going. Newer arrival → yield.
          if (aEnteredAt < bEnteredAt) {
            b.targetSpeed = 0;
          } else {
            a.targetSpeed = 0;
          }
          continue;
        }
        // One is inside, the other hasn't entered yet → the one
        // already inside keeps going; the newcomer waits.
        if (aEnteredAt !== null && bEnteredAt === null) {
          b.targetSpeed = 0;
          continue;
        }
        if (bEnteredAt !== null && aEnteredAt === null) {
          a.targetSpeed = 0;
          continue;
        }
        // Both outside (shouldn't normally happen with our radii
        // and 60u roads — but if it does, fall back to speed).
        if (a.speed <= b.speed) {
          a.targetSpeed = 0;
        } else {
          b.targetSpeed = 0;
        }
      }
    }
  }
};

/**
 * After every car has its target speed set, "give way" by reversing
 * a non-crashed car that's stuck near a crashed car inside an
 * intersection box. The reverse is *bounded* — at most NUDGE_REVERSE
 * metres per tick — and runs at NUDGE_REVERSE_SPEED. The car still
 * moves forward normally on the next tick if its target speed is
 * non-zero; the reverse just makes room for the crashed car to
 * nudge out of the box.
 *
 * Why this isn't car-following: car-following looks only at cars
 * *ahead* in the same lane. A crashed car on a perpendicular road
 * is "ahead" in the world sense but not the lane sense, so plain
 * car-following won't help it. This routine is the explicit
 * "倒车给先到车辆让出道路" step.
 */
const applyIntersectionNudge = (network: RoadNetwork): void => {
  // Build a list of crashed cars once. Most ticks have 0-1 crashed
  // cars, so the per-tick cost is bounded.
  const crashed: Vehicle[] = [];
  for (const v of Object.values(network.vehicles)) {
    if (v.status === 'crashed') crashed.push(v);
  }
  if (crashed.length === 0) return;

  for (const helper of Object.values(network.vehicles)) {
    if (helper.status === 'crashed') continue;  // crashed cars don't reverse
    const helperRoad = network.roads[helper.roadId];
    if (!helperRoad) continue;
    if (!inIntersectionBox(helperRoad, helper.s)) continue;

    // Is there a crashed car on a perpendicular road within
    // NUDGE_REVERSE metres? If so, we are the "give-way" car.
    let nearCrashed: Vehicle | null = null;
    for (const c of crashed) {
      if (c.roadId === helper.roadId) continue;  // same road → not perpendicular
      const dx = helper.position.x - c.position.x;
      const dz = helper.position.z - c.position.z;
      if (dx * dx + dz * dz > NUDGE_REVERSE * NUDGE_REVERSE) continue;
      nearCrashed = c;
      break;
    }
    if (!nearCrashed) continue;

    // Reverse one step. `s` is in lane-forward terms, so the
    // sign of the displacement depends on the helper's lane
    // direction (forward lanes move +s, backward lanes move −s).
    const sign = laneForwardSign(helper.laneIndex, helperRoad.laneCount);
    helper.s -= NUDGE_REVERSE_SPEED * sign * (1 / 60);  // ≈ one frame at 60fps
    // Clamp to a safe window: don't push the helper past the box
    // edge (keep it inside the box so the *perpendicular* car can
    // actually see the gap). We use the half-width of the box
    // (STOP_LINE_DISTANCE) plus a small margin.
    const len = roadLength(helperRoad);
    const lo = len / 2 - STOP_LINE_DISTANCE;
    const hi = len / 2 + STOP_LINE_DISTANCE;
    if (helper.s < lo) helper.s = lo;
    if (helper.s > hi) helper.s = hi;
    // Also reflect the reverse into the renderer right now (the
    // tick's normal s-write happens next frame, but the helper's
    // world position needs to be in sync for the user to see
    // the give-way visually).
    const lp = lanePoint(helperRoad, helper.laneIndex, helper.s);
    helper.position.x = lp.position.x;
    helper.position.z = lp.position.z;
    helper.heading = lp.heading;
    // Mark as "waiting" so the outline reflects the give-way.
    helper.status = 'waiting';
  }
};
/**
 * The clearance physics — the height rule's physical twin.
 *
 * The domain already refuses to spawn a bus under a 3.5 m tunnel and
 * refuses to turn one into it. This spec pins the OTHER half: the
 * physics world has a fixed portal over every height-limited road, so
 * a vehicle that is on the road anyway meets something solid.
 *
 * The fixture is a straight 140 m tunnel with a 3.5 m limit. A bus
 * (3.4 m + 0.2 m of roof clearance) and a car (1.6 m) both start 40 m
 * before the far portal:
 *
 *   - the car must PASS the portal;
 *   - the bus must STOP with its nose at the portal.
 *
 * The portal's underside is at 3.3 m (the limit minus the roof
 * clearance), which is exactly the height the rule compares against.
 */
import { test, expect } from '@playwright/test'

const TUNNEL_HEIGHT_M = 3.5
/** The tunnel's far end — where the portal stands. */
const PORTAL_Z = 140
/** Where the car starts (ahead of the bus — two cars on the same
 *  spot would just push each other around). */
const CAR_START_Z = 110
/** Where the bus starts (behind the car, so the car is in the clear). */
const BUS_START_Z = 60

test('a bus is stopped by the height portal; a car drives through it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/scene-editor')
  await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' })
  await page.waitForTimeout(1500)

  // The Rapier world is loaded asynchronously (WASM). The store syncs
  // the portals when the world attaches, so the test only has to wait
  // for the world to be there.
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __world?: { getRapierWorld(): unknown } }).__world
      return Boolean(w && w.getRapierWorld())
    },
    undefined,
    { timeout: 60_000 },
  )

  await page.evaluate(
    ({ heightM, carZ, busZ }) => {
      const w = (
        window as unknown as {
          __world: { loadNetwork: (n: unknown, label: string) => void }
        }
      ).__world
      const pos = (x: number, z: number) => ({ x, y: 0, z })
      const vehicle = (id: string, type: 'car' | 'bus', z: number) => ({
        id,
        type,
        roadId: 'w-tunnel',
        laneIndex: 0,
        s: z,
        lane: 'w-tunnel:0',
        color: '#3a86ff',
        position: pos(1.75, z),
        heading: Math.PI / 2,
        speed: 8,
        targetSpeed: 8,
        status: 'driving',
        desiredStatus: 'driving',
        pitch: 0,
        // The nullable fields of the entity — a vehicle without them
        // used to take the whole physics world down with it (see the
        // `!= null` guards in tick.ts).
        enteredIntersectionAt: null,
        desiredLaneIndex: null,
        laneChangeStartedAt: null,
        spawnedAt: 0,
      })
      w.loadNetwork(
        {
          origin: { lat: 22.54297, lon: 114.06865 },
          roads: {
            'w-tunnel': {
              id: 'w-tunnel',
              startNode: pos(0, 0),
              endNode: pos(0, 140),
              waypoints: [pos(0, 0), pos(0, 140)],
              laneCount: 2,
              speedLimit: 16.67,
              level: 0,
              oneway: false,
              highway: 'trunk',
              maxHeightM: heightM,
            },
            // A plain road at the far end, so a vehicle that passes the
            // portal has somewhere to go.
            'w-beyond': {
              id: 'w-beyond',
              startNode: pos(0, 140),
              endNode: pos(0, 260),
              waypoints: [pos(0, 140), pos(0, 260)],
              laneCount: 2,
              speedLimit: 16.67,
              level: 0,
              oneway: false,
              highway: 'trunk',
            },
          },
          intersections: {
            'i-1': {
              id: 'i-1',
              position: pos(0, 140),
              trafficLights: [],
              connectedRoads: ['w-tunnel', 'w-beyond'],
              intersectionRadius: 10,
            },
          },
          vehicles: {
            'v-bus': vehicle('v-bus', 'bus', busZ),
            'v-car': vehicle('v-car', 'car', carZ),
          },
          spawnPoints: {},
        },
        'clearance physics',
      )
    },
    { heightM: TUNNEL_HEIGHT_M, carZ: CAR_START_Z, busZ: BUS_START_Z },
  )

  // The portals exist: one pair for the height-limited road.
  const beams = await page.evaluate(() => {
    const w = (
      window as unknown as {
        __world: { getRapierWorld(): { clearanceBeamCount(): number } }
      }
    ).__world
    return w.getRapierWorld().clearanceBeamCount()
  })
  expect(beams).toBe(2) // the tunnel's two portals

  // Let the simulation run: the car has to cover ~30 m, the bus ~80 m
  // before it meets the portal.
  await page.waitForTimeout(16_000)

  const state = await page.evaluate(() => {
    const w = (
      window as unknown as {
        __world: {
          network: {
            vehicles: Record<
              string,
              { position: { z: number }; speed: number; status: string; s: number }
            >
          }
        }
      }
    ).__world
    const bus = w.network.vehicles['v-bus']
    const car = w.network.vehicles['v-car']
    return {
      bus: bus ? { z: bus.position.z, speed: bus.speed, status: bus.status } : null,
      car: car ? { z: car.position.z, speed: car.speed, status: car.status } : null,
    }
  })

  expect(state.bus, 'the bus must still exist').not.toBeNull()
  expect(state.car, 'the car must still exist').not.toBeNull()

  // The bus's NOSE stops at the portal. The bus is 9 m long, so its
  // centre stops half a length short of it (the box's front face is
  // what meets the beam).
  const busNose = state.bus!.z + 4.5
  expect(busNose).toBeLessThanOrEqual(PORTAL_Z + 0.5)
  expect(busNose).toBeGreaterThan(PORTAL_Z - 4)

  // The car drove THROUGH the portal: it is beyond it now.
  expect(state.car!.z).toBeGreaterThan(PORTAL_Z + 2)

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})

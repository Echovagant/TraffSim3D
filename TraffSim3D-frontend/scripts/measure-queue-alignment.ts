/**
 * Measure the queue lengths before/after the stop-line alignment.
 *
 * The queue window used to be the road's midpoint minus a fixed 5 m, while
 * the line the simulation actually enforces sits at the edge of the
 * intersection box. The two differed, and the difference fell on the
 * *backward* lanes: their stop line is on the far side of the junction, so
 * the old window excluded cars that were visibly queueing for it.
 *
 * This prints both numbers for every built-in scene.
 */
import { buildCorridorScene } from '@/application/services/defaultScene'
import {
  buildCrossIntersectionNetwork,
  buildElevatedScene,
  buildRectangularLoopNetwork,
  buildTJunctionNetwork,
} from '@/application/services/defaultScene'
import { getAxisQueueLength, getQueueLength } from '@/application/services/signalController'
import { roadLength, stopLineSOnRoad } from '@/domain/services/laneGeometry'
import type { RoadNetwork } from '@/domain/entities/RoadNetwork'
import { STOP_LINE_DISTANCE } from '@/shared/constants/simulation'

const report = (name: string, net: RoadNetwork): void => {
  console.log(`--- ${name} ---`)
  for (const inter of Object.values(net.intersections)) {
    for (const light of inter.trafficLights) {
      for (const road of Object.values(net.roads)) {
        if (!inter.connectedRoads.includes(road.id)) continue
        const oldWindow = roadLength(road) / 2 - STOP_LINE_DISTANCE
        const newFwd = stopLineSOnRoad(road, inter, 0)
        const newBack = stopLineSOnRoad(road, inter, road.laneCount - 1)
        console.log(
          `  ${light.id} axis=${light.axis} road=${road.id}: ` +
            `old_window=${oldWindow.toFixed(1)} ` +
            `new_stop(fwd)=${newFwd === null ? 'null' : newFwd.toFixed(1)} ` +
            `new_stop(back)=${newBack === null ? 'null' : newBack.toFixed(1)} ` +
            `axis_queue=${getAxisQueueLength(light, net)} lane_queue=${getQueueLength(light, net)}`,
        )
      }
    }
  }
}

report('cross', buildCrossIntersectionNetwork())
report('t', buildTJunctionNetwork())
report('elevated', buildElevatedScene())
report('loop', buildRectangularLoopNetwork())
report('corridor', buildCorridorScene())

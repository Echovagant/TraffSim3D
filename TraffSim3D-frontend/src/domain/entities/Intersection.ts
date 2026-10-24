import type { Position } from '../value-objects/Position'
import type { TrafficLight } from './TrafficLight'

export interface Intersection {
  readonly id: string
  position: Position
  trafficLights: TrafficLight[]
  /** Road ids that terminate at this intersection. */
  connectedRoads: string[]
  /**
   * 路口 box 半径 (m). 决定 `inIntersectionBox` 的检测范围
   * (`[centreS - radius, centreS + radius]`, `centreS` = 路口在
   * 这条路上的**投影**位置, 不是道路中点).
   *
   * 这个数**不是写死的**, 而是由车道模型推导 —— 规则在
   * `@domain/services/junctionRadius` (`junctionRadius`), 内置场景
   * 与导入地图共用的唯一出处:
   *
   *     radius = 被连接道路里最宽那条的半宽
   *              + 排队车头需要的净空 (无条件)
   *
   * - **半宽** = `laneCount * ROAD_LANE_WIDTH / 2`. box 必须装得下它
   *   连接的每一条道路的车道面, 否则最外侧车道永远不在 box 内,
   *   路口占用规则根本看不见它们 (旧版写死的 8 m 小于 6 车道道路
   *   的 10.5 m 半宽).
   * - **净空** = `INTERSECTION_CLEARANCE_M` (4.5 m = 最长车 9 m 公交的
   *   半长). 停车规则作用在**车心**上, 所以停在停止线上的车, 车头
   *   可以合法地越过停止线最多半个车长; 没有这段净空, 车头就会伸进
   *   被穿越道路的车道面, 对向来车直接撞上去.
   *
   * 净空**无条件**适用: 前端在**每个**路口的 box 沿都画停止线, 且让行
   * 规则可以在任何路口前把车停下, 所以每个路口都会排队 —— 有没有红绿灯
   * 与此无关.
   *
   * 内置场景的取值: cross 15 m (6 车道) / t 11.5 m (4 车道) /
   * elevated 地面路口 11.5 m、匝道端点 11.5 m / corridor 11.5 m /
   * loop 四角 8.5 m (转弯包络, 见 `cornerRadius`). 导入地图的每个路口
   * 走同一个函数.
   */
  intersectionRadius: number
}

import type { Position } from '../value-objects/Position';
import type { TrafficLight } from './TrafficLight';

export interface Intersection {
  readonly id: string;
  position: Position;
  trafficLights: TrafficLight[];
  /** Road ids that terminate at this intersection. */
  connectedRoads: string[];
  /**
   * Plan 035: 路口 box 半径 (m). 决定 `inIntersectionBox` 检测范围
   * (`[mid - radius, mid + radius]`). 默认 8.
   *
   * - 4-way 十字路口: 8 (覆盖 stop line ± STOP_LINE_DISTANCE = 5,
   *   余 3m 安全区).
   * - T 路口: 6 (3-way box 比 4-way 略小).
   * - corner intersection (矩形环 4 角): 4 (corner road 不进
   *   connectedRoads, 但 corner intersection 自身仍需 box 容纳转弯
   *   中的车).
   *
   * 直角转弯 road 本身不进任何 intersection.connectedRoads, 所以
   * 不会被 inIntersectionBox 触发. 见 ADR-008.
   */
  intersectionRadius: number;
}
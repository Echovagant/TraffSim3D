import type { Position } from '../value-objects/Position';

export interface Road {
  readonly id: string;
  /**
   * 2-point road 起点. 当 `waypoints` 不存在或长度为 2 时, 等于 waypoints[0].
   * 保留字段以兼容 M1/M2 老 scene 序列化.
   */
  startNode: Position;
  /**
   * 2-point road 终点. 当 `waypoints` 不存在或长度为 2 时, 等于 waypoints[N-1].
   * 保留字段以兼容 M1/M2 老 scene 序列化.
   */
  endNode: Position;
  /**
   * Plan 035: 可选 polyline waypoints. 长度 ≥ 2; data invariant:
   * `waypoints[0] === startNode` 且 `waypoints[N-1] === endNode`.
   *
   * - 不存在或长度 = 2: 几何走直线 (M1/M2 老行为, laneGeometry 把 [startNode, endNode]
   *   当 2-point polyline 处理, 数学上等价旧公式).
   * - 长度 ≥ 3: 几何沿 polyline 弧长参数化; lanePoint / roadForward(s) /
   *   roadRight(s) / worldToLaneS / RoadMarkings 全基于 polyline 推导.
   *
   * 见 ADR-008.
   */
  waypoints?: Position[];
  laneCount: number;
  /** Speed limit in m/s. */
  speedLimit: number;
}
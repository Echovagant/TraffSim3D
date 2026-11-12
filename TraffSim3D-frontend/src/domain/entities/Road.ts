import type { Position } from '../value-objects/Position'

export interface Road {
  readonly id: string
  /**
   * 2-point road 起点. 当 `waypoints` 不存在或长度为 2 时, 等于 waypoints[0].
   * 保留字段以兼容老 scene 序列化.
   */
  startNode: Position
  /**
   * 2-point road 终点. 当 `waypoints` 不存在或长度为 2 时, 等于 waypoints[N-1].
   * 保留字段以兼容老 scene 序列化.
   */
  endNode: Position
  /**
   * 可选 polyline waypoints. 长度 ≥ 2; data invariant:
   * `waypoints[0] === startNode` 且 `waypoints[N-1] === endNode`.
   *
   * - 不存在或长度 = 2: 几何走直线 (老行为, laneGeometry 把 [startNode, endNode]
   *   当 2-point polyline 处理, 数学上等价旧公式).
   * - 长度 ≥ 3: 几何沿 polyline 弧长参数化; lanePoint / roadForward(s) /
   *   roadRight(s) / worldToLaneS / RoadMarkings 全基于 polyline 推导.
   *
   *
   */
  waypoints?: Position[]
  laneCount: number
  /** Speed limit in m/s. */
  speedLimit: number
  /**
   * 道路高程标签 (整数米). Polyline waypoints 的 Y 起点
   * 应等于 level × LEVEL_HEIGHT (4m), ramp 段 waypoints 的 Y 自然渐变.
   * 默认 0 — 老 scene 序列化无此字段, sceneSerializer.deserialize
   * 缺字段时填 0.
   */
  level: number
  /**
   * Whether the road is one-way (traffic may only travel along it).
   *
   * The OSM parser emits this for every road it parses — the `oneway`
   * tag, with `junction=roundabout` implying it when the tag is absent
   * (see `app/apps/maps/osm_parser.py`). It used to be dropped on the
   * way in, so a one-way street in an imported map came back as a
   * two-way one and traffic could drive against it.
   *
   * `undefined` means "not stated" — every road of the built-in scenes
   * and every scene saved before this field existed. The simulation reads
   * that as two-way, so the default behaviour is unchanged.
   */
  oneway?: boolean
  /**
   * The road's class, as OSM names it ("motorway", "trunk", "primary",
   * "secondary", "tertiary", "residential", "unclassified", "service",
   * "footway", "path", …).
   *
   * The lane count and the speed limit are DERIVED from this class by
   * the parser, so keeping the class itself is what lets a renderer
   * draw the road hierarchy (a trunk must not look like a footway) and
   * lets traffic rules reason about road rights.
   *
   * `undefined` for the built-in scenes and for any scene saved before
   * this field existed — those roads carry no class.
   */
  highway?: string
  /**
   * The road's HEIGHT limit in metres, when it has one — the tunnel's
   * 3.5 m, the underpass's 4 m.
   *
   * It comes from OSM's `maxheight` tag, which the parser reads and
   * keeps as a number (`maxheight=no` and `maxheight=default` mean
   * "no limit", and are dropped). A road with a limit is not a road
   * every vehicle may use: a bus does not fit under a 3.5 m tunnel,
   * and the simulation has to know that.
   *
   * `undefined` means no limit — every built-in scene, and every road
   * whose `maxheight` says there is none.
   */
  maxHeightM?: number
}

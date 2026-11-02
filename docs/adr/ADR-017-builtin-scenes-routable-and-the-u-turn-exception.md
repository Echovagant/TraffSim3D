# ADR-017: 内置场景可规划路线 —— 道路带折线点，掉头是显式特例

- **Status**: ✅ **Accepted** (2026-11-02)
- **Date**: 2026-11-02
- **Deciders**: Project lead（路线闭环的场景覆盖、掉头的处理）
- **Relates to**: [ADR-016](ADR-016-driving-to-a-point-of-interest.md)（POI 作为目的地）·
  [ADR-010](ADR-010-route-planning-and-the-first-person-camera.md)（路线规划与第一人称相机）

---

## Context

路线规划只在 **grid** 场景上可用。内置的**十字场景**（默认场景）报「没有一条路能
开到那个兴趣点」——不是规划器的问题，是场景本身的几何：

- 场景的道路只有 `startNode`/`endNode` 两个点，**没有折线点**；
- 十字场景的四条臂都**穿过**中心路口，而中心既不是任何一条臂的端点、也不是折线点
  ⇒ 四条臂在路线图里**没有共享节点** ⇒ 图是四条互不相连的线 ⇒ A\* 找不到路。

（grid 场景一直没这个问题：它每条路的**端点就是路口**。）

修法是把「道路穿过的路口」补成该道路的折线点——几何上那个点本来就在这条线上，
所以**什么都不会动**，只是让两侧的道路在路口共享一个节点。

修的过程中暴露出第二个问题：**折线长度按 Road 对象缓存**（`laneGeometry` 的
WeakMap）。场景构建时先算了缓存，随后又就地改写 `waypoints` ⇒ 缓存陈旧 ⇒
投影读到旧几何：`worldToCenterlineS(0, 0)` 回答 **s = 60**（路的末端）而不是 30
（路口）⇒ 路口盒整个挪到路尾，停止线跟着跑。

## Decision

**内置场景的道路带上它穿过的路口点**（`addIntersectionWaypoints`，八个场景构建器
收尾时统一调用）：把每个路口**投影到道路折线上**，距离 < 0.5 m 就插入它的
位置；插入的是**内部点**，所以 `waypoints[0] === startNode` /
`waypoints[N-1] === endNode` 的不变量保持。每条被改写的道路**同时清掉折线长度缓存**
（新增 `invalidateRoadPolylineCache`）。

**掉头是显式特例**。规划器默认禁止「首段 = 车当前所在的路」——车已经承诺要开到
这条路的末端，首段再是这条路就是它在即将到达的路口掉头。但**目的地在司机自己
那条路上、而且在它身后**时，除了开到末端掉头回来没有别的路：

- 浏览器先判断「同一条路 + 在身后」（`poiAheadOrBehind`：比较吸附到的方向与车
  实际行驶方向）；
- 命中时给规划器传 `allow_u_turn: true`，并让路线保留那条路的重复项
  （`plannedRouteFrom(..., { keepFirstRoad: true })`）——否则前端把重复的路过滤掉，
  掉头那一段就丢了，车会在路的末端卡住。

**到达 = 停在目的地**。路线止于「那条路的末端节点」，而 POI 可能在路中间 ⇒
到达判定是距离（≤ 20 m），车经过时触发；触发后**把跟车的速度钉到 0**——否则车
会开过目的地继续开到路端，那不是「到达」的意思。

## Consequences

- **内置场景现在都能规划路线**：十字场景的 POI（哪怕在司机身后）能规划出来
  （实测：roads `["r-ns","r-ns","r-ns"]`、60 m、剩余 14 m）。
- **既有测试暴露了一个真 bug**：折线长度缓存与就地改写不兼容 ⇒ 新增
  `invalidateRoadPolylineCache`。修前：十字场景的路口盒、停止线、物理都偏了
  （`tick.stopLine` / `tick.physics` / `intersectionGeometry` / `signalTimeline`
  六个测试失败）；修后全绿。
- **掉头只发生在「目的地在自己路上且在身后」**：这是用户裁定的「极为特殊的情况」。
  路口本身是否允许掉头是**场景的事**——规划器不判断，它只是不再禁止首段。
- **到达会停在路中间**：跟车停在目的地所在的车道上（真实导航也是停在目的地）。
  到达后清掉目的地（`clearPoiDestination`）会解除钉子。
- **第一人称的三处打磨**（同一轮）：目的地标记更大更亮（`DESTINATION_MARKER_SCALE`
  = 1.6，T·S 乘法）；相机**缓入**第一人称而不是瞬移——40 帧的缓出（≈0.7 s）后
  **精确跟随眼位**（用永不收敛的 lerp 会让画面永远滞后，既有 e2e 断言眼位、当场
  变红）；到达时车停住。
- **踩坑（Three 0.180）**：`Matrix4.makeTranslation` 之后调 `matrix.scale(...)`
  会把旋转部分**清零**（实测：实例矩阵上三行全 0，柱子被压扁）；正确写法是
  `makeScale` 到**另一个矩阵**再 `multiply`（T·S）。

## Alternatives considered

- **只改 grid 场景**：那只是把问题藏起来，内置场景依然不能规划 ⇒ 拒绝。
- **给后端加「坐标终点」**：浏览器的几何已经够（一条路 + 一个方向），不必改
  图与吸附规则 ⇒ 拒绝（与 ADR-016 同理）。
- **让规划器自己判断「该不该允许掉头」**：它没有路口的通行规则（哪些方向允许
  掉头是场景数据）⇒ 拒绝；由调用方（知道目的地与车的关系的那一方）显式要求。
- **到达后继续开到路端**：那不是到达 ⇒ 拒绝（已改为停住）。

## Related

- `docs/ARCHITECTURE.md` §5.5 —— 交付面：路线规划与第一人称相机
- `src/application/services/defaultScene.ts`（`addIntersectionWaypoints`）·
  `src/domain/services/laneGeometry.ts`（缓存与失效）·
  `app/api/v1/routes.py`（`allow_u_turn`）·
  `src/application/services/poiNavigation.ts` ·
  `src/interfaces/stores/worldStore.ts`（到达与停车）·
  `src/infrastructure/rendering/PoiLayer.ts`（目的地标记）·
  `src/infrastructure/rendering/ThreeJSRenderer.ts`（相机缓入）
- `tests/test_maps_routes_api.py` · `src/application/services/defaultScene.spec.ts` ·
  `src/application/services/poiNavigation.spec.ts` · `tests/e2e/poi-navigation.spec.ts`

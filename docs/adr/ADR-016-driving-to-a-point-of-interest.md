# ADR-016: 兴趣点作为目的地 —— 选一个地方，开过去

- **Status**: ✅ **Accepted** (2026-11-02)
- **Date**: 2026-11-02
- **Deciders**: Project lead（POI 闭环与第一人称体验）
- **Relates to**: [ADR-010](ADR-010-route-planning-and-the-first-person-camera.md)（路线规划与第一人称相机）·
  [ADR-013](ADR-013-poi-as-a-navigation-destination.md)（POI 作为 RL 任务的目的地）·
  [ADR-014](ADR-014-poi-source-openstreetmap-instead-of-a-keyed-provider.md)（POI 的来源）

---

## Context

POI 已经有了两个身份：产品侧的真实地点（ADR-014：OpenStreetMap，零 Key）
和训练侧的任务目的地（ADR-013：合成 POI，进观测 33 维）。缺的第三件事是
**中间那一段**：人在场景编辑器里看到「这家咖啡店在这儿」，点了它，然后呢？

路线规划器（ADR-010）已经能规划并开完一条到**路口**的路线，第一人称相机
也能坐进车里。但 POI 没法直接交给它——规划器只认**路口**或**某条路的方向性
末端**，而 POI 是**路边的一个地点**：它没有节点，也没有方向。

## Decision

**POI 可以当目的地**：面板里选一个 POI ⇒ 点「开过去（第一人称）」⇒ 场景里
的第一辆车被规划到那儿，第一人称相机打开，车一路开过去，到达时给出提示。

三条支撑规则：

1. **浏览器做那一步几何**：POI 挨着哪条路、往哪一头
   （`poiNavigation.ts`）。线离 POI 最近的那条路赢；方向取**离 POI 更近的
   那一头**——规划器把「路的方向性末端」解析成**车到达的那个节点**，走错
   方向就会停在整条街的另一端。
   **两条路的形态都要认**：内置场景的道路**没有 `waypoints`**（只有
   `startNode`/`endNode`），只认 waypoints 的第一版在一个「除了路什么都有」
   的场景上找不到任何路（报「这个兴趣点附近没有道路」）。
2. **到达是距离**：路线止于那条路的末端节点，而 POI 可能在路中间 ⇒ 判定是
   「车离 POI ≤ 20 m」（路缘到车道的横向差约 5 m，20 m 留足余量）。车开着
   开着经过 POI，途中就触发。
3. **仪表盘说人话**：目标（POI 名）、速度、**还剩多少米**、**下一步动作**
   （直行 / 左转 / 右转 / 掉头，由路线折线两段方向的角度算出）。路名
   （`r-ew-0-240.4`）对司机没有意义——但仍留在 `title` 里。

## Consequences

- **闭环成立**：真实 POI（零 Key）→ 目的地 → 路线 → 第一人称 → 到达。
  实测（grid 场景、4× 仿真）：路线 3 段 / 240 m、跟车 v-g1、剩余距离
  292 m → 20 m ⇒「已到达」。
- **只能开场景里有路的场景**：内置的**十字场景的道路没有 waypoints**，它的
  路线图里各臂在路口**不相连** ⇒ 规划器诚实地回答「没有路」。所以闭环在
  **grid 场景**上成立（它的道路带 waypoints）。这不是新缺陷，是既有事实
  （路线规划 e2e 一直用 grid 场景）。
- **POI 不能放在司机自己那条路上**：规划器**禁止**路线以车当前所在的路开头
  （那会是它在即将到达的路口掉头），所以那样的 POI 会让车绕一整圈街区——
  实测行程时间**翻倍**。
- **第一人称的两个视觉缺陷被顺手修掉**：① 顶部调试条是绝对定位、宽度由内容
  决定 ⇒ 一长串「车道分布」把它撑到 **1 268 px**（横跨整个屏幕、压在路线
  面板上）；现在 `max-width: 340px` + 省略号。② 面板与 HUD 的层次。
- **到达半径 20 m** 比 RL 任务的 10 m 宽：RL 里车要停在 POI 旁边，这里车
  只要**经过**它。

## Alternatives considered

- **给后端加「坐标终点」**：路线规划器就会多一种寻址方式（要改图、要定
  吸附规则）。浏览器的几何已经够（一条直线 vs 一条路 + 一个方向）⇒ 拒绝。
- **把 POI 变成路网里的节点**：那会把 POI 混进路网，污染图（每个 POI 一条
  stub）⇒ 拒绝（与 ADR-013 同理）。
- **到达 = 路线走完**：路线止于路的末端节点，POI 在路中间 ⇒ 会「走过了但
  没算到达」⇒ 拒绝。
- **只显示路名，不给转向提示**：那是给工程师看的，不是给司机看的 ⇒ 拒绝。

## Related

- `docs/ARCHITECTURE.md` §5.5 —— 交付面：路线规划与第一人称相机
- `src/application/services/poiNavigation.ts`（几何）·
  `src/application/services/routePlanner.ts`（转向提示）·
  `src/interfaces/stores/worldStore.ts`（`planRouteToPoi` 与到达判定）·
  `src/interfaces/components/editor/PoiPanel.vue`（入口）·
  `src/interfaces/components/editor/RoutePanel.vue`（仪表盘）
- `tests/e2e/poi-navigation.spec.ts` · `src/application/services/poiNavigation.spec.ts`

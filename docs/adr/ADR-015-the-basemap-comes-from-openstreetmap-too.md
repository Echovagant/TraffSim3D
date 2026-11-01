# ADR-015: 底图也换成 OpenStreetMap —— 底图与路网必须同源同基准

- **Status**: ✅ **Accepted** (2026-11-01)
- **Date**: 2026-11-01
- **Deciders**: Project lead（底图与 POI 用同一个数据源）
- **Relates to**: [ADR-014](ADR-014-poi-source-openstreetmap-instead-of-a-keyed-provider.md)（POI 换源到 OSM）·
  [ADR-006](ADR-006-map-data-osm-graph.md)（OSM → 内部图）

---

## Context

Smart City 视图的底图用**高德瓦片**（`webrd0{s}.is.autonavi.com`，无需 Key），
而视图里叠加的路网折线与拉伸建筑来自 **OSM**（Overpass）。两者的基准不同：

| | 基准 | 同一坐标在场景里的位置 |
|---|---|---|
| 路网折线 / 建筑 | WGS84 | 真值 |
| 高德底图瓦片 | **GCJ-02**（火星坐标） | 偏出去 |

实测偏出的量级（用项目自己的 `coord_transform` 算）：

| 地点 | dlat | dlon | 东 | 南 | \|d\| |
|---|---|---|---|---|---|
| 福田中心（项目原点） | −0.00271° | +0.00512° | **+525 m** | **−301 m** | **605 m** |
| 天安门（Smart City 默认锚点） | +0.00140° | +0.00624° | +531 m | +156 m | 554 m |
| 上海人民广场 | −0.00194° | +0.00452° | +429 m | −216 m | 480 m |

同一批道路折线画在底图上时整体错开**半公里**——A/B 截图里，高德底图下画面
中心是**人民大会堂**（天安门以西约 700 m）而 OSM 折线落在天安门广场西侧；
OSM 底图下画面中心正是**天安门**，折线贴着底图的道路走。

另一个事实：POI 已经换成了 OSM（ADR-014）。底图与 POI 分属两个源、两个基准，
本身就自相矛盾。

## Decision

**底图也用 OpenStreetMap 的瓦片**（社区镜像 `tile.openstreetmap.de`，a/b/c 三个
子域）——和路网**同源、同基准（WGS84）**，对齐由构造保证，不需要任何偏移修正。

三条支撑规则：

1. **同源 ⇒ 对齐是构造出来的，不是算出来的**。底图上的道路与叠加的 OSM 折线
   是同一份数据，永远重合。
2. **署名必须在画面上**。OSM 的数据是 **ODbL**，OSMF 的瓦片政策也要求应用自报
   身份 ⇒ 影像层的 credit 是 `© OpenStreetMap contributors`（屏上显示）。
3. **镜像，不是官方主机**。`tile.openstreetmap.org` 在本网络**不通**
   （实测 21 s 连接超时），社区镜像 `tile.openstreetmap.de` 的三个子域都通
   （0.9–4.3 s）；官方 Carto 也不通（23 s 超时）。

**并且修掉挡住底图的那个既有缺陷**：渲染器用 `alpha: true` +
`setClearColor(0x000000, 0)` 把画布清成透明，但 Three.js 会**先铺满
`scene.background`**（0x0b1220）——透明清屏救不了它，于是整个 Cesium 底图
一直被挡在仿真图层下面（实测：隐藏 Three.js 画布，底图立刻完整出现）。
修法是 `ThreeJSRenderer.setTransparentBackground(true)`（`scene.background = null`），
**只在 Smart City 视图里开**——场景编辑器要的就是那个深色背景。

## Consequences

- **对齐问题消失**：半公里的错位没有了，因为两边是同一份数据。
- **底图第一次真的能被看见**：修掉背景遮挡之前，Smart City 视图里 Cesium 的
  底图始终被仿真画布挡着（那是一个 3D 底图模块）。
- **代价是加载慢**：镜像每张瓦片 1–4 s，Cesium 的 LOD 链从 z1 铺到 z16 实测
  **约 90 s** 才铺满（高德瓦片 1.5 s/张，但错位）。底图是渐进出现的。
- **底图的中文标注**：OSM 的 `name` 在中国城市多是中文（实测天安门一带
  「天安门东 / 故宫 / 景山公园 / 北海公园」都有），但覆盖面不如高德。
- **`positionCartographic` 是弧度**：Cesium 的相机读数返回**弧度**（不是度数），
  排查时差点因此误判「相机跑到了几内亚湾」（2.03 rad = 116.4°）。
- **未解**：底图与 POI 现在同源了，但 POI 仍是**点状要素**（node）——OSM 里
  多边形 POI（校区、商圈）不画。

## Update (2026-11-01 晚：换城市 + 瓦片预取)

两件事，都是实测驱动的：

1. **Smart City 的默认城市换成深圳福田**（原点 114.06865, 22.54297 —— 项目
   自己的那份 `geojson/福田中心(深圳).osm` 的**质心**，实测 51 715 nodes 的
   中心点）。原来的天安门是个跟数据无关的占位锚点；换成深圳之后，Smart City
   视图、POI 图层、导入的地图讲的是**同一个地方**。底图实测：新田社区 /
   Xintian、田面社区 / Tianmian、岗厦北 / Gangxia North、深圳大道 /
   Shenzhen Blvd.（中英双语标注）。
2. **瓦片首屏从 90–190 s 降到 7.7 s**——不动任何 Cesium 质量参数。
   Cesium 的四叉树是**自上而下逐级**走的（子瓦片要等父瓦片），一个离地
   1 500 m 的相机要串行走 **15 级**（z1 → z16）；实测每级一次往返 + 处理，
   整条链 90–190 s。**祖先瓦片很小**（约 25 张、每张几 kB），所以浏览器
   **并行**把它们先抓进 HTTP 缓存（`tilePrefetch.ts`），Cesium 再要时就是
   缓存命中 ⇒ 链只剩处理时间。**首张 z16 瓦片：90–190 s → 7.7 s**。

   两个坑：① **相机高度不是缩放级别**——第一版把 1 500 m 当成 z，一次
   请求 **1 501 张**瓦片，浏览器直接 `ERR_INSUFFICIENT_RESOURCES`、**一张都
   没加载**；现在按「每像素多少米」换算缩放级别（`tileZoomForHeight`）。
   ② 预取必须**限并发**（6 路），一百个并行请求就是另一种资源耗尽。

   **换镜像不解决问题**（实测）：`tile.openstreetmap.de` 中位 **996 ms**、
   `a.tile.openstreetmap.fr/osmfr` 中位 **764 ms**（但长尾 5.3 s 更差）、
   官方主机与 Carto 在本网络**不通**。换镜像只快 23 %，而链的深度才是瓶颈。

## Alternatives considered

- **保留高德瓦片 + 给 Cesium 加 GCJ 偏移**：Cesium 的影像层支持 `offset`，
  可以在原点处补上那 525 m / 301 m。但那个偏移**随位置变化**（三地实测
  480–605 m），一个常数只是近似；而且底图与 POI 仍是两个源、两个基准 ⇒ 拒绝。
- **换天地图的瓦片**：官方、免费（无偿使用制度）、CGCS2000≈WGS84（对齐也没
  问题），国内访问稳。但要注册申请 Key——本项目的决定是**不申请任何商业/需账号的
  地图 Key** ⇒ 留作将来要权威数据（带审图号）时的选项。
- **什么都不换，只把偏移写进文档**：底图与路网差半公里是可见的错误 ⇒ 拒绝。

## Related

- `docs/ARCHITECTURE.md` §7 —— 地图（OSM）管线
- `src/infrastructure/cesium/viewer.ts`（瓦片与署名）·
  `src/infrastructure/rendering/ThreeJSRenderer.ts`（透明背景）·
  `src/interfaces/views/SmartCityView.vue`（打开透明背景）
- `src/infrastructure/cesium/viewer.spec.ts` ·
  `src/infrastructure/rendering/ThreeJSRenderer.spec.ts` ·
  `tests/e2e/smart-city.spec.ts`

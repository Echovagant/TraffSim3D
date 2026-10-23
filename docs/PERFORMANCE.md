# 性能基准报告

TraffSim3D 前端的帧率基准：不同车流规模下的真实帧率、测量方法、以及**怎么复现**。

本报告只写**实测到的数字**。每个数字都带复现命令、测量环境与日期；凡是没有实测
支撑的，本文不写。

---

## 1. 一句话结论

在 12 辆车（内置场景的最大容量）下，前端在**软件光栅**（headless Chromium 的
SwiftShader）下实测**平均 37.1 FPS**，最差帧间隔 **50.1 ms**（≈ 20 FPS），
最快 60.2 FPS。4 辆 / 8 辆 / 12 辆三档的差异在测量噪声之内 —— **这个规模区间
里，瓶颈不是车流**。

> ⚠ **这些数字是悲观下界。** headless Chromium 默认用 SwiftShader 软件光栅化
> WebGL，**完全不用 GPU**。真实带 GPU 的机器上只会更快。报告里的每个数字都必须
> 带着这句读，不要把软件光栅的数当成硬件上限。

---

## 2. 测量方法

### 2.1 测的是 rAF 节奏，不是 `store.fps`

这一步是本报告最关键的方法学决定。

前端调试面板上显示的 `fps` 读数来自 `src/interfaces/stores/worldStore.ts` 的
`step()`：

```ts
const clampedDt = Math.max(0, Math.min(dt, MAX_PHYSICS_FRAME_DT))
// ...
frameCount += 1
fpsAcc += clampedDt
fps.value = fpsAcc > 0 ? Math.round(frameCount / fpsAcc) : 0
```

`dt` 被**钳位**后才参与帧率计算。钳位对本项目的物理稳定性是必要的（一次卡顿
不能把物理推进一大步），但它同时意味着：**`store.fps` 读不出「比钳位上限更慢」
的帧率**。拿它当性能读数，测到的是钳位值，不是真实帧率。

所以本报告的**主指标**是 **rAF 回调间隔**：`requestAnimationFrame` 相邻两次回调
之间的时间差，由浏览器自己给出，与仿真内部的 dt 钳位无关。脚本同时记录
`store.fps`，但只作为对照。

两个数字在报告里都给出，是因为它们回答的是不同的问题：
`store.fps` 回答「仿真自己以为跑多快」，rAF 回答「屏幕实际上刷新多快」。

### 2.2 脚本

`TraffSim3D-frontend/scripts/measure-fps.mjs`。它会：

1. 打开 `/scene-editor`（必须直接进这个路由 —— 下面的工具栏选择器只存在于
   场景编辑器视图里）；
2. 等仿真就绪（`window.__world` 上有车）；
3. 切到容量最大的内置场景 `loop`（实测容量：cross 8 / t 7 / **loop 12** /
   elevated 6 / corridor 8）；
4. **精确**把车数调到目标值：不够就加，多了就减；
5. 预热 5 s，采样 20 s（每 500 ms 记一次 `store.fps`），同时全程记录 rAF 间隔；
6. 把原始数据写到 `e2e-output/perf/fps-<n>.json`（含每个采样点，可人工复核）。

### 2.3 复现命令

```powershell
# 1) 起前端（5188 是独立端口；5173 属于本机其它项目，不要用）
cd TraffSim3D-frontend
npm run dev -- --port 5188

# 2) 测帧率曲线（三档各跑一次）
node scripts/measure-fps.mjs --vehicles 4
node scripts/measure-fps.mjs --vehicles 8
node scripts/measure-fps.mjs --vehicles 12
```

输出示例：

```
[perf] renderer=ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) vehicles=12
 TRUE fps min/avg/max=20/37.1/60.2 frameDelta=30.2ms storeFps=33.05 load=77% -> ...\e2e-output\perf\fps-12.json
```

> `e2e-output/perf/` 在 `.gitignore` 里 —— 原始采样数据是**本机产物**，不进仓库；
> 仓库里留下的是这份报告（数字 + 方法 + 复现命令）。

---

## 3. 实测结果

**测量日期：2026-10-23。**

| 项 | 值 |
|---|---|
| 渲染器 | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` |
| 浏览器 | headless Chromium（Playwright 自带），1280×800，deviceScaleFactor 1 |
| 机器 | 13th Gen Intel(R) Core(TM) i7-13620H，16 逻辑核，15.73 GB 内存 |
| 操作系统 | Windows 11（10.0.26100） |
| 场景 | `loop`（内置场景中容量最大） |
| 采样 | 预热 5 s + 采样 20 s，rAF 全程记录 |

### 3.1 帧率曲线

| 车数 | rAF 帧率 min / **avg** / max | rAF 帧间隔 min / avg / max | `store.fps` min / avg / max | 采样时 CPU 占用 |
|---|---|---|---|---|
| 4  | 20 / **37.4** / 60.6 | 16.5 / 30.1 / 50.1 ms | 31 / 33.3 / 38 | 73 % |
| 8  | 20 / **37.5** / 60.6 | 16.5 / 29.7 / 50.1 ms | 31 / 33.7 / 40 | 80 % |
| 12 | 20 / **37.1** / 60.2 | 16.6 / 30.2 / 50.1 ms | 30 / 33.1 / 36 | 77 % |

### 3.2 三条结论

1. **12 辆车没有掉帧。** 从 4 辆到 12 辆，平均帧率只从 37.4 变到 37.1 —— **在
   测量噪声之内**。这个规模区间里，**瓶颈不是车流**。
2. **最差帧间隔是 50.1 ms（≈ 20 FPS），三档完全一样。** 它不随车数变化 ⇒ 这是
   环境噪声（操作系统调度、GC、软件光栅的批次抖动），不是场景负载。
3. **`store.fps` 明显高于 rAF 实测值**（33 vs 37 avg，min 30 vs 20）。这正是
   §2.1 说的钳位效应：`store.fps` 把慢帧的 dt 钳到上限，于是低估了帧间隔、
   高估了帧率。**用它单独判断性能会得出偏乐观的结论。**

### 3.3 机器负载是必须一起读的数字

「CPU 占用」列是**采样窗口内全部 16 个逻辑核的忙碌比例**（含本测量自身）。
本次测量时机器在 73–80 % —— 上面还有别的任务在跑（另一个项目的音频转写作业、
浏览器、桌面应用）。

这意味着：**上表的帧率是「在这台忙着的机器上」读到的**，比机器空闲时更悲观。
这是有意的：宁可给一个偏低的数，也不要给一个只在「恰好没人用电脑时」才成立的数。
同一台机器上重复测两轮，三档的均值波动在 ±1 FPS 以内。

---

## 4. 一条历史读数的更正

仓库早先记录过一组帧率数字（12 辆车 avg 35.0 / min 30），它是用 `store.fps`
测的。**那组数字里的 `min 30` 不是一个测出来的下界** —— 它是 dt 钳位（`1/30`
秒）的算术下限：仿真慢于 30 FPS 时，`store.fps` 依然会报 30。

用 rAF 重测，同样的场景下真实的最差帧间隔是 50.1 ms（≈ 20 FPS）。**「min 30」
这个说法当时测不出来**，它是被钳位制造出来的。

这不是说当时的性能结论是错的 —— 33–37 FPS 的平均值说明当时确实是流畅的。
错的是**那个下界的说法**：它声称「最差也有 30 FPS」，而实测最差是 20 FPS。

本报告不用 `store.fps` 下性能结论，原因就在这里。

---

## 5. 已知边界

| 边界 | 说明 |
|---|---|
| **软件光栅** | 全部数字来自 headless Chromium 的 SwiftShader，**没有用 GPU**。真实硬件上的帧率**高于**这些数。这让读数成为**悲观下界**，但也意味着**不能用这些数推断真实硬件上的体验**。 |
| **本机负载** | 测量时机器 73–80 % 忙碌。数字偏悲观，且不是「独占机器」的数。 |
| **只有 12 辆车** | 内置场景的最大容量就是 12（`spawnVehicle` 车道满即拒绝）。**20 辆车这个规模在当前场景里不可达**，本报告没有也不编造那个点的数字。 |
| **只有一个分辨率** | 1280×800。更高分辨率下软件光栅的耗时线性增加，真机会更不一样。 |
| **场景只有 `loop`** | 其余内置场景容量更小（6–8 辆），没有单独列。 |
| **浏览器内单场景** | 不含 Cesium 底图（`/smart-city` 视图）的开销 —— 那条路径的渲染负载完全不同，本报告不覆盖。 |
| **不含后端** | 纯前端渲染基准。后端训练、权重导出等不在此列。 |
| **帧率不是全部** | 帧率只说明「画面刷新多快」。仿真步进是否跟得上、策略推理是否阻塞，都要看别的指标。 |

---

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `TraffSim3D-frontend/scripts/measure-fps.mjs` | 测量脚本（本报告的产出方式） |
| `TraffSim3D-frontend/src/interfaces/stores/worldStore.ts` | `store.fps` 的来源与 dt 钳位所在 |
| `TraffSim3D-frontend/src/shared/constants/simulation.ts` | `MAX_PHYSICS_FRAME_DT`（钳位上限） |
| `e2e-output/perf/fps-<n>.json` | 原始采样数据（本机产物，不入仓库） |
| `TraffSim3D-frontend/tests/e2e/m1-perf-gate.spec.ts` | e2e 里的帧率测量（同一套 dev hook） |

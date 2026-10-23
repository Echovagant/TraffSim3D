# 性能基准报告

TraffSim3D 前端的帧率基准：不同车流规模下的真实帧率、测量方法、以及**怎么复现**。

本报告只写**实测到的数字**。每个数字都带复现命令、测量环境与日期；凡是没有实测
支撑的，本文不写。

---

## 1. 一句话结论

**真机 GPU 上，12 辆车（内置场景的最大容量）实测持续 164.7 FPS**（rAF 帧间隔
中位数 **6.1 ms**），**30 FPS 目标达成**，余量约 5.5 倍。

同一台机器、同一个场景、同一套脚本，headless Chromium（SwiftShader 软件光栅）实测
持续 **28.2 FPS** —— 那是**悲观下界**，不是硬件性能。

| 环境 | 渲染器字符串（实测原文） | 12 车持续帧率 | 帧间隔 p50 | 30 FPS 目标 |
|---|---|---|---|---|
| **真机 GPU**（headed Chromium） | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11)` | **164.7 FPS** | 6.1 ms | **达成** —— 门禁在这个环境里**断言** |
| 软件光栅（headless，即 CI 环境） | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` | 28.2 FPS | 33.3 ms | 不适用 —— 门禁在这里**只报不断言** |

> ⚠ **两种环境的数字不能混着读。** headless Chromium 默认用 SwiftShader 软件光栅化
> WebGL，**完全不用 GPU**；它的读数只有真机 GPU 的约 1/6。真实带 GPU 的机器上
> 只快不慢。

---

## 2. 测量方法

### 2.1 测的是 rAF 节奏，不是 `store.fps`

这一步是本报告最关键的方法学决定。

前端调试面板上显示的 `fps` 读数来自 `src/interfaces/stores/worldStore.ts` 的
`step()`。它**曾经**是用被钳位的 `dt` 算的：

```ts
const clampedDt = Math.max(0, Math.min(dt, MAX_PHYSICS_FRAME_DT))
// ...
frameCount += 1
fpsAcc += clampedDt
fps.value = fpsAcc > 0 ? Math.round(frameCount / fpsAcc) : 0
```

`dt` 被**钳位**后才参与帧率计算。钳位对本项目的物理稳定性是必要的（一次卡顿
不能把物理推进一大步），但它同时意味着：**当时的 `store.fps` 读不出「比钳位上限
更慢」的帧率**。拿它当性能读数，测到的是钳位值，不是真实帧率。

> **2026-10-24 更正**：上面的代码是**历史**实现，**现在已经不是这样了**。
> `worldStore.ts` 改成按**墙钟帧间隔**统计（`performance.now()` 的相邻差值，
> 绕开钳位的 `dt`），所以 `store.fps` 现在是能低于 30 的诚实读数。
> 本报告**仍然**以 rAF 为主指标，理由不变 —— rAF 是浏览器自己给出的渲染节奏，
> 不依赖 store 的任何簿记，是更独立的一手证据。`store.fps` 保留为**交叉验证**：
> 两套独立算法给出的数一致，才说明读数是真的。

所以本报告的**主指标**是 **rAF 回调间隔**：`requestAnimationFrame` 相邻两次回调
之间的时间差，由浏览器自己给出，与仿真内部的 dt 钳位无关。脚本同时记录
`store.fps`，但只作为对照。

两个数字在报告里都给出，是因为它们回答的是不同的问题：
`store.fps` 回答「仿真自己以为跑多快」，rAF 回答「屏幕实际上刷新多快」。

**「持续帧率」用的是哪一种平均？** 时间加权的那一种：总帧数 ÷ 总耗时
= 1000 ÷ 平均帧间隔。**不是**瞬时帧率的算术平均（`mean(1000/Δ)`）—— 后者在
Jensen 不等式下系统性偏大。本报告引用的「持续帧率」一律是时间加权的。

### 2.2 脚本

`TraffSim3D-frontend/scripts/measure-fps.mjs`。它会：

1. 打开 `/scene-editor`（必须直接进这个路由 —— 下面的工具栏选择器只存在于
   场景编辑器视图里）；
2. 等仿真就绪（`window.__world` 上有车）；
3. 切到容量最大的内置场景 `loop`（实测容量：cross 8 / t 7 / **loop 12** /
   elevated 7 / corridor 8）；
4. **精确**把车数调到目标值：不够就加，多了就减；
5. 预热 5 s，采样 20 s（每 500 ms 记一次 `store.fps`），同时全程记录 rAF 间隔；
6. 把原始数据写到 `e2e-output/perf/fps-<n>-<mode>.json`（含每个采样点**和每一个
   rAF 帧间隔**，可人工复核；`<mode>` 是 `headless` / `headed`，两种环境的数据
   不互相覆盖）。

**两种渲染环境分开测：**

| 参数 | 浏览器 | WebGL 走哪里 | 读数含义 |
|---|---|---|---|
| 默认 | headless Chromium | SwiftShader（CPU 软件光栅） | 悲观下界。**这就是 CI 跑的环境。** |
| `--headed` | 真实浏览器窗口 | **本机 GPU**（ANGLE / D3D11） | 真实硬件。**30 FPS 目标对应的环境。** |

脚本会把**渲染器字符串**原样写进报告 JSON，并据此标注 `softwareRasterizer`。
判据来自浏览器自己报的字符串，不是启动参数 —— 所以同一个脚本在 CI 和开发者
本机都判得对，机器悄悄退回软件渲染也会被认出来。

### 2.3 复现命令

```powershell
# 1) 起前端（5188 是独立端口；5173 属于本机其它项目，不要用）
cd TraffSim3D-frontend
npm run dev -- --port 5188

# 2a) 软件光栅（headless，= CI 环境）
node scripts/measure-fps.mjs --vehicles 12

# 2b) 真机 GPU（headed）—— 30 FPS 门禁对应的那个环境
node scripts/measure-fps.mjs --vehicles 12 --headed

# 三档曲线
node scripts/measure-fps.mjs --vehicles 4  --headed
node scripts/measure-fps.mjs --vehicles 8  --headed
node scripts/measure-fps.mjs --vehicles 12 --headed
```

输出示例（软件光栅）：

```
[perf] mode=headless renderer=ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) vehicles=12 sustained=28.2 FPS (min 20.0 / max 60.2) frameDelta=35.4ms storeFps=28.53 load=95% softwareRasterizer=true -> ...\e2e-output\perf\fps-12-headless.json
```

输出示例（真机 GPU）：

```
[perf] mode=headed renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11) vehicles=12 sustained=164.7 FPS (min 41.3 / max 312.5) frameDelta=6.1ms storeFps=164.54 load=73% softwareRasterizer=false -> ...\e2e-output\perf\fps-12-headed.json
```

> `e2e-output/perf/` 在 `.gitignore` 里 —— 原始采样数据是**本机产物**，不进仓库；
> 仓库里留下的是这份报告（数字 + 方法 + 复现命令）。

### 2.4 headed 测量必须先把窗口拉到前台（Chromium 的 1 Hz 节流陷阱）

这一条是 headed 测量最容易踩的坑，**第一次真机测量就踩了**：脚本测出
**0.85 FPS**，而页面其实完全正常。

原因是 Chromium 对**被遮挡 / 失去焦点**的窗口把 `requestAnimationFrame` 降到
**精确的 1 Hz**。特征很明确：帧间隔几乎全部堆在 1000 ms 附近（实测
995–2011 ms），而页面自己仍然报 `visibilityState: 'visible'` /
`hasFocus: true` —— 也就是说**页面状态是「可见」，帧率却是 1 Hz**，这个矛盾
本身就说明是节流而不是性能问题。

处理办法（脚本与 e2e 门禁都做了）：

1. 采样前调用 `page.bringToFront()`；
2. 启动 Chromium 时带上 `--disable-backgrounding-occluded-windows` /
   `--disable-renderer-backgrounding` / `--disable-background-timer-throttling` /
   `--disable-features=CalculateNativeWinOcclusion`；
3. **识别节流签名**：若超过一半的帧间隔落在 1000 ms ± 100 ms 区间，读数标记为
   `throttled: true` —— 这是**无效读数**，不是性能结果，脚本会打印警告，
   e2e 门禁会**直接判失败**并说明原因。

判据是「帧间隔的分布形状」，不是某个阈值：真慢的页面是一段连续的间隔分布，
被节流的页面则全部挤在 1000 ms 一点上。

---

## 3. 实测结果

**测量日期：2026-10-24。**

| 项 | 真机 GPU | 软件光栅（CI 环境） |
|---|---|---|
| 渲染器 | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11)` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |
| 浏览器 | headed Chromium（Playwright 自带），1280×800，deviceScaleFactor 1 | headless Chromium（同上） |
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU，驱动 595.79，6141 MiB | **无**（CPU 软件光栅） |
| 机器 | 13th Gen Intel(R) Core(TM) i7-13620H，16 逻辑核，15.73 GB 内存 | 同左 |
| 操作系统 | Windows 11（10.0.26100） | 同左 |
| 场景 | `loop`（内置场景中容量最大） | 同左 |
| 采样 | 预热 5 s + 采样 20 s，rAF 全程记录 | 同左 |

### 3.1 真机 GPU（headed）—— 门禁要的那个数

12 辆车，`loop` 场景：

| 指标 | 值 |
|---|---|
| **持续帧率**（时间加权） | **164.7 FPS** |
| 帧间隔 p50 / p90 / p99 | 6.1 / 6.1 / 6.3 ms |
| 帧间隔 min / max | 3.2 / 24.2 ms |
| 采样帧数 | 3311 帧 / 20 s |
| **慢帧**（> 20 ms） | **1 帧**（> 50 ms 的：**0 帧**） |
| `store.fps`（交叉验证） | 164.5 —— 与 rAF 独立算法一致 |
| 采样时 CPU 占用 | 73 % |
| 30 FPS 目标 | **达成**（5.5 倍余量） |

同一配置的重复测量（四次独立跑）：**165.0 / 164.7 / 164.2 / 147.7 FPS**。
最差的那一轮（147.7）里出现过**一个**约 1 s 的孤立长帧；当时机器 CPU 占用
85 %，同期还有别的项目在跑。其余三轮没有任何一帧超过 25 ms。

**车流规模对帧成本没有影响**（同一套脚本，真机 GPU）：

| 车数 | 帧间隔 p50 | 帧间隔 p99 | 最长帧 | 持续帧率 | > 20 ms 的帧 |
|---|---|---|---|---|---|
| 4 | 6.1 ms | 6.3 ms | 18.3 ms | 165.0 FPS | 0 |
| 8 | 6.1 ms | 6.2 ms | 8.8 ms | 165.0 FPS | 0 |
| 12 | 6.1 ms | 6.3 ms | 24.2 ms | 164.7 FPS | 1 |

三档的**帧间隔中位数精确地都是 6.1 ms**，最长帧不超过 24.2 ms（3311 帧里
1 帧）。**帧成本与车数无关** —— 瓶颈不是车流，是呈现节奏。

> 8 辆那一档**第一次**测到的是 81.3 FPS，被 **10 个孤立的约 1 s 长帧**打乱了
> 时间加权平均值（帧间隔中位数仍然是 6.1 ms）。那 10 个长帧是**机器争用**
> 造成的孤立停顿，不是渲染成本 —— **重跑一轮没有复现**（165.0 FPS，零慢帧，
> 表里用的是重跑的那轮）。这也是为什么判读曲线要看**帧间隔中位数**那一列：
> 它对孤立停顿不敏感。


### 3.2 软件光栅（headless，即 CI 跑的环境）

同一台机器、同一个场景、同一套脚本：

| 指标 | 值 |
|---|---|
| **持续帧率**（时间加权） | **28.2 FPS** |
| 帧间隔 p50 / p90 / p99 | 33.3 / 50.0 / 50.1 ms |
| 帧间隔 min / max | 16.6 / 50.1 ms |
| 采样帧数 | 566 帧 / 20 s |
| 慢帧（> 20 ms） | 514 / 566 帧 |
| `store.fps`（交叉验证） | 28.5 —— 与 rAF 一致 |
| 采样时 CPU 占用 | 95 % |

e2e 门禁自己跑的那一轮（采样 30 s）读到 **21.9 FPS**（p50 帧间隔 50.0 ms）。

### 3.3 三条结论

1. **真机 GPU 上 30 FPS 目标达成，且余量很大。** 164.7 FPS 持续、3311 帧里只有
   1 帧超过 20 ms —— 30 FPS 的预算是每帧 33.3 ms，而典型帧只花 **6.1 ms**，
   也就是说**渲染只用了预算的 18 %**，剩下 82 % 是余量。
2. **软件光栅比真机慢约 5.8 倍**（28.2 vs 164.7 FPS）。这正是「headless 读数只能
   当悲观下界」的量化依据 —— 也说明软件光栅下低于 30 FPS **不能**推断真机
   达不到 30。
3. **瓶颈不是车流。** 真机 GPU 上 4 / 8 / 12 辆的帧间隔中位数**精确地同为
   6.1 ms**，帧率只受**呈现节奏**限制，不随车数变化。这个规模区间里，
   **瓶颈不是车流**。

### 3.4 机器负载是必须一起读的数字

「CPU 占用」是**采样窗口内全部 16 个逻辑核的忙碌比例**（含本测量自身）。
本次测量时机器在 64–95 % —— 上面还有别的任务在跑（并行跑测试的其它项目、
浏览器、桌面应用）。

这意味着：**上表的帧率是「在这台忙着的机器上」读到的**，比机器空闲时更悲观。
这是有意的：宁可给一个偏低的数，也不要给一个只在「恰好没人用电脑时」才成立的数。
即便如此，真机 GPU 上的 164.7 FPS 仍有 5 倍余量。

---

## 4. 帧率门禁现在怎么判

`tests/e2e/perf-gate.spec.ts` 的判定**按渲染器字符串分叉**，不按启动参数分叉：

| 渲染器字符串 | 环境 | 门禁行为 |
|---|---|---|
| 含 `SwiftShader` | 软件光栅（CI） | **只报不断言**。断言「仿真在推进」「读数有限」「没塌到 10 FPS 以下」—— 这三条在 CI 里是**结论性的**。30 FPS 目标**不**在此断言。 |
| 不含 `SwiftShader` | 真机 GPU | 在上面三条之外，**额外断言持续帧率 ≥ 30 FPS**。 |

为什么这样分：软件光栅下读数低于 30，**证明不了**真机上达不到 30；真机 GPU
上读数低于 30，**就是**没达标。两种情况用同一条规则判，就一定会有一边判错。

判据来自浏览器**自己报的渲染器字符串**，所以：

- CI（headless）自动落到「只报不断言」分支，套件保持稳定；
- 开发者本机 `npm run test:e2e:headed` 自动落到「断言」分支，拿到的就是真机
  那个数；
- 机器悄悄退回软件渲染时，会被**认出**成软件分支 —— 不会把一个软件光栅的数
  误当成真机数报出去。

报告 JSON（`e2e-output/current/perf-gate.json`）里记了 `environment`、
`renderer`、`softwareRasterizer`、`throttled`、`targetAsserted`，任何一次读数
都能回溯到它是在哪条分支上判的。

> **目标规模仍是 12 辆车。** 门禁原文写的是 20 辆，但没有任何内置场景能装下
> 20 辆（`spawnVehicle` 车道满即拒绝；实测容量 cross 8 / t 7 / loop 12 /
> elevated 7 / corridor 8）。门禁测的是最大容量场景的真实上限，并把差额写进
> 报告的 `gateStatus`，**没有**偷偷把门禁改成 12 辆就算数。

---

## 5. 一条历史读数的更正

仓库早先记录过一组帧率数字（12 辆车 avg 35.0 / min 30），它是用 `store.fps`
测的。**那组数字里的 `min 30` 不是一个测出来的下界** —— 它是 dt 钳位（`1/30`
秒）的算术下限：仿真慢于 30 FPS 时，`store.fps` 依然会报 30。

用 rAF 重测，同样的场景下真实的最差帧间隔是 50.1 ms（≈ 20 FPS）。**「min 30」
这个说法当时测不出来**，它是被钳位制造出来的。

这不是说当时的性能结论是错的 —— 33–37 FPS 的平均值说明当时确实是流畅的。
错的是**那个下界的说法**：它声称「最差也有 30 FPS」，而实测最差是 20 FPS。

本报告不用 `store.fps` 下性能结论，原因就在这里。

---

## 6. 已知边界

| 边界 | 说明 |
|---|---|
| **真机 GPU 的数是本机一台机器** | RTX 4050 Laptop + D3D11 + ANGLE。换一台机器、换一条渲染后端（Linux 上的 Vulkan）、换一块显卡，数字都会变。 |
| **165 FPS 是呈现节奏，不是吞吐上限** | 真机 GPU 上帧间隔 p50 = 6.1 ms，且**把视口从 1280×800 放大到 3840×2400（9 倍像素）帧率完全不变** —— 说明 rAF 被合成器的呈现节奏（≈165 Hz）锁住，**不是**渲染算不过来的上限。含义是：**渲染远不是瓶颈**，而不是「这台机器能渲染 165 FPS 的独立内容」。佐证：在页面里包一层 `requestAnimationFrame` 计时（不改仓库代码），应用每帧自身的 JS + 提交开销实测 **均值 0.42 ms / p50 0.1 ms / p99 1.4 ms**（1280×800），离 30 FPS 的 33.3 ms 预算差两个数量级。 |
| **软件光栅** | headless 的数来自 SwiftShader，**没有用 GPU**。真实硬件上的帧率**高于**这些数（实测高约 5.8 倍）。这让读数成为**悲观下界**，但也意味着**不能用这些数推断真实硬件上的体验**。 |
| **本机负载** | 测量时机器 64–95 % 忙碌。数字偏悲观，且不是「独占机器」的数。 |
| **只有 12 辆车** | 内置场景的最大容量就是 12（`spawnVehicle` 车道满即拒绝）。**20 辆车这个规模在当前场景里不可达**，本报告没有也不编造那个点的数字。 |
| **只有一个分辨率** | 1280×800。真机 GPU 上的分辨率扩展测试见上，但主表只有这一个点。 |
| **场景只有 `loop`** | 其余内置场景容量更小（7–8 辆），没有单独列。 |
| **浏览器内单场景** | 不含 Cesium 底图（`/smart-city` 视图）的开销 —— 那条路径的渲染负载完全不同，本报告不覆盖。 |
| **不含后端** | 纯前端渲染基准。后端训练、权重导出等不在此列。 |
| **帧率不是全部** | 帧率只说明「画面刷新多快」。仿真步进是否跟得上、策略推理是否阻塞，都要看别的指标。 |

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `TraffSim3D-frontend/scripts/measure-fps.mjs` | 测量脚本（本报告的产出方式）；`--headed` 走真机 GPU |
| `TraffSim3D-frontend/tests/e2e/perf-gate.spec.ts` | e2e 帧率门禁：按渲染器字符串分叉，软件只报 / 真机断言 |
| `TraffSim3D-frontend/src/interfaces/stores/worldStore.ts` | `store.fps` 的来源（墙钟帧间隔统计）与 dt 钳位所在 |
| `TraffSim3D-frontend/src/shared/constants/simulation.ts` | `MAX_PHYSICS_FRAME_DT`（钳位上限） |
| `e2e-output/perf/fps-<n>-<mode>.json` | 原始采样数据（本机产物，不入仓库） |
| `e2e-output/current/perf-gate.json` | e2e 门禁的读数与判定分支记录（本机产物） |

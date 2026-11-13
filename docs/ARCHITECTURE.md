# TraffSim3D 架构文档

面向「要读懂这个系统、或者要接手它继续做」的人。

本文只描述**系统现在的样子**。每个结构性断言后面都给出代码出处（路径 + 符号），
便于自行核对。决策裁定内容与契约的逐项覆盖面、盲区表，分别以
[adr/](adr/) 与 [contracts/sim-snapshot.md](contracts/sim-snapshot.md) 为准，本文只做链接与结论。

---

## 1. 这个系统是什么

TraffSim3D 是一个 3D 智能交通仿真平台：前端用 Vue 3 + Three.js 做可视化与物理，
后端用 Python FastAPI + PyTorch 跑强化学习引擎。目标是在一个虚拟城市里，
让**多智能体 RL** 学习开车（ego 驾驶员）与交通控制（信号灯 agent）这两类策略。

- 前端技术栈（[TraffSim3D-frontend/package.json](../TraffSim3D-frontend/package.json)）：
  Vue 3.5、Vite 7、Three 0.180、Pinia 3、Vue Router 4、
  `@dimforge/rapier3d-compat` 0.14（Rapier WASM 物理）、Cesium 1.134、GSAP 3.15。
- 后端技术栈（[TraffSim3D-backend/pyproject.toml](../TraffSim3D-backend/pyproject.toml)）：
  FastAPI、Gymnasium、numpy、osmium（OSM PBF 解析）、pbf；RL 栈
  `stable-baselines3` 在 `[project.optional-dependencies].rl` 里，是**可选依赖**。
- 两个半独立的前后端仓库并列（不是嵌套），用
  [TraffSim3D.code-workspace](../TraffSim3D.code-workspace) 一起打开。

---

## 2. 仓库地图

| 目录 | 装什么 |
|---|---|
| `TraffSim3D-frontend/` | Vue3 + Three.js 前端。DDD 四层 + `shared/`，见第 3 节。 |
| `TraffSim3D-backend/` | Python FastAPI + SB3 后端。app-per-capability，见第 4 节。 |
| `docs/` | 权威文档：`adr/`（9 篇 ADR）、`contracts/sim-snapshot.md`（跨语言契约）、`DEPLOYMENT.md`、`USER-GUIDE.md`、`ARCHITECTURE.md`（本文）。 |
| `.github/workflows/ci.yml` | 四个 CI job：`backend` / `frontend` / `contract` / `e2e`。 |
| `e2e-output/baseline/` | Playwright 视觉回归基线 PNG（在**仓库根**，不在 frontend 子目录）。 |
| `TraffSim3D-backend/.data/` | RL 运行时产物（checkpoint / 训练状态 / 控制文件），gitignored。 |

```mermaid
flowchart TB
  subgraph repo["TraffSim3D/"]
    subgraph fe["TraffSim3D-frontend/ — Vue3 + Three.js"]
      feDomain["src/domain/<br/>实体 · 值对象 · 纯服务"]
      feApp["src/application/<br/>用例 · 步进 · 控制器"]
      feInfra["src/infrastructure/<br/>渲染 · 物理 · 传感器 · RL · 持久化"]
      feIface["src/interfaces/<br/>视图 · 组件 · store · 路由"]
      feShared["src/shared/<br/>常量 · 类型 · 工具"]
    end
    subgraph be["TraffSim3D-backend/ — FastAPI + PyTorch"]
      beApi["app/api/v1/<br/>ping · maps · rl"]
      beRl["app/apps/rl/<br/>训练 sim · PPO · 权重导出"]
      beMaps["app/apps/maps/<br/>OSM 解析 · 路网图 · Overpass 缓存"]
      beEmpty["app/apps/simulation/ · app/apps/perception/<br/>空壳"]
    end
    docsN["docs/ — ADR · 契约 · 部署 · 用户指南"]
    ciN[".github/workflows/ci.yml"]
  end
```

### 从哪读起（5 步）

1. `docs/adr/ADR-005-architecture-ddd-split.md` —— 前后端切分与 DDD 分层的决策依据。
2. `TraffSim3D-backend/app/apps/rl/sim_core.py` —— 训练侧的仿真内核，**观测维度的权威定义**在
   该文件的 `OBS_DIM = 14`。这是整个系统里最该先读懂的一个文件。
3. `TraffSim3D-frontend/src/domain/services/egoKernel.ts` —— 与上者一一对应的 ego 运动学内核
   （TS 侧）。它被**契约镜像**和**产品回放路径**共用。
4. `docs/contracts/sim-snapshot.md` —— 两个内核如何被钉在一起，以及钉住了什么、没钉住什么。
5. `TraffSim3D-frontend/src/application/services/tick.ts` —— 浏览器侧每帧的推进逻辑。

---

## 3. 前端分层

`TraffSim3D-frontend/src/` 下是四个 DDD 层 + 一个共享层。依赖方向由内向外：
`domain` 不依赖任何框架，`interfaces` 依赖 `application` 与 `infrastructure`。
路径别名在 `vite.config.js` 与 `vitest.config.ts` 里各定义一遍：
`@domain` / `@application` / `@infrastructure` / `@interfaces` / `@shared`（外加 `@/` 指向 `src/`）。

| 层 | 装什么 | 关键文件 |
|---|---|---|
| `src/domain/` | 实体（`Vehicle` / `TrafficLight` / `Road` / `Lane` / `Intersection` / `RoadNetwork` / `SpawnPoint`）、值对象（`Position` / `Speed` / `Phase` / `LaneId`）、纯函数服务 | `src/domain/entities/`、`src/domain/value-objects/`、`src/domain/services/vehicleDynamics.ts`、`src/domain/services/purePursuit.ts`、`src/domain/services/egoKernel.ts`、`src/domain/services/laneGeometry.ts`、`src/domain/services/laneChange.ts`、`src/domain/services/networkBounds.ts` |
| `src/application/` | 用例与每帧推进逻辑：场景步进、信号控制、传感器登记、生成/清理车辆、存档读写 | `src/application/services/tick.ts`、`src/application/services/fixedStepScheduler.ts`、`src/application/services/signalController.ts`、`src/application/services/controllers/`、`src/application/services/sensors/SensorRegistry.ts`、`src/application/use-cases/`（`saveScene` / `loadScene` / `clearScene` / `importSceneFile` / `exportSceneFile`） |
| `src/infrastructure/` | 所有技术实现：渲染、物理、传感器、RL 推理、持久化、导出、后端 API 客户端、Cesium | `src/infrastructure/rendering/ThreeJSRenderer.ts`、`src/infrastructure/physics/RapierWorld.ts`、`src/infrastructure/sensors/LidarSensor.ts`、`src/infrastructure/sensors/CameraSensor.ts`、`src/infrastructure/rl/mlpInference.ts`、`src/infrastructure/persistence/LocalStorageAdapter.ts`、`src/infrastructure/persistence/sceneSerializer.ts`、`src/infrastructure/api/backendService.ts`、`src/infrastructure/api/rlWeightsClient.ts`、`src/infrastructure/api/osmImportClient.ts`、`src/infrastructure/export/TrajectoryExporter.ts`、`src/infrastructure/cesium/loadCesiumRuntime.ts` |
| `src/interfaces/` | 面向用户的部分：视图、组件、Pinia store、composable、路由 | `src/interfaces/views/`（8 条路由 + 404 兜底页）、`src/interfaces/components/`、`src/interfaces/stores/worldStore.ts`、`src/interfaces/stores/selectionStore.ts`、`src/interfaces/composables/useWorldSimulation.ts`、`src/interfaces/router/index.js` |
| `src/shared/` | 跨层共享的常量、类型、工具 | `src/shared/constants/simulation.ts` |

### 几条硬约束

- **`domain/` 里没有 Three.js、DOM、Rapier。** 实体与值对象是可序列化的纯数据，
  这样后端的 Gymnasium env 才能直接消费同一套语义。`egoKernel.ts` 的文件头注释把这条
  写成了显式约束（`Pure functions only: no DOM, no Three.js, no Rapier`）。
- **仿真内核只有一份 TS 实现**：`src/domain/services/egoKernel.ts`。
  契约镜像（`src/application/services/simCoreMirror.ts`）与产品回放路径
  （`src/application/services/tick.ts`）都用它，
  所以镜像与产品在 ego 模型上不可能分叉。
- **信号动作词表在两侧各有一份拷贝**，故意不共用同一个文件：
  TS 在 `src/shared/constants/simulation.ts` 的 `SIGNAL_ACTION_NAMES`，
  Python 在 `app/apps/rl/sim_core.py` 的 `SIGNAL_ACTION_NAMES`。
  共用文件会让「两侧一致」这个断言变成空话，所以契约改为逐项比对这两份拷贝。

### 路由（`src/interfaces/router/index.js`）

`/`（首页）、`/scene-editor`、`/simulation-lab`、`/ai-playground`、
`/map-importer`、`/smart-city`、`/deliverables`、`/backend`，外加 404 兜底。

---

## 4. 后端分层

`TraffSim3D-backend/app/` 是 app-per-capability 的形状：

| 位置 | 状态 |
|---|---|
| `app/main.py` | FastAPI 入口。`GET /health`；CORS 白名单覆盖 5173 / 4173 / 5188（`localhost` 与 `127.0.0.1` 各一份）。 |
| `app/api/v1/ping.py` | `GET /api/v1/ping` → `{"pong": true}`。 |
| `app/api/v1/maps.py` | `POST /maps/parse-osm`、`POST /maps/parse-pbf`、`GET /maps/overpass`、`GET /maps/overpass/cache`。两个解析端点接受可选的 `bbox` 裁剪参数（顺序 `south, west, north, east`），两个 Overpass 端点不接受。 |
| `app/api/v1/rl.py` | `POST /rl/train`、`GET /rl/status`、`GET /rl/capabilities`、`POST /rl/train/pause`、`POST /rl/train/resume`、`POST /rl/train/terminate`、`GET /rl/checkpoints`、`DELETE /rl/checkpoints`、`GET /rl/scenes`、`GET /rl/training-config`、`GET /rl/checkpoints/{name}/weights`。 |
| `app/apps/rl/` | **已实现**。训练 sim、两个 env、PPO 训练、checkpoint、权重导出、课程学习、信号灯训练、控制通道、运行时路径。文件清单见第 5、9 节。 |
| `app/apps/maps/` | **已实现**。`osm_parser.py`（OSM XML / PBF → 路网）、`road_graph.py`（有向图 + A\* 最短路）、`overpass_cache.py`（Overpass 响应落盘缓存）。 |
| `app/apps/simulation/` | **空壳**。`__init__.py` 的 docstring 写明「Not implemented」，并说明物理推进目前在客户端侧（前端 Rapier + `tick.ts`）跑，后端编排推迟到出现具体消费者为止。 |
| `app/apps/perception/` | **空壳**。`__init__.py` 一行注释说明 YOLO 检测与多目标跟踪是「optional, deferred」。 |
| `app/core/`、`app/models/`、`app/storage/` | **空壳**（只有 `__init__.py`）。存储栈（PostgreSQL/PostGIS、Redis、MinIO）尚未引入。 |

---

## 5. 两条数据流

### 5.1 浏览器侧：编辑 → 持久化 → 步进 → 传感器 → 推理 → 渲染

```mermaid
flowchart LR
  editor["场景编辑<br/>src/interfaces/views/SceneEditorView.vue"]
  store["worldStore<br/>src/interfaces/stores/worldStore.ts"]
  persist["持久化<br/>src/infrastructure/persistence/LocalStorageAdapter.ts"]
  tick["tick 推进<br/>src/application/services/tick.ts"]
  rapier["Rapier 物理<br/>src/infrastructure/physics/RapierWorld.ts"]
  signal["信号控制器<br/>src/application/services/signalController.ts"]
  sensors["传感器<br/>src/infrastructure/sensors/LidarSensor.ts"]
  obs["buildReplayObs<br/>14 维观测"]
  infer["前向推理<br/>src/infrastructure/rl/mlpInference.ts"]
  render["渲染<br/>src/infrastructure/rendering/ThreeJSRenderer.ts"]

  editor --> store
  store --> persist
  store --> tick
  tick --> rapier
  tick --> signal
  tick --> sensors
  tick --> obs
  obs --> infer
  infer --> tick
  tick --> render
```

要点：

- **步进入口**：`tick(network, dt, simTime, ctx)`（`src/application/services/tick.ts`）。
  第五个参数 `ctx: TickContext` 打包了 `rapierWorld`、`signal`、`trajectoryExporter`、
  `sensorRegistry`、`lidarEnabled`、`getHostPose`。
- **信号冲突消解**：`tick.ts` 里的 `resolveSignalConflicts(inter)` 按交通法规
  **GB 14886** 的要求处理冲突方向的放行关系（同一冲突面上先到的相位保持，
  后到的强制转红）。
- **固定步长**：`src/application/services/fixedStepScheduler.ts` 的 `FixedStepScheduler`
  把可变间隔的墙钟 dt 转成固定速率的步进边界事件，默认 `fixedStepSec = 0.1`（10 Hz），
  `maxAccumulator = 0.5`（浏览器 GC 停顿或切标签页时钳住累积量，避免补跑几十步）。
  采样侧另有 `TRAJECTORY_SAMPLE_INTERVAL = 0.1` 与 `LIDAR_SCAN_INTERVAL_S = 0.1`。
- **观测构造**：`tick.ts` 的 `buildReplayObs(ego, network)` 产出 **14 维**观测，
  其中的观测维度常量在同文件里写作 `const OBS_DIM = 14`。
  归一化分母（位置 50 m、航向 π、速度 16.67 m/s、NPC 距离 50 m）必须与 Python 侧一致，
  否则 PPO 会吃到「比训练时更小」的速度而开得离谱。
- **推理**：`src/infrastructure/rl/mlpInference.ts` 用纯 TS 重实现 SB3 默认 MlpPolicy 的前向，
  分两条路径：`mlpForwardMean` / `mlpForwardSample`（连续动作，带 `log_std`）与
  `mlpForwardDiscrete`（离散动作，取 logits 的 argmax）。
- **物理**：Rapier WASM 由 `RapierWorld.init()` 惰性加载，懒加载独立 chunk，
  与首屏无关。`src/interfaces/composables/useWorldSimulation.ts` 里 Rapier 初始化失败时场景仍然渲染，只是物理不推进。

### 5.2 训练侧与回放链路

```mermaid
flowchart TB
  subgraph train["训练侧 — Python"]
    env["TrafficEnv / MultiTrafficEnv<br/>app/apps/rl/env.py · app/apps/rl/multi_env.py"]
    senv["SignalEnv<br/>app/apps/rl/signal_env.py"]
    ppo["PPO 训练<br/>app/apps/rl/train.py · app/apps/rl/signal_train.py"]
    ckpt["checkpoint<br/>app/apps/rl/checkpoint.py"]
    w["权重导出 JSON<br/>app/apps/rl/weights.py"]
    env --> ppo
    senv --> ppo
    ppo --> ckpt
    ckpt --> w
  end
  subgraph replay["回放侧 — 浏览器"]
    client["rlWeightsClient<br/>GET /rl/checkpoints/<name>/weights"]
    mlp["src/infrastructure/rl/mlpInference.ts"]
    rtick["tick 回放路径"]
    client --> mlp
    mlp --> rtick
  end
  w --> client
```

- **训练是子进程**：`POST /rl/train` 用 `subprocess.Popen` 拉起 `python -m app.apps.rl.train`，
  接口立刻返回 PID；进度与控制走文件，不走信号（见第 9 节）。
- **checkpoint**：`app/apps/rl/checkpoint.py` 按进程分子目录存放，
  `CHECKPOINT_KEEP = 5`；`GET /rl/checkpoints` 跨进程汇总，`DELETE /rl/checkpoints` 只保留最新 5 个。
- **权重导出**：`app/apps/rl/weights.py` 的 `export_weights()` 把 checkpoint 里的
  `state_dict()` 摊平成 JSON 可序列化的嵌套数组，并带上 `obs_dim` / `action_dim` /
  `hidden_sizes` 与 `action_space`（`"discrete"` 或 `"continuous"`）。
  离散策略没有 `log_std`（SB3 的 `CategoricalPolicy` 出的是 logits），连续策略才有；
  `action_space` 缺失时按连续处理。

### 5.3 两个 agent 的分工

| | ego 驾驶员 | 信号灯 agent |
|---|---|---|
| 环境 | `TrafficEnv`（`app/apps/rl/env.py`）、多环境版 `MultiTrafficEnv`（`app/apps/rl/multi_env.py`） | `SignalEnv`（`app/apps/rl/signal_env.py`） |
| 观测 | `Box(-1, 1, (14,))`，`OBS_DIM = 14` | `Box(-1, 1, (SIG_OBS_DIM,))`，`SIG_OBS_DIM = 6` |
| 动作 | `Box(-1, 1, (2,))` 连续 | `Discrete(len(SIGNAL_ACTION_NAMES))`，即 **5** 个动作 |
| 动作语义 | `action[0]` = 加速度（`clip(a, -1, 1) * 3.0`，m/s²）；`action[1]` = **转向残量**（`clip(a, -1, 1) * MAX_STEER`，叠加在 Pure Pursuit 的脚本转向之上） | 词表：`extend_green` / `shorten_red` / `preempt` / `force_all_red` / `no_op` |
| 浏览器侧对应 | `buildReplayObs` + `mlpInference` + `tick` 的回放分支 | `src/application/services/signalPolicySource.ts` 造 6 维观测 → `mlpForwardDiscrete` → `SignalActionSource` → `src/application/services/controllers/RLController.ts` |
| 场景 | `cross` / `corridor` / `t_junction` / `roundabout` / `cross_signalled` | 同左 |

- **ego 的观测维度 14 由 Python 侧定义**（`app/apps/rl/sim_core.py` 的 `OBS_DIM = 14`），
  与 [contracts/sim-snapshot.md](contracts/sim-snapshot.md) 一起构成契约；
  **前端对齐 Python，不反向**。
- **信号灯 agent 的 6 维观测**在 Python 侧是参考实现（`SignalEnv._obs()`），
  浏览器侧的 `signalPolicySource.ts` 重建同样的六个量。注意 idx 5 是**已过相位比例**
  （elapsed），不是剩余比例 —— 权重是按 Python 的定义训出来的，喂错量网络就吃到
  训练时没见过的输入。
- **信号 agent 的奖励**是总延误（两条轴的排队长度曲线下的负面积）。
  **最小绿灯时间**（`MIN_GREEN_SECS`）加在环境层（动作被 mask、灯不被改动），
  **不在** `sim_core` 的物理灯模型里 —— 后者是契约的敏感区，默认行为必须逐位不变。

### 5.4 交付面：随产品附带的网格策略

5×5 网格的 MAPPO 策略（seed 0 —— 三个训练种子里浏览器侧实测最优的那份）**随产品附带**。
资产 `app/apps/rl/assets/network_mappo_grid_policy.json` 由
`scripts/gen_network_mappo_fixture.py` 与前端的 forward-pass fixture
（`network-mappo-policy-fixture.json`）**同一次运行写出**，`tests/test_rl_grid_policy.py`
用「资产权重必须复现 fixture 的期望动作」把两者钉在一起 —— 两条引用不会悄悄漂移。

- `GET /api/v1/rl/signal/grid-policy` 返回这份权重：读 JSON 资产、全量校验（离散 /
  6 obs / 5 act / 64×64 隐层 / 无 `log_std` / 矩阵形状与元数据一致）后返回。
  **不依赖 SB3 / torch** —— 只装基础依赖的后端（如 e2e 的那个）也能服务它。
- AI Playground 挂载时默认加载它并把控制器切到 RL：打开页面，训出的策略就在指挥
  信号灯；到场景页选「5×5 网格」即可观看。这是默认值不是锁定 —— 勾选框仍可切回
  感应控制器，本地 checkpoint 仍可加载覆盖。
- 训出的策略**只有一份随产品附带**，因为**迁移不是必然的**（已知限制，数字如下）：

  | 训练种子 | 训练侧 margin（3 个留出 seed） | 浏览器总延误（基线 4626.8 veh·s） |
  |---|---|---|
  | seed 0（随产品附带） | +89.1 | 4394.7（**−5.0 %**） |
  | seed 1 | +109.6 | 4531.0（−2.1 %） |
  | seed 2 | +116.0 | 4809.0（**+3.9 %**） |

  三个种子在训练侧全部打败固定周期基线；迁到浏览器（90 s / 67 辆 / 真 Rapier）实测，
  两个迁移成功、一个反向 —— 反向的正是触发过多的那份（`shorten_red` 占 38.8 %，
  迁移成功的两份是 10–12 %）。选优窗口、rollout 长度这些训练参数的影响记录在
  `network_mappo.py` 与 `network_signal_env.py` 的注释里。

### 5.5 交付面：路线规划与第一人称相机

**产品故事**：规划一条路线 → 坐在车里把它开完。
**决策记录**：[ADR-010](adr/ADR-010-route-planning-and-the-first-person-camera.md)。

```
browser (RoutePanel)
  │ POST /api/v1/routes/plan  {network, start{road_id,direction}, end{junction_id}}
  ▼
app/api/v1/routes.py  →  app/apps/maps/road_graph.py（节点级有向图 · A*）
  │  legs: [{road_id, from, to, cost_m}]
  ▼
routePlanner.ts（纯逻辑）→ store.plannedRoute {roads[], points[], lengthM}
  │                              │
  │                              ├→ RouteMesh.ts：路线带画在**车行驶的车道**上
  │                              └→ roadTransition.ts：跟车按路线的下一条路转向
  ▼
ThreeJSRenderer：跟随时相机接管（眼高 1.35 m · 前视 14 m），跟车自身不绘制
```

三条要点：

- **起点带方向**：车不在路口上，它在一条路上、正朝那头去。起点是「这条路、
  这个方向的那一头」，路径从车**下一个到达的节点**开始算 ⇒ 返回的 leg
  序列从车所在的位置就是可开的。单行道只能顺行，每条 leg 说清驶入方向。
- **只有跟车按路线走**：`roadContinuation` 多一个参数，路线指定的下一条路
  **在该路口确实是候选**时才采用，否则回落到哈希概率规则。**其余车辆一字
  未动** ⇒ 浏览器的总延误基线（4626.8 veh·s）与 RL 迁移结论（−5.0 %）仍然
  有效 —— 这条由「NPC 转向分布零变化」守住。
- **路线带画在车道上，不是路中线**：leg 是路段级的（路口到路口），节点落在
  中线上，离车 5.25 m。keep-right 规则让偏移统一：无论往哪个方向开，车都在
  **行进方向右侧** `laneOffset(0, laneCount)` 处（实测车到路线带的横向距离
  **0.00 m**）。

**枢轴碰撞没有被这条路线修掉**：转向车横扫路口角的几何（实测最多 7.4 m）
不变，路线消除的是「转向与计划矛盾」这一类错误。真正的修法是弧线，属于模型
改动（见 [ADR-010](adr/ADR-010-route-planning-and-the-first-person-camera.md)
的 Decision 末段）。

**目的地可以是兴趣点**（2026-11-01，ADR-016）。点一下 POI 面板里的
「开过去（第一人称）」，场景里的**第一辆车**就被规划到那个 POI，第一人称
相机随之打开，车一路开到那儿。

POI 没法直接交给路线规划器——它只认**路口**或**某条路的方向性末端**，
而 POI 是**路边的一个地点**。所以浏览器先做一步几何：**POI 挨着哪条路、
往哪一头**（`poiNavigation.ts`）：线离 POI 最近的那条路赢，方向取**离 POI
更近的那一头**（走错方向会停在整条街的另一端）。然后照常调后端规划。

**到达是距离，不是路点**：路线止于那条路的末端节点，而 POI 可能在路中间，
所以判定是「车离 POI ≤ 20 m」（路缘到车道的横向差约 5 m，20 m 留足余量）
——车开着开着就经过 POI，途中触发。

**第一人称是仪表盘**（同一个面板）：目标（POI 的名字）、速度、**还剩多少
米**、**下一步动作**（直行 / 左转 / 右转 / 掉头，由路线折线两段方向的角度
算出来；路名 `r-ew-0-240.4` 对司机没有意义）、以及第一人称视角开关。

实测（grid 场景、4× 仿真速度）：点「开过去」⇒ 路线 3 段 / 240 m、跟车
v-g1、相机切第一人称、剩余距离从 292 m 一路降到 20 m ⇒ **「已到达」**，车**停在
目的地**（速度钉到 0；不清目的地就一直停着）。

**内置场景都能规划路线了**（2026-11-02，ADR-017）。此前只有 grid 能用：内置
场景的道路只有起终点两个点，而**十字场景的四条臂都穿过中心路口、中心却不是任何
一条臂的端点** ⇒ 路线图里四条臂没有共享节点 ⇒ 图是四条互不相连的线 ⇒ 规划器
诚实回答「没有路」。现在构建场景时把「道路穿过的路口」补成折线点
（`addIntersectionWaypoints`，几何上那个点本来就在线上 ⇒ 什么都不动，只是两侧
道路在路口共享一个节点）。

修的时候暴露了一个**既有 bug**：折线长度按 Road 对象缓存（WeakMap），场景构建时
先算缓存、随后又就地改写 `waypoints` ⇒ 缓存陈旧 ⇒ 投影读到旧几何
（`worldToCenterlineS(0,0)` 回答 s=60 而不是 30）⇒ 路口盒与停止线整个挪到路尾。
新增 `invalidateRoadPolylineCache`，改写时清掉。

**掉头是显式特例**：目的地在司机自己那条路上、而且在它身后时（`poiAheadOrBehind`
判断），规划器收到 `allow_u_turn: true`，路线保留那条路的重复项
（`keepFirstRoad`）——否则前端把重复项过滤掉，掉头那一段就丢了。这是用户裁定的
「极为特殊的情况」；路口本身是否允许掉头是场景的事，规划器不判断。

**第一人称的打磨**：目的地标记更大更亮（scale 1.6，T·S 乘法——Three 0.180 里
`makeTranslation` 之后调 `matrix.scale()` 会把旋转部分清零）；相机**缓入**第一人称
而不是瞬移——**40 帧的缓出（≈0.7 s），之后精确跟随眼位**。注意：用永不收敛的
lerp 会让画面永远滞后于车一两米（既有 e2e 断言眼位，当场变红）。

### 5.6 交付面：无信号路口的多车协商（Scene 4）

**产品故事**：几个驾驶者在**没有信号灯**的路口相遇，自己协商谁先过。
**决策记录**：[ADR-011](adr/ADR-011-cooperative-driving-at-an-unsignalised-junction.md)。

为什么是无信号路口：真实导入路网里 **7991 个路口只有 51 个带信号灯** ⇒ 96 % 的
路口没有相位可依，路权只能靠**行为**协商。而「谁先过」天生是合作问题：结果取决于
别人怎么做。

```
app/apps/rl/drive_core.py     29 维观测 · N 个学习 driver + 脚本车流
  │                              · 延误归因（谁挡的谁付）
  │                              · 碰撞按**事件**计，且只罚开动的那辆
  ▼
app/apps/rl/intersection_env.py  无信号十字路口的环境（四个臂 + 一条路口）
  │                              · 奖励 = -(自己的延误 + 造成的他人延误) - 冲突 - 碰撞
  ▼
app/apps/rl/drive_mappo.py      连续动作 MAPPO：参数共享 actor + 集中式 critic
  │                              · 逐车信用分解（每个 driver 的优势只算它自己那份）
  ▼
scripts/gen_drive_policy_fixture.py  →  前端 fixture（观测 + 期望动作）
```

三条与浏览器同源的建模约定（改了它们，场景就退化）：

- **车辆靠右行驶**（横向偏移 5.25 m）：否则同一条臂上的对向车走的是**同一条中线**，
  迎面撞是几何写死的，不是协商。
- **转向是枢轴**：Pure Pursuit 单独转不过 90° 弯（转弯半径 ~6 m < 换道横移 10.5 m），
  实测会把车切到 33 m 外、路网外的地方去。
- **Pure Pursuit 的 alpha 是教科书符号**（`target_angle - heading`）：反过来会让转向
  **发散**（航向误差每步变大）。

**2026-11-01 补记：训练侧的车也锁到车道上了**。原先 Python 侧的车是自由积分的
点，Pure Pursuit 追的是**道路中线**——它会一路切弯、离车道 18 m；浏览器侧却是
车道锁定的（`roadId / laneIndex / s / heading`）。现在两侧口径一致：位置由**车道
点**决定，Pure Pursuit 只决定 heading，追的目标也换成**车道点**而不是中线。
连同限速封顶与路线末端停车，共五处模型修正，数字见 §5.8。

### 5.6.1 实测：学到的策略 vs 两个脚本基线

同一批 10 个 seed、3 个驾驶者、同一套奖励（一次撞车 = 50 秒等待）。
**shipped 策略是网格训出的 v5**（29 维观测，见 §5.8）——本表用它重测；
右让规则在 300+ 步的长窗里会把一辆车**循环等待卡死**（2.5/3 通过）。

| | 回报 | 冲突 | 碰撞 | 延误 | 通过 | 步数 |
|---|---|---|---|---|---|---|
| **v5（shipped，网格训出）** | −36.2 | 2.8 | 0.4 | 8.4 | 3.0/3 | 149 |
| `always_go`（谁都不让） | **−33.4** | 0.9 | 0.4 | **3.1** | 3.0/3 | 79 |
| `right_of_way`（先到先行 + 右让打破平局） | −64.4 | **0.0** | **0.1** | 60.7 | 2.5/3 | 294 |

**这张表怎么读**：单路口是 v5 的**次主场**——它训在网格上（§5.8 才是它的
成绩单）。这里 `always_go` 的回报**略胜**（−33.4 对 −36.2）：它不需要协商，
所以冲突少（0.9 对 2.8）、等待少、也更快（79 步对 149 步）。v5 换来的是
**三辆都通过**、碰撞与基线持平（0.4），代价是它**更敢抢路口**（冲突 2.8）
也更**愿意等**（延误 8.4）。右让规则是唯一零冲突的（0.0），但有两辆
**循环等待卡死**（2.5/3 通过）、延误 60.7 ——**安全，但走不到**。

**口径变更（2026-11-01）**：训练侧的车辆模型修过五处（§5.8），所以本表与
历史数字**不可直接比较**——回报的绝对值随模型与奖励结构变了。历史版本
（v1 时代 −46.8 / 冲突 0.5 / 30-30；v5 初版 −63.7 / −53.9 / −66.9）只在
**各自那张表内**成立。能比的只有**同一张表内的相对排序**：学到的策略在
单路口**没有赢过**「谁都不让」，它赢的是网格（§5.8）。
「一次撞车值多少秒等待」的定标推理（5 / 20 / 50 三档）记录在
`app/apps/rl/drive_core.py` 的 `COLLISION_PENALTY` 注释里。

**训练会振荡**：早期几轮的最优 checkpoint 出现在中段（step 3 000 或 29 500）而不是
最后一步，与 Scene 3 同一个现象 ⇒ **保留评估最优的 checkpoint** 是必须项。

### 5.6.2 浏览器侧：策略真的开起来

无信号路口场景（`buildUnsignalisedJunctionScene`，场景下拉里的「无信号路口」）按训练
环境的几何搭：四臂 60 m、四车道、**零盏灯**、三辆协商车 + 一辆脚本车，出发距离按训练
的 45–80 % 分段、靠右车道（`roadContinuation` 的枢轴模型在路口执行每辆车的路线转弯）。

策略的接线与两层对拍：

- **前向传播**（权重 × 固定观测 → 动作）：`network-drive-policy-fixture.json` 钉住，
  浏览器的 `mlpForwardMean` 与 Python 逐条一致（`networkDrivePolicyFixture.spec.ts`）。
- **观测构造**（实时状态 → 29 维向量）：`driveObservation.ts` 逐元素复刻
  `DriveCore._observation` 的口径 —— 到达时间的 0.5 m/s 下限、方位角「从车指向路口」、
  CPython 风格的角度 wrap、槽位按**到自车的距离**排序。对拍 fixture
  （`drive-observation-fixture.json`，`gen_drive_observation_fixture.py` 生成）持确定性
  场景状态 + Python 的向量（float64 参考实现，与 core 的 float32 输出互核），
  浏览器侧以 **1e-9**（ADR-009 的噪声地板）逐元素断言。
  **这层对拍是必须的**：观测归一化写错一侧不会让任何 schema 级测试变红 ——
  信号策略的相位钟（idx 5）就是前车之鉴。
- **运行时归属**：开启「RL 驾驶」后，三辆协商车的**速度归策略**
  （`pythonSpeedStep`，与 ego replay 同一个内核），**转向不归它** —— 转弯由每辆车的
  路线决定（`routeNextRoadId`）。它们豁免浏览器的让行规则：训练环境里没有那条规则，
  让它否决策略的加速度，协商就不可见。其余车辆一切照旧。

实测（真机）：三辆协商车全部按路线通过路口、零碰撞；e2e `drive-policy.spec.ts`
把这一行为钉住。

---

### 5.7 转弯的弧线模型（枢轴 → 弧，ADR-012）

转弯不再是「原地枢轴瞬移」：车到行进末端，沿**二次贝塞尔弧**从当前位姿走到新车道
入口位姿（控制点 = 两条方向线的交点，即角落）。**实测（真 Rapier、90 s、5×5 网格、
67 辆）：重叠帧 5 → 0**，`tick.turning.spec.ts` 把 0 钉住。

三条实现要点（详见 [ADR-012](adr/ADR-012-replacing-the-pivot-with-an-arc.md)）：

- **落位语义**：`roadId / laneIndex / s / heading` 转弯开始即为目标值，
  `Vehicle.turn` 携带弧的控制点与进度；**到长落位帧先把位姿吸到弧终点**再清 turn
  ——否则落位帧位姿在弧中途、5 m 车道护栏恰好触发（实测踩中）。
- **近直行不进弧**（`MIN_ARC_TURN_RAD = 0.1`）：直行 continuation 会在越过入口
  之后才检测到行进末端，「弧」是向后的——车被往回拽、速度冻结（实测 11.83 → 0.03）。
  直行没有扫掠要修，直接落位。
- **两条运动路径同一个弧**：Rapier 路径车身由弧 kinematically 拖（applyControl 与
  Pure Pursuit 让位、body linvel 清零——**转弯中 `readPose().speed` 是 0**，速度
  真值在实体上）；物理无关路径按同一纯函数推进。pathParity 8/8。

### 5.8 Scene 4 v2：网格尺度的协商（基础设施与诚实的测量结论）

单路口的协商（§5.6）成立后，v2 问的是：**同一行为在网格尺度是否还成立**。
基础设施全部落地：

- **冲突点泛化**：`DriveCore._observation` 的冲突点从「全局那一个路口」变为
  **每车自己的下一个真路口**（`_update_next_junction`，随路线推进更新；路线走到
  最后的 stub 时回落到**它刚离开的路口**——全局回落点在网格上是谎言，
  实测 g-1-1 的车读到 (0,0) 的冲突点）。冲突检测按**每个真路口一个盒**
  （迟滞不变）。v1 单路口场景完全兼容（21 项测试不动）。
- **2×2 无信号网格**（`build_unsignalised_grid_network` + `GridDriveEnv`）：
  4 路口、8 边界 stub、6 学习驾驶者 + 2 脚本车，路线从边界 stub 穿到对侧
  stub（跨 1–2 个路口）。脚本基线泛化到「各车自己的下一个路口」。
  **几何 bug 一枚（已修）**：stub 方向判定的两个分量相互污染，g-0-0 的
  东/南 stub 被错误建在连接路上方（实测 12 对 stub 而非 8）。
- **浏览器场景**：「无信号路网」（`buildUnsignalisedGridScene`，2×2、8 车、
  零灯），路线表 `GRID_DRIVE_ROUTES` 与训练 env 的配对一致；tick 的冲突点
  解析为**每车路线上的下一个共享路口**（`junctionIndex.sharedJunctionOf`）。
  实测（真机）：8 辆车全部按路线走完网格、零 crashed。

**训练侧的车辆模型修正五处（2026-11-01）**——它们不是调参，是**模型与现实不符**
的修正；每一处都有实测证据：

| 修正 | 修正前的实测 | 现在 |
|---|---|---|
| **限速封顶** | `always_go` 跑到 **120 m/s**（路限速 16.67） | `min(SPEED_LIMIT_DRIVE, …)` |
| **路线末端停车** | 路线走完后车被投影回起点、**反复打转** | 路线走完 → 速度归零 |
| **Pure Pursuit 追车道点**（原追道路中线） | 一路切弯，x 从 −4.8 漂到 **+13.7**（离车道 18 m） | 目标 = **车道点**（与浏览器 `lanePoint` 同口径） |
| **车道锁定**（位置由车道点决定，heading 仍归 Pure Pursuit） | 车是自由积分的点，与浏览器车道锁定的模型**不同源** | 两侧口径一致 |
| **臂映射修正**（Python 的 `"n"` 臂建在 +z） | 浏览器在 −z ⇒ **两侧不是同一张图** | Python 改 `("n", 0.0, −1.0)` |

最后一条是**真缺陷**：它让此前所有网格数字都建立在「训练图 ≠ 浏览器图」之上。
修正后 **v5 必须重训**（下面那张表就是重训后的数）。

**测量结论（诚实，含 2026-10-31 晚间的课程式攻坚）**：

- v1 策略零样本迁移**失败**（网格上回报 −488，对基线 −328 / −62.9）。
- v2 重训三轮（40k 步，几何修正后）最好 −82.5、**窗口内只通过 1/6 辆**——
  失败模式是**静止均衡**：等待只花延误率（0.1/s），移动要冒冲突/碰撞罚，
  梯度指向「永远让行」。
- **v3（课程式 + 进度/通关奖励）打破均衡**：`DriveCore` 增加
  `progress_reward`（全程 2.0 + 通关 5.0，**网格 env 启用、单路口场景的
  实测奖励不动**）与训练器的 `init_weights`（从 v1 权重起步）。结果：
  **6/6 全部通过**（v2 是 1/6）、回报 −33.5 **胜 `always_go`（−42.8）**、
  延误只有右让规则的 1/3——**冲突 1.8/窗** 仍是与 `right_of_way`
  （−26.5）的差距所在。
- **v4（冲突惩罚再标定 1.0 → 2.0，做成 per-scenario 参数）无进一步改善**
  （−56.2、冲突 1.4）——惩罚加倍没有买到行为改变，策略的冲突是协商残留
  而非「不知礼让」。
- **v5（观测补强 + 保形课程）收敛了冲突项**：观测从 23 → **29 维**——每个
  他车槽位增加 **COMMITTED**（在路口盒内，它不会让）与 **YIELDING**
  （盒外停车，路是我的）两个特征——正是「到达时差说不出对方会不会让」
  的盲区。训练器的权重加载**保形**（新输入列零初始化 → 起步行为与 v1
  完全一致，课程价值不因维度增长丢失）。
- **模型修正后重训的 v5（shipped，现行版本）**：10 seed、300 步窗口、
  2×2 网格、6 学习驾驶者 + 2 脚本车：

  | | 回报 | 冲突 | 碰撞 | 延误 | 通过 | 步数 |
  |---|---|---|---|---|---|---|
  | **v5（shipped）** | **+27.5** | 0.5 | **0.2** | 17.2 | **6.0/6** | 269 |
  | `always_go`（谁都不让） | −75.6 | 1.4 | 1.3 | **6.7** | 6.0/6 | 157 |
  | `right_of_way`（先到先行 + 右让打破平局） | −58.0 | **0.4** | 0.8 | 45.9 | 3.7/6 | 300 |

  **网格协商仍然超过经典规则**：回报 **+27.5 对 −58.0**、冲突 0.5
  （右让 0.4，同量级）、碰撞 **0.2**（右让 0.8）、延误只有右让的 **1/3.7**
  （17.2 对 45.9），且**六辆全部通过**（右让只有 3.7/6——两辆循环等待卡死）。
  回报为正是因为网格 env 开着进度奖励（2.0/m + 通关 5.0）。
  **`always_go` 的回报分布很宽**（逐 seed 实测：−177.6 ~ **+38.4**）：它靠
  抢路跑得快，但每窗平均 1.3 次碰撞，每次 −50 ⇒ 回报被撞车主导。表里的
  均值因此要连着冲突/碰撞一起读。
- **shipped 权重**：随产品附带的驾驶权重为 v5（29 维），前向传播与观测两层
  对拍 fixture 同步重生成（`networkDrivePolicyFixture.spec.ts` 5/5、
  `driveObservationParity.spec.ts` 3/3）。v5 的单路口行为由 e2e 钉住
  （`drive-policy.spec.ts`）。

### 5.9 Scene 4 v3：POI 作为导航终点

§5.8 的协商问的是「谁先过」；这一节问的是「**能不能到地方**」——每个驾驶者
有一个**目的地**（兴趣点），要开到那儿，路上还得跟别的车协商。

**为什么目的地是合成的**：真实 POI 数据不能用来训练——项目自己的深圳福田
OSM 切片（7.29 MB / **51 715 nodes / 7 320 ways**）里 `amenity` 只有 **10** 个，
`shop / leisure / tourism / office / healthcare / historic` **各 0**，
`public_transport` 196，而 parser **没有 POI 通道** ⇒ 零 key 的方案既改 parser
又交不出货。供应商的 POI 要 key（产品侧的管线在 §7）。

所以训练 env **自己摆 POI**（`app/apps/rl/poi_navigation_env.py`）：摆在路网上、
按类别的典型路缘距离摆（4.5–5.5 m，靠右那侧）。**问题形状**与真实数据相同
（目的地在路口对面、路上有别的车），只是坐标是合成的。

三条让它可学的设计（每条都是实测踩出来的）：

1. **POI 必须在路线终点那条臂上**：env 把每个 agent 的路线改成
   `[进场臂, 出-POI 臂]`。否则司机过完路口就**开 away from** 自己的目的地
   （实测：3 辆里只有 1 辆到达）。
2. **POI 在路缘、靠驾驶者那侧**：横向差 9.75 m 时车停在离 POI **12–16 m** 处
   ——**永远到不了**（到达半径 10 m）。现在横向差 4.5–5.5 m。
3. **所有 POI 在同一条街**（间隔 10 m）：各走各的臂时**根本没有冲突**
   （`always_go` 3/3 到达、零冲突）——那不是协商题。改成同一条街后，
   谁先到谁挡着谁（`always_go` 2/3 到达、3.4 次碰撞/窗）。

**观测与奖励**：观测 **33 维** = 29 维基础（§5.8 的 v5 口径）+ **4 维目的地**
（ego 帧下的目标偏移 x/z、距离/100、到达标志）。shipped 的 29 维策略
**权重形状不变**——POI 任务用另一套权重，不覆盖随产品附带的那份。

```
reward = -(自己的延误 + 造成的他人延误) - 冲突 - 碰撞
       + 0.2 每米（朝目的地靠近） + 20（到达，到达半径 10 m）
```

量级是量过的：60 m 的车程赚 12、到达再赚 20，而**一次碰撞罚 50** ⇒
**撞穿过去从来不划算**。

**实测（10 seed、3 驾驶者、400 步窗口）**：

| | 到达 | 冲突 | 碰撞 | 延误 | 回报 |
|---|---|---|---|---|---|
| **学到的策略** | 1.9/3 | **0.4** | **2.3** | 36.3 | 6 586 |
| `always_go`（谁都不让） | **2.0/3** | 1.0 | 3.4 | **3.1** | 13 238 |

**这张表怎么读**：学到的策略**冲突降到 1/2.5、碰撞少 1/3**，代价是**到达数
没变多、延误高得多**（36.3 对 3.1——它更保守，让别人先过）。**回报不可直接比**
（基线不减速，一路累积的进度奖励更多）⇒ 训练器的选优因此改成**按任务指标**
（`drive_mappo.evaluate_policy`：到达数优先、回报次之；此前按累计 return 选，
选到的是「磨蹭但累计多」的策略：2287 @ step 15 000 对末步 577）。

**诚实的结论**：这一版**没有**训出「又快又安全地送到」的策略——学到的是
「会协商，代价是慢」。**未解**：进度奖励与延误归因再平衡、按到达数直接
做课程（先单目标、再多目标）、或把延误归因限制在**路口附近**而不是全程。

### 5.10 限高与高程：一条规则、它的物理对偶，和一处物理里还不存在的面

**规则层**（`src/domain/services/roadAccess.ts`）：一条路可以带 `maxheight`，判据是
`VEHICLE_BODY_SPEC[type].height + ROAD_MIN_HEIGHT_CLEARANCE_M (0.2 m) ≤ limit`。
生成器与变道调用它，**不让** 3.4 m 的公交驶入 3.5 m 的春风隧道。

**规则管不到「已经在路上」的车**。2026-11-13 之前，物理世界里**没有任何高度方向的碰撞体**
——已经驶入的车会直接从隧道顶下钻过去。规则只在「能不能进这条路」这一层生效，
而隧道的顶是**画出来的**，不是**撞得到的**。

**物理对偶：门架**（`src/domain/services/clearanceBeams.ts` + `RapierWorld.syncClearanceBeams`）。
每条限高路派生**两个**门架（路的两端各一个），梁底高度与规则用同一个数：

| 项 | 值 | 为什么是这个数 |
|---|---|---|
| 梁底 | `limit − 0.2 m` | 与规则同一个门槛：3.4 m 的公交（+0.2 = 3.6 > 3.5）两边都过不去，1.6 m 的小车两边都过得去。梁若取 3.5 m，规则与物理会在边界上互相打脸 |
| 位置 | 路的**两端** | 铺满整条路会把已经进隧道的公交**困在里面**（进得去、出不来） |
| 半宽 | `roadWidthM / 2 + 0.5` | 盖住整条车行道，余 0.5 m 给贴边的车 |
| 厚度 | 0.3 m | 15 m/s 时一步 0.25 m ⇒ 不会穿模 |

门架的 collider **不进车辆表** ⇒ 接触事件被跳过：**公交顶到门架不是「碰撞」，是「它进不去」**。
实测：随包福田城区（春风隧道 3.5 m）公交 5.8 → 0.1 m/s 停在门口，小车穿过；
`tests/e2e/clearance-physics.spec.ts` 钉住这个行为。

**高程是另一回事，而且更彻底**：路点带 `y`、车道几何还带 `pitch`（坡度），但
**Rapier 世界是一块平地，高架与匝道没有碰撞体** —— 它们在场景图里是折线，不是刚体。
车在坡上的高度是**应用层告诉物理的**（`tick.ts` → `setVehicleHeight(id, roadY)`），
物理只负责水平运动。含义：**桥面今天撞不到**，不是漏了守卫，而是**那个面在物理里不存在**。
补桥面碰撞体意味着「高度从被赋值变成被接触求解」，那是另一类改动。

---

## 6. 跨语言契约边界

这一节是整个仓库里最容易理解错的地方，所以单列。

### 6.1 为什么需要它

Python 的训练 sim（`app/apps/rl/sim_core.py`）与 TypeScript 侧是**同一套交通模型的两份独立实现**。
契约要保证的是：**在 Python 里训出来的 PPO 策略，在浏览器里表现一致**，
而且任何一侧的漂移由测试捕获，而不是等用户看到一次糟糕的驾驶才发现。

### 6.2 机制：影子 sim + 双 oracle + golden 快照 + 变异门禁

- **影子 sim（mirror）**：`src/application/services/simCoreMirror.ts` 是 Python sim 的
  1:1 TS 移植（同样的常量、同样的方程、同样的终止规则、同样的 reason 字符串）。
  它存在的原因是：产品侧的 TS sim 是**车道制 + Rapier 驱动**的沙盒，
  与 Python 的自由空间模型结构上不兼容（跨语言差异 #6），
  直接比产品 sim 的完整轨迹没有意义。mirror 的 ego 运动学不重写，
  直接用 `src/domain/services/egoKernel.ts`，因此 mirror 与产品不可能在 ego 模型上分叉。
- **golden 快照**：`TraffSim3D-backend/tests/contract/snapshots/` 下有
  `ts_<name>.json`（场景级：终止原因、轨迹、灯态、词表块、`road_rules` 块、`scene_light` 块）、
  `ts_kernel_<name>.json`（内核级：ego 速度序列），
  以及每次运行重新生成、**gitignored** 的 `python_<name>.json`。
- **双 oracle**：两个方向各有一个门禁，缺一不可。
  - `pytest tests/contract/` —— 跑**活的 Python sim**，与**已入库的 TS golden** 逐字段比对。
  - `npm run contract:check` —— 从**TS 源码**重新生成 golden，与已入库的 golden 比对。
  - 只跑前者：改了 TS 源码，Python 仍然匹配**旧** golden，门禁照样绿，
    TS 实现已经悄悄漂走而不被发现。
  - 只跑后者：只证明 golden 与 TS 代码一致，不证明两份实现彼此一致。
- **CI 里两个 oracle 在同一个 job**（`.github/workflows/ci.yml` 的 `contract` job），
  这是保护模型的那道门。
- **变异门禁**：契约向量不是摆设 —— 改掉 `LOOKAHEAD_DISTANCE` / `MAX_STEER` /
  `EGO_WHEELBASE` / `ROAD_HALF_WIDTH` / `SCENE_GOAL_Z` 等常量后，契约会红。
  这些是被写成测试的「变异校验」，不是一次性的手工测量。

### 6.3 已验证的与未验证的

契约的覆盖面与盲区以 **[contracts/sim-snapshot.md](contracts/sim-snapshot.md)** 为准（那里有逐项表格与实测数据）。
结论层面：

- **已验证**：ego 运动学（速度积分、航向积分、转向限幅）、场景终止规则与 reason 字符串、
  轨迹采样点、灯态比特、信号动作词表（五个名字 + 三个语义常量，逐项比对）、
  动作驱动的轨迹（两侧在同一施加同一动作序列，轨迹仍逐位相等）、
  离散策略的前向（同一权重、同一观测 → 同一个动作下标，由一份提交的 fixture 把关）。
- **具名盲区**（同一份文档里有完整表格）：
  交通模型本身（NPC 行为、场景半径、`ROUNDABOUT_RADIUS` / `NPC_SPEED`）在当前向量里不可观测；
  `INTERSECTION_RADIUS` 只经「闯红灯判定窗口」露出——实测（2026-10-24）改成 14 / 15 m 时
  恰好 2 个 golden 位移，不改变闯红灯时刻的改动则看不见；
  **训练 sim 的 8.0 m 是字面量，不是推导值**，它与产品侧按车道模型推导的路口盒
  （cross 场景 6 车道 → 10.5 + 4.5 = 15.0 m）是**两个不同的量**：训练 sim 的车辆是**点**
  （`Vehicle` 没有长度，碰撞判定与排队间距都是中心距，停车规则与路口占用判定都作用在车心），
  所以产品侧那个「车头越过停止线」的净空项在这里**并不存在**；8.0 m 是相对车行道
  （`ROAD_HALF_WIDTH` = 3.5 m）的**实测余量**，被两件事锁住——训练奖励基线
  （实测 14.0 m 时 10 个用例变红）与契约的采样栅格（实测：闯红灯终止步落在 10 步采样点上的
  半径窗口只有 (7.852, 8.541] / (13.712, 14.172] / (17.274, 17.504] m，后两个窗口虽然保住栅格，
  仍会移动已入库的 golden）。逐条见 [contracts/sim-snapshot.md](contracts/sim-snapshot.md)；
  交通灯相位时长只在首次换相落进采样窗口时被抓到；
  奖励函数与 `SimCore.light_cycle_seconds` 是**两个训练用旋钮**，契约不比较；
  观测编码（L2）、产品的 Rapier 路径、非 0.1 s 的 dt、产品的完整车道轨迹同样不在契约内。
- **相等判定不是无条件的**：直线向量用精确 `==`；会转向的轨迹在有界噪声地板内比较
  （`_LIBM_NOISE_FLOOR = 1e-9`），因为 V8 的 `Math.sin` / `Math.atan2` 与 CPython 的
  `math.sin` / `math.atan2` 是两套实现，对部分角度差 1 ULP。
  这条判定规则的决策记录在 [adr/ADR-009](adr/ADR-009-contract-equality-and-the-libm-noise-floor.md)，
  它收窄了 [adr/ADR-008](adr/ADR-008-cross-language-contract-oracles.md) §D3 的适用范围。

### 6.4 观测维度的归属

> **14 维 ego 观测的权威定义在 Python 侧**：`app/apps/rl/sim_core.py` 的 `OBS_DIM = 14`，
> 配套的规格写在 [contracts/sim-snapshot.md](contracts/sim-snapshot.md)。
> 前端的 `src/application/services/tick.ts` 与 `src/shared/constants/simulation.ts` 对齐 Python，**不反向**。
> 改观测的维度、顺序或归一化，必须先改 Python 与契约，再改前端。

---

## 7. 地图（OSM）管线

**坐标系**：管线全程 WGS84。国内**高德（GCJ-02）/ 百度（BD-09）** 导出的文件
在解析入口由 `app/apps/maps/coord_transform.py` 转换（`/maps/parse-osm|parse-pbf`
的 `coord` 参数，默认 `wgs84`；转换发生在**米制投影与 bbox 裁剪之前**，所以
bbox 与文件同系）。GCJ-02 无公开精确反演——实现是标准的偏移迭代反解
（收敛 1e-9 度）；BD-09 → GCJ-02 是公开精确公式。**域外坐标原样返回**
（对境外数据应用偏移反而是几百米的错误）。边界内拒绝解析未知的 datum
（静默当 WGS84 会让地图偏 300–600 米且无任何信号）。

**兴趣点叠加**（`POST /maps/poi` → `app/apps/maps/poi.py`）：POI 来自
**OpenStreetMap**（经公共 Overpass API），按**路网自己的投影原点**投影到本地米制
（`x = (lon − origin_lon)·111000·cos_lat`、`z = (lat − origin_lat)·111000`，
与 `osm_parser` 同一个公式）——POI 因而落在它所属的路口上。**没有 Key**：
OSM 不需要账号、不需要配额、不产生账单。OSM 的坐标本来就是 WGS84（与路网同系），
所以这一条路径上**没有任何基准转换**（高德/百度的 GCJ-02/BD-09 需要先反解，
那个偏移是几百米）。前端的图层是**一个 InstancedMesh**（`PoiLayer.ts`，整批 POI
一次 draw call），标记按类别着色、选中时高亮；POI 不可被编辑器的拾取命中
（它们是信息，不是场景物件）。

选择 OSM 而不是商业 provider 的代价是**速度与稳定性**：Overpass 是志愿者运营的
公共服务，实测一个场景尺度的矩形要 **50–73 s**（服务繁忙时），繁忙时还会 502/504
（实测同一个查询在 1 分钟内先 200、再 502、再 504）。因此：抓取走**实例链**
（`overpass-api.de` → `kumi.systems` → `private.coffee`，共享一个 **100 s 总预算**，
后面的实例只拿到剩下的额度，避免不可达的镜像把等待乘三），响应**写磁盘缓存**
（同一个矩形第二次加载是瞬时的），浏览器的超时是 **120 s**。
类别由 tag 的**取值**决定（`amenity=restaurant` → 餐饮、`amenity=hospital` → 医疗、
`shop=*` → 购物），未列出的取值回落到 tag 的类别；约四分之一的 POI **没有名字**
（面板显示「(无名)」），OSM 在中国的 `addr:*` 门牌数据也很少（多显示「无地址」）。
查询只取 **node**——输出配额本来就先被 node 填满（实测 node-only 与 node+way 的
查询返回了**完全相同**的 300 个要素），多要 way 只会更慢。
关键词过滤是**同一个语句上的 AND**（`node["amenity"]["name"~"咖啡",i]`），
不是独立语句——Overpass 的 union 语法是 OR，独立语句会把查询**放宽**而不是收窄。

```mermaid
flowchart LR
  turbo["Overpass Turbo<br/>导出 .osm"]
  upload["MapImporterView<br/>src/interfaces/views/MapImporterView.vue"]
  api["POST /maps/parse-osm<br/>POST /maps/parse-pbf"]
  parser["osm_parser<br/>app/apps/maps/osm_parser.py"]
  net["RoadNetwork dict<br/>roads / nodes"]
  graph["road_graph<br/>app/apps/maps/road_graph.py"]
  astar["shortest_path<br/>A* 有向图最短路"]
  scene["前端场景<br/>worldStore"]

  turbo --> upload --> api --> parser --> net
  net --> graph --> astar
  net --> scene
```

- **入口**：`/map-importer` 路由页 `src/interfaces/views/MapImporterView.vue`。
  用户在 Overpass Turbo 跑模板查询、导出 `.osm`，再上传。
- **客户端**：`src/infrastructure/api/osmImportClient.ts`。它负责拼 `bbox` 查询参数
  （顺序 `south, west, north, east`，与 Overpass QL 一致）并在上传前做本地校验；
  **后端仍然独立校验**，前端校验只是便利，不是执行点。
- **后端解析**：`app/apps/maps/osm_parser.py` 的 `parse_osm_xml()` 与 `parse_osmpbf()`
  （后者走 libosmium 流式读二进制）。`MAX_BBOX_DEG = 0.5` 是**内存安全上限**，
  不是「按场景裁剪」—— 不传 bbox 时的行为是丢弃离数据质心超过该半径的远点。
- **图与寻路**：`app/apps/maps/road_graph.py` 的 `RoadGraph.from_network()` 把解析结果
  建成有向图，`shortest_path()` 用 A\* 求最短路（`to_dict()` / `from_dict()` 支持 JSON 往返）。
- **Overpass 代理与缓存**：`app/apps/maps/overpass_cache.py` 的 `cached_overpass_fetch()`
  把响应写到 `TraffSim3D-backend/geojson/cache/<hash>.json` 并复用，
  避免每次打开页面都重新请求；`GET /maps/overpass/cache` 列出已缓存的查询。
  缓存目录 gitignored（见根 `.gitignore`）。
- 前端侧还有 Cesium 底图路径：`src/infrastructure/cesium/viewer.ts`、`src/infrastructure/cesium/cameraSync.ts`、`src/infrastructure/cesium/loadOSMScene.ts`，
  以及按需注入的 Cesium 运行时 `src/infrastructure/cesium/loadCesiumRuntime.ts`。

**底图与路网必须同源同基准**（2026-11-01 换源，ADR-015）。底图现在用
**OpenStreetMap 的瓦片**（社区镜像 `tile.openstreetmap.de` 的 a/b/c 三个子域），
**和路网数据同源、同样是 WGS84** ⇒ 底图上的道路与叠加的 OSM 道路折线**严丝合缝**。
原来的高德瓦片是 **GCJ-02**（火星坐标），在项目自己的原点处偏
**东 525 m / 南 301 m（|d| = 605 m）**——同一批道路折线画在底图上时整体错开
半公里（实测截图：高德底图下画面中心是人民大会堂、OSM 折线在天安门广场西侧；
OSM 底图下画面中心正是天安门、折线贴着底图的道路走）。官方
`tile.openstreetmap.org` 在本网络不通（21 s 连接超时），所以用社区镜像；OSMF 的
瓦片政策仍然适用（轻量使用、不得批量下载、应用要自报身份），因此署名
（`© OpenStreetMap contributors`）**显示在画面上**。

代价是**慢**：镜像每张瓦片 1–4 s，Cesium 的 LOD 链从 z1 一路铺到 z16 实测约 **90 s**
才铺满（高德瓦片 1.5 s/张但错位）。另外 Cesium 的相机读数是**弧度**
（`positionCartographic` 返回 radians，不是 degrees）——排查时差点因此误判
「相机跑到了几内亚湾」。

**首屏 7.7 s**：Cesium 的瓦片四叉树是自上而下逐级走的（子瓦片要等父
瓦片），离地 1 500 m 的相机要串行走 15 级（z1→z16），实测整条链 90–190 s。
**祖先瓦片很小**（约 25 张、每张几 kB）⇒ 浏览器**并行预取**进 HTTP 缓存
（`tilePrefetch.ts`，限并发 6），Cesium 再要时是缓存命中 ⇒ **首张 z16 瓦片
90–190 s → 7.7 s**，且**不动任何质量参数**。换镜像没用（实测中位 996 ms vs
764 ms，只快 23 %；官方主机与 Carto 在本网络不通）。坑：相机高度**不是**缩放
级别（当缩放用会一次请求 1 501 张 ⇒ 浏览器 `ERR_INSUFFICIENT_RESOURCES`、
一张都加载不了）。

**Smart City 的默认城市是深圳福田**（原点 114.06865, 22.54297 = 项目自己
那份 `geojson/福田中心(深圳).osm` 的质心）：底图、POI、导入的地图讲的是同一
个地方（原来的天安门是个与数据无关的占位锚点）。

**底图此前从未可见过**（既有缺陷，已修）：渲染器虽然用 `alpha: true` +
`setClearColor(0x000000, 0)` 清成透明，但 Three.js 会**先铺满 `scene.background`**
（0x0b1220）——透明清屏救不了它，整个 Cesium 底图被挡在下面。修法是
`ThreeJSRenderer.setTransparentBackground(true)`（`scene.background = null`），
**只在 Smart City 视图里开**（场景编辑器要的就是那个深色背景）。
实测：把 Three.js 画布隐藏后底图立刻完整出现——它一直都在那儿，只是被挡住了。

---

## 8. 可复现的门禁

以下都是**命令**，不是结果数字。数字会漂，命令不会；跑一遍就知道自己这份工作树的真实状态。

### 8.1 后端

```sh
cd TraffSim3D-backend

# 全量单测
.\.venv\Scripts\python.exe -m pytest

# 覆盖率（CI 用同一命令，且带阈值）
.\.venv\Scripts\python.exe -m pytest --cov=app --cov-fail-under=70 -q

# 契约（Python oracle）
.\.venv\Scripts\python.exe -m pytest tests/contract/ -v

# lint / 格式
.\.venv\Scripts\ruff.exe check .
.\.venv\Scripts\black.exe --check . --extend-exclude 'app/apps/rl/sim_core.py'
```

- **不要用 `uv run`**：这台机器上 uv 的 HTTP 客户端会挂起而不是报错，
  `uv sync` 可能永远不返回。直接用 `.\.venv\Scripts\python.exe`。
- **装包用更快的镜像源**：
  `.\.venv\Scripts\python.exe -m pip install -i https://mirrors.aliyun.com/pypi/simple/ <pkgs>`。
- **`--cov` 必须用点号模块名**：`--cov=app.apps.rl.weights` 有效；
  `--cov=app/apps/rl/weights.py`（斜杠路径）在 coverage 7.16.2 下**静默无数据**，
  只打一条 `CoverageWarning` 然后输出 `No data to report`，极易被误读成「覆盖率 0%」。
- **black 用 `--extend-exclude`，不要用 `--exclude`**：后者会**替换** black 的默认排除列表
  （默认列表里含 `.venv` / `.git` / `node_modules`），一次 `black . --exclude` 就把
  1983 个 venv 里的第三方文件格式化，而 `.venv` 是 gitignored、`git checkout` 撤不回来。
  跑任何批量格式化之前先用 `--check` 看规模。

### 8.2 前端

```sh
cd TraffSim3D-frontend

npm install            # 一次性
npm run test:run      # Vitest 单测
npm run test:coverage # 单测 + 覆盖率（vitest.config.ts 里四项阈值都是 70）
npx vue-tsc --noEmit  # 类型检查
npx eslint .          # lint（CI 不带 --fix；npm run lint 带 --fix）
npx prettier --check .   # 格式检查（npm run format 写回）
```

- `npm run contract:check` 是**契约的 TS oracle**（等价于 `npm run test:contract`），
  与后端的 `pytest tests/contract/` 必须一起跑。

### 8.3 e2e（Playwright）

```sh
cd TraffSim3D-frontend
npm run test:e2e          # 全部
npm run test:e2e:perf     # 只跑性能测量用例
npm run test:e2e:headed   # 有头模式
```

前置条件与注意事项：

- **端口归属先确认**。`playwright.config.ts` 的 `webServer` 设了 `reuseExistingServer: true`，
  `use.baseURL` 与 `webServer.url` 都硬编码在 **5173**。
  如果 5173 上跑的是**别的项目**的 vite，Playwright 会静默复用那个服务，
  整套 e2e 等于在对着别的应用跑 —— 表现为大面积超时，而代码其实没坏。
  先查归属：

  ```powershell
  Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine
  }
  ```

  不是本仓库的 vite 就**不要去 kill 别人的进程**，换独立端口跑本项目：
  后端 `.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8001`，
  前端 `$env:VITE_BACKEND_PORT = '8001'; npm run dev -- --port 5188 --strictPort`。
  注意 Playwright 的配置里的 `use.baseURL` **优先级高于** `PLAYWRIGHT_TEST_BASE_URL`
  环境变量，所以只改环境变量不生效，要像 CI 那样生成一份覆盖配置
  （参考 `.github/workflows/ci.yml` 里生成 `playwright.ci.config.ts` 的那一步）。
- **视觉回归基线在仓库根的 `e2e-output/baseline/`**（不在 frontend 子目录），
  容差 `maxDiffPixelRatio: 0.005` 是**实测**出来的，不要为了让真实改动过关而调高它。
- **e2e 本身在 CI 里是非阻塞的**（`continue-on-error: true`）：那批基线是在
  Windows + Chromium（SwiftShader）上录的，Linux runner 的像素输出本来就预期会不同。

---

## 9. 运行时路径与持久化

### 9.1 浏览器侧

- **场景存档**：`src/infrastructure/persistence/sceneSerializer.ts` 的
  `SCENE_SCHEMA_VERSION = 6`，序列化体带 `schemaVersion` / `savedAtMs` / `network`。
  `src/infrastructure/persistence/LocalStorageAdapter.ts` 用的 key 是 `traffsim3d:scene:v${SCENE_SCHEMA_VERSION}`，
  **带版本号**，所以改 schema 时旧存档不会被误读。
- **导入导出**：`src/application/use-cases/importSceneFile.ts` / `src/application/use-cases/exportSceneFile.ts`。
- **轨迹导出**：`src/infrastructure/export/TrajectoryExporter.ts`。

### 9.2 后端 RL 运行时

`app/apps/rl/paths.py` 是唯一的路径来源，三个运行时路径都锚在
`TraffSim3D-backend/.data/` 下（**gitignored**）：

| 产物 | 默认位置 | 单独覆盖的环境变量 |
|---|---|---|
| checkpoint | `.data/ppo_checkpoints/<pid>/` | `PPO_CHECKPOINT_DIR` |
| 训练状态 JSON | `.data/training_status.json` | `TRAFFIC_PPO_STATUS` |
| 暂停/恢复/终止控制文件 | `.data/training_control.json` | `TRAFFIC_PPO_CONTROL` |

- **整体迁移**：`TRAFFIC_RL_DATA_DIR` 一次挪走三个（优先级最高）。
- **路径锚在包自身位置上，不是 cwd** —— 从哪个目录启动 uvicorn、哪个盘符，结果都一样。
- **控制通道是文件，不是信号**：训练是独立子进程，Windows 没有 SIGSTOP，
  所以暂停/恢复/终止走「API 写控制文件 → 训练器的 step 回调轮询」。
  `POST /rl/train/pause` 之类端点在没有活跃训练时返回 **409**。
- 路径相关的具体推导与理由见 `app/apps/rl/paths.py` 的模块 docstring，
  回归测试在 `TraffSim3D-backend/tests/test_rl_paths.py`。

---

## 10. 给接手者的注意事项

以下是**前瞻约束**（写下来是为了下次别踩），不是事故复盘。

1. **观测维度只能从 Python 侧改**。`OBS_DIM = 14` 在 `app/apps/rl/sim_core.py`。
   前端 `src/application/services/tick.ts` 的 `const OBS_DIM = 14` 与 `src/shared/constants/simulation.ts` 的
   `PYTHON_SIM` 块都是**对齐物**，不是来源。
2. **`app/apps/rl/sim_core.py` 保持 CRLF 行尾**（该文件当前是纯 CRLF）。
   这个模块是契约的敏感区：换行尾会被 `git diff` 整文件刷屏，掩盖真正的改动。
   同理，black 的格式检查要 `--extend-exclude` 掉它。
3. **契约测试不能跳过**。`tests/contract/` 的比对测试在 TS 快照缺失时**失败**而不是跳过 ——
   跳过等于让两侧悄悄分叉。TS 侧快照由
   `TraffSim3D-frontend/scripts/generate-contract-snapshots.ts` 生成并入库。
4. **改 golden 前先想清楚**。golden 是**提交进仓库的产物**：
   改 TS 源码而不重录 golden，Python oracle 依然绿 —— 这正是 TS oracle 存在的理由。
   重录会改很多文件，先确认改动是预期的。
5. **端口 5173 / 8000 不独占**。它们常常被本机其它项目占着。
   跑 e2e 前先查归属，别杀别人的进程；用 5188 / 8001 这类独立端口。
6. **提交信息用 `git commit -F <file>`**，不要用 `git commit -m` ——
   PowerShell 会把中文提交信息写成 U+FFFD 替换字符。
7. **`black` 不读 `.gitignore`**。临时脚本、虚拟环境、生成物在跑格式化前要么删掉，
   要么显式 `--extend-exclude`，否则一次 `black .` 能改掉上千个文件。
8. **`--cov` 的斜杠路径静默失效**。用点号模块名，见 8.1。
9. **委派出去的实现任务，要让 worker 自己提交**。否则成果留在别人的工作区里，
   谁也拿不到 —— 也不要为了「干净工作区」去 `git stash` / `git reset --hard` /
   `git checkout --`，那会毁掉别人尚未提交的成果。
10. **依赖下载优先走更快的镜像源**（pip 用 `mirrors.aliyun.com/pypi/simple`，
    npm 用 `registry.npmmirror.com`）。这台机器到海外 CDN 的出站链路慢且间歇性不可达，
    「装不上」通常是网络问题，不是包不存在 —— 下结论前先换镜像复验。
11. **装 RL 栈用可选依赖**：`pip install -e ".[dev,rl]"`。没有 SB3 时，
    后端测试会静默走「无 SB3 回退路径」，RL 引擎实际上根本没被执行。
12. **策略迁移不是必然的**。同一配置多种子训练，训练侧全胜不等于浏览器侧全胜 ——
    实测离散度与原因见 5.4。改动训练参数或重录资产前，先读那一节。

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| [adr/ADR-001 … ADR-015](adr/) | 决策记录。001 前端框架 · 002 后端框架 · 003 物理引擎 · 004 RL 框架 · 005 DDD + 前后端切分 · 006 OSM → 内部图 · 007 部署方式（Rejected）· 008 契约的两个 oracle · 009 契约的相等判定与 libm 噪声地板 · 010 路线规划与第一人称相机 · 011 无信号路口的多车协商 · 012 转弯从枢轴改为弧线 · 013 POI 作为导航终点 · 014 兴趣点来自 OpenStreetMap（不用需要 Key 的商业服务）· 015 底图也来自 OpenStreetMap（与路网同源同基准）。 |
| [contracts/sim-snapshot.md](contracts/sim-snapshot.md) | 跨语言契约：**覆盖什么**、**不覆盖什么**（含具名盲区表）、向量清单、跨语言差异状态表。 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署：镜像配置、安装、端口、运行时数据目录、故障排查。 |
| [USER-GUIDE.md](USER-GUIDE.md) | 用户向：四个模块的界面用法与术语表。 |
| [../README.md](../README.md) | 项目总览：能做什么、怎么跑起来、技术栈。 |

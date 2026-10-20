# Cross-Language Sim Contract (Plan 050)

> **状态（2026-10-20 更新）：本契约当前处于「休眠」状态，且其原始前提经核查为不成立。**
> 详见下方「实际差异清单」。历史上本文件声称两个 sim「共享同样的 ego 动力学公式」，
> 这条说法**与源码不符**；比对测试因为 TS 侧快照生成器从未实现而一直**跳过**
> （不是失败），所以这个错误前提长期没有被暴露。

## Why this exists

The Python sim (`TraffSim3D-backend/app/apps/rl/sim_core.py`) and the
TS sim (`TraffSim3D-frontend/src/application/services/tick.ts` + domain
entities) are **independent implementations** — not a 1:1 port. They
were intended to share the ego dynamics (Pure Pursuit + Euler integration)
so a PPO policy trained in Python behaves the same when replayed in the
browser.

**However, a source-level audit on 2026-10-20 found they do not** — see
「实际差异清单」 below. The contract test is therefore *behavioral*, not
state-equality, and it has never actually run.

## 实际差异清单（2026-10-20 逐行核对源码；2026-10-20 已修 #1/#2）

| # | 维度 | Python `sim_core.py` | TS `tick.ts` / 域服务 | 状态 |
|---|---|---|---|---|
| 1 | 交通灯相位 | 布尔 `ns_green`/`ew_green`，每 30s 直接互换，**无黄灯**（`:57-60`、`:258-260`） | 有 Green/Yellow/Red/AllRed 相位，30s 绿 + **3s 黄**（`shared/constants/simulation.ts:24-26`、`tick.ts:167-178`） | ⚠️ **已缓解**（见下） |
| 2 | `obs[6:8]` 语义 | `1.0 if ns_green else 0.0`（`:335-336`） | 原先只设 ego 自己那根轴的位、且用「相位 == Green」→ 黄灯期退化成 `(0,0)` | ✅ **已修**（Plan 069） |
| 3 | Pure Pursuit 分母 | **常数** `LOOKAHEAD_DISTANCE = 8.0`（`:40`、`:213`） | **实际距离** `ld`（`domain/services/purePursuit.ts:100`） | ❌ 未修（独立议题） |
| 4 | 转向限幅 | `MAX_STEER = 0.4` rad（`:41`） | `±π/4` ≈ 0.785 rad（`purePursuit.ts:103`） | ❌ 未修（独立议题） |
| 5 | 朝向积分 | `heading += steer * DT`（直接积分，`:212`） | 经 Rapier 角速度 `omega = delta * 2.5`（`purePursuit.ts:46-48`、`tick.ts:364-365`） | ❌ 未修（独立议题） |
| 6 | 运动约束 | 自由空间（`x += speed*cos(heading)*dt`） | 沿车道弧长 `s` 运动，位置是 `lanePoint(road, laneIndex, s)` 的函数（`tick.ts:371-386`） | ❌ 未修（独立议题） |
| 7 | 速度积分 | `speed = clip(speed + accel*3*DT, 0, 16.67)`（`:211`） | 无 Rapier 时 `smoothAccel(speed, targetSpeed, dt, type)`（`tick.ts:374`） | ❌ 未修（独立议题） |

**一致的部分**：`obs[13] = clip(y/10, -1, 1)` 两边相同（`sim_core.py:335` vs `tick.ts:713`）；
`obs[0:3]` / `obs[3]` 的归一化常数（50m / π / 16.67 / 50m）相同；
`obs` 总维数 **14**（TS 代码正确，`tick.ts:654` 的 `OBS_DIM = 14`；
但 `tick.ts:189` 与 `tick.ts:649` 的**注释**仍写「13-dim」，属注释漂移）。

### #1 / #2 的修复（Plan 069）

`buildReplayObs` 现在按 **Python 的语义**上报灯光位：

- **两轴各自独立、且与 ego 朝向无关** —— `obs[6]` 恒为 NS 轴状态、`obs[7]` 恒为
  EW 轴状态。原先只设 ego 自己那根轴，另一轴对策略**完全不可见**。
- **恒为 one-hot** —— Python 的 `ns_green`/`ew_green` 由同一个布尔量派生、
  必然互补，所以策略只见过 `(1,0)` 与 `(0,1)`。TS 侧现在同样保证
  `obs[6] + obs[7] == 1`，**绝不**让策略看到 `(0,0)`（全红清空期）或 `(1,1)`。
  退化配置（两轴同时可通行 / 同时不可通行）按固定规则消解：
  两轴都可通行 → NS 优先；都不可通行 → 报 `(0,1)`（读作「NS 需停车」，
  正是全红清空期该有的动作）。
- **「可通行」= 绿灯或清空黄灯**（`MAY_GO`）。这样 TS 的 3s 黄灯不会让
  观测跌到 Python 观测空间之外。
- **每根轴取「主灯」**（非左转相位），避免 `greenLeft` 掩盖红灯直行灯。

**残余差异**：Python 的「绿灯窗口」是 30s，TS 因为多了 3s 黄灯是 33s
（相位翻转点比 Python 晚 3s）。这是 TS 物理信号灯本身的结构差异，
**不是观测编码问题**，无法在不改动 TS 信号灯模型的前提下消除。

> 另需留意：Python 的 `MAX_STEPS_DEFAULT = 200`（20s）**短于**它的 30s
> 灯光周期，所以 Python 训练出的策略实际上**从未见过灯光切换**。
> 浏览器回放若跑过 30s，策略仍会收到它训练时没见过的 `(0,1)`。
> 这是「训练 episode 上限 < 灯光周期」带来的更深一层失配，
> 独立于本契约，记入 the cross-language contract (ADR-008) 的遗留项。

## What the contract checks

For each scene (`cross`, `corridor`), with a fixed deterministic
action sequence, BOTH sims must:

1. Start ego at the same position/heading
2. Terminate with the same `reason` (e.g. both "success" or both
   "success_corridor")
3. Terminate within ±20% of the same step count
4. Reach roughly the same final `z` (within 1m)

NPC state is **not** compared.

> **这些要求目前无法达成** —— 不是因为「少写了个生成器」，而是因为上面
> 7 条差异中有 6 条是结构性的（运动模型、灯光相位、观测语义）。
> 详见 the cross-language contract (ADR-008)。

## How to run locally

```sh
# 1. 运行 e2e 生成 TS 侧快照 —— **该测试从未实现**（2026-10-20 核实）。
#    契约文档此处描述的是计划中的流程，不是现状。
cd TraffSim3D-frontend && npm run test:e2e -- contract-snapshot
#   → 应写入 tests/contract/snapshots/ts_<name>.json（目前不会发生）

# 2. 运行后端契约测试
cd ../TraffSim3D-backend
uv run pytest tests/contract/ -v
#   → test_python_consistency_baseline 始终通过（只校验 Python 侧）
#   → test_python_and_ts_terminations_match_when_ts_snapshot_exists
#      因缺少 ts_*.json 而**跳过**（不是失败）
```

If only the Python snapshot exists, the consistency test **skips**
(not fails). The CI pipeline must run e2e before backend tests.

## How to update snapshots

When sim behavior intentionally changes (e.g. reward tuning, new
Pure Pursuit constants):

1. Re-run the e2e test to refresh the TS snapshot:
   ```sh
   cd TraffSim3D-frontend && npm run test:e2e -- contract-snapshot
   ```
2. Re-run the backend test to refresh the Python snapshot AND verify
   both match:
   ```sh
   cd ../TraffSim3D-backend && uv run pytest tests/contract/ -v
   ```
3. The Python snapshot regenerates on every run (it's a regular test).
   The TS snapshot must be regenerated manually via e2e.
4. Commit both source changes and the regenerated TS snapshot.

If the consistency test fails after a sim change:

- `final_z` diverges by > 1m → check that speed cap / dt are still
  the same in both sims (`SPEED_LIMIT` constant in both, `DT = 0.1`
  in Python sim, `requestAnimationFrame` driven in TS)
- `final_step` diverges by > 20% → check the termination threshold
  (`ego.z > 25` for corridor, `ego.z > 25` for cross); both should
  be 25.
- `reason` differs → one sim terminated (collision / red_light) but
  the other didn't. Check NPC positions in both sims at the relevant
  z range.

## File layout

```
tests/contract/
├── __init__.py
├── test_vector.json                       # fixed inputs (git tracked)
├── test_python_snapshot.py                # Python snapshot generator
├── test_cross_lang_consistency.py         # compare Python + TS
└── snapshots/                              # generated, gitignored
    ├── python_cross_baseline.json
    ├── python_corridor_baseline.json
    ├── ts_cross_baseline.json             # from Playwright e2e — 未生成
    └── ts_corridor_baseline.json          # from Playwright e2e — 未生成
```

The `test_vector.json` and the test scripts are the contract; the
JSON snapshot files are the comparison data.

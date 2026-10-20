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

## 实际差异清单（2026-10-20 逐行核对源码）

| # | 维度 | Python `sim_core.py` | TS `tick.ts` / 域服务 | 影响 |
|---|---|---|---|---|
| 1 | 交通灯相位 | 布尔 `ns_green`/`ew_green`，每 30s 直接互换，**无黄灯**（`:57-60`、`:258-260`） | 有 Green/Yellow/Red/AllRed 相位，30s 绿 + **3s 黄**（`shared/constants/simulation.ts:24-26`、`tick.ts:167-178`） | 每 33s 周期里有 3s，两边的「绿灯」语义不同 |
| 2 | `obs[6:8]` 语义 | `1.0 if ns_green else 0.0` —— 黄灯期仍为 1（`:335-336`） | `phase === LightPhase.Green ? 1 : 0` —— 黄灯期变 0（`tick.ts:688-691`） | **策略在浏览器里看到的观测与训练时不同** |
| 3 | Pure Pursuit 分母 | **常数** `LOOKAHEAD_DISTANCE = 8.0`（`:40`、`:213`） | **实际距离** `ld`（`domain/services/purePursuit.ts:100`） | 转向角不同 |
| 4 | 转向限幅 | `MAX_STEER = 0.4` rad（`:41`） | `±π/4` ≈ 0.785 rad（`purePursuit.ts:103`） | 转向角不同 |
| 5 | 朝向积分 | `heading += steer * DT`（直接积分，`:212`） | 经 Rapier 角速度 `omega = delta * 2.5`（`purePursuit.ts:46-48`、`tick.ts:364-365`） | 航迹不同 |
| 6 | 运动约束 | 自由空间（`x += speed*cos(heading)*dt`） | 沿车道弧长 `s` 运动，位置是 `lanePoint(road, laneIndex, s)` 的函数（`tick.ts:371-386`） | 位置模型不同 |
| 7 | 速度积分 | `speed = clip(speed + accel*3*DT, 0, 16.67)`（`:211`） | 无 Rapier 时 `smoothAccel(speed, targetSpeed, dt, type)`（`tick.ts:374`） | 速度曲线不同 |

**一致的部分**：`obs[13] = clip(y/10, -1, 1)` 两边相同（`sim_core.py:335` vs `tick.ts:713`）；
`obs[0:3]` / `obs[3]` 的归一化常数（50m / π / 16.67 / 50m）相同；
`obs` 总维数 **14**（TS 代码正确，`tick.ts:654` 的 `OBS_DIM = 14`；
但 `tick.ts:189` 与 `tick.ts:649` 的**注释**仍写「13-dim」，属注释漂移）。

### 差异 #2 是最有产品影响的一条

`purePursuit.ts` 的注释自己写着：

> "MUST stay in sync with the Python sim — PPO is sensitive to scaling
> and will drive erratically if they diverge."

而 #1 + #2 组合起来意味着：**在浏览器回放时，策略每 33 秒会看到 3 秒
「黄灯 → obs[6] 变 0」的观测，而它在 Python 训练时从未见过这种输入。**
这不是测试问题，是训练/部署之间的真实失配。

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

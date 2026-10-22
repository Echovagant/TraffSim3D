# Cross-Language Sim Contract

> **状态（2026-10-21；2026-10-22 补第三条向量）：信号灯合规场景进入契约 —— 第五个场景，三条新向量。**
> 上一轮（道路规则）的结论是「在四个场景里 ego 从不面对红灯」——灯的相位钟每步都在走，但 30 s
> 周期 ⇒ 首次换相在**第 300 步**，而 episode 在第 200 步就截断 ⇒ `red_light`
> 终止数 = **0** ⇒ 脚本控制器永远不吃那 −5 ⇒ 「AI 学会开车」的门禁**不可达**
> （基线可证站在物理步数下界上）。这一轮新增场景 **`cross_signalled`**：ego 轴
> **从红灯开始**（`ns_green=False`），周期 **12 s** ⇒ 首次换相在**第 121 步**，
> 落在 episode 之内 ⇒ ego 必须**决策**：红灯停在停止线前，绿灯起步。
> ⇒ 新增 3 条向量：`cross_signalled_light_phase`（停车 300 步 ⇒ 采样到的灯态
> **两次换相**（样本步 130 / 250）⇒ **场景的灯周期首次可观测**）、
> `cross_signalled_red_light`（满油门 ⇒ 第 34 步进路口 ⇒ `red_light` 终止）、
> `cross_signalled_full_crossing`（绿灯覆盖 + **转向残量 0.05** ⇒ 穿过路口
> ⇒ **场景自己的 Pure Pursuit 目标**可观测 —— 目标从路口中心改成终点线之后，
> 轨迹差 **2.59 m**）。
> ⇒ golden 新增 `scene_light` 块（场景自己的灯：起始相位 + 周期长度），由
> Python 侧**逐项**比对（两侧各持一份自己的拷贝 —— 共用一个文件会让比对变成空话）。
> ⇒ 既有 **15** 条向量的**轨迹、终止原因与最终状态逐位不变**（加了 3 条
> 转向向量后是 15 条，再加 2 条 ⇒ 17 条，再加 1 条 ⇒ **18 条**）：重录
> golden 的 diff
> 只有新增的 `scene_light` 块 + `road_rules.scene_goal_z` 里新增的一行
> （15 个文件各 **+7 行 / −1 行**，那 −1 行只是 JSON 逗号；**样本与终态零改动**），
> 15 个 `ts_kernel_*.json` **逐字节不变**。
> ⇒ **改了奖励之后，这条仍然成立**（实测，不是推断）：golden 的 sample 里
> **没有 reward 字段**（只有位姿与灯态）⇒ 改奖励动不了 golden ⇒
> `git diff HEAD -- tests/contract/snapshots/` **为空**（每个已入库的 golden 逐字节
> 相同）⇒ 契约 **169 passed**。
> ⇒ **奖励本身、`light_cycle_seconds` 与**交通模型**这三个训练侧的东西是契约之外
> 的具名盲区** —— 见下面「The three training-only knobs」一节。
> 实测（2026-10-22）：`pytest tests/contract/` → **169 passed / 0 failed / 0 skipped**
> （前一轮 161；第三条向量 + 它的变异门禁 +8）。
>
> **状态（2026-10-21）：道路规则进入契约 —— 两条规则从「隐含」变成「被向量覆盖」。**
> 那一轮给 ego 的训练 sim 改了四条规则（转向残量 / 时间项从奖励翻成成本 / 成功条件加横向约束 /
> 红灯轴向用交通模型的 `approach_axis`）。**其中两条是跨语言规则**：红灯的轴向判定与
> 「成功必须有横向约束」。改动**只落在 Python 一侧** ⇒ 两侧一度含义不同，而契约
> **测不出来**（没有任何向量驶出路面后再越过终点线，也没有向量在路口内带着两侧规则
> 分歧的航向）—— 这是一次**潜伏的跨语言漂移**，「golden 零变化」正是它的症状，
> **不是**规则等价的证据。
> ⇒ 现在：① TS 镜像（`simCoreMirror.ts`）按**同一语义**实现（轴向用交通模型的分类；
> 补 `lateral_offset` + 出路面锁存 + `SCENE_GOAL_Z` 单一常量；转向残量进内核的
> `integrateEgo`，默认 0 ⇒ 产品回放路径逐位不变）；② 新增 3 条向量把规则**钉住**：
> `red_light_axis_disagreement`（航向 50° = 两侧规则的分歧区，在路口内，NS 轴红灯
> ⇒ 闯红灯终止）、`off_road_no_success`（从路面外出发、越过终点线 ⇒ 不得 success）、
> `steer_residual`（非零转向通道 ⇒ 转向残量可观测）；③ 两条常量的拷贝（路半宽 +
> 各场景终点线）写进 golden 的 `road_rules` 块，由 Python 侧**逐项**比对（两侧各持
> 一份自己的拷贝 —— 共用一个文件会让这个比对变成空话）。
> 实测（2026-10-21）：`pytest tests/contract/` → **128 passed / 0 failed / 0 skipped**
> （原 89；新增 39 条来自 3 条新向量的场景/kernel/常量比对 + 6 条**变异门禁**）。
> 既有 12 条向量的**轨迹、终止原因与最终状态逐位不变**：重录 golden 的 diff 只有新增的
> `road_rules` 块（12 个文件各 +9 行、**0 删除**）。
>
> **状态（2026-10-20 起；2026-10-21 复测）：契约已激活并真实执行。**
> 比对测试不再跳过 —— TS 侧快照缺失时**失败**而不是跳过。
> 快照由 `TraffSim3D-frontend` 生成并入库，后端测试可独立跑完整契约。
> 实测（2026-10-21）：`pytest tests/contract/` → **16 passed / 0 failed / 0 skipped**。
> （这是最初的数字；随后扩容到 16，动作词表断言
> 到 40，**带动作向量到 65** —— 下面各状态块给出的是各自时点的实测。）
>
> **状态（2026-10-21，修复波）：本文件此前高估了契约的覆盖面。**
> 下文「What the contract does NOT cover」一节已按**实测**的变异盲区重写：
> 信号相位时长在两侧都是**未被观测**的。修订前的版本只列了
> `MAX_STEER` / `LOOKAHEAD_DISTANCE` 两个盲点。
>
> **状态（2026-10-21）：转向维度进入契约 —— 三个常量不再是盲区。**
> 向量格式新增可选的 `ego_start`（覆盖 ego 的起始位姿），新增 2 条 `steer_*`
> 向量：ego 从**偏出目标线**的位置起步 ⇒ Pure Pursuit 角 α ≠ 0 ⇒ `steer ≠ 0`
> ⇒ `LOOKAHEAD_DISTANCE` / `MAX_STEER` / `EGO_WHEELBASE` 三个常量**首次可观测**
> （变异校验实测：三个常量各自被改后，两条新向量都变红，位移 **0.6–2.0 m**；
> 改之前它们对**所有**向量都无影响）。
> 同时实测到一件必须写进契约的事：**转向轨迹无法逐位相等** ——
> V8 的 `Math.sin`/`Math.atan2` 与 CPython 的 `math.sin`/`math.atan2` 是两套
> 实现，对部分角度**差 1 ULP**。详见下文
> 「The turning dimension — the exact-equality premise, measured」。
> 实测（2026-10-21）：`pytest tests/contract/` → **89 passed / 0 failed / 0 skipped**
> （原 65；新增 24 条来自 2 条新向量 × 3 类断言 + 18 条新的转向覆盖断言）。
>
> **状态（2026-10-21）：动作语义进入契约（镜像侧）。**
> 向量格式新增可选的 `signal_actions`（带步骤约定）与 `light_override`，
> 新增 5 条 `signalled_light_*` 向量：两侧在**同一步**施加**同一个动作**，
> 轨迹仍**逐位相等**。⇒ 「两侧对动作的解释一致」从推断变成实测。
> 同时，离散策略的权重导出（`log_std` 可选 + `action_space` 字段）与
> TypeScript 离散前向（`mlpForwardDiscrete`）由一份**提交的前向契约 fixture**
> 把关：同一权重、同一观测 → 同一个动作下标。
> 实测（2026-10-21）：`pytest tests/contract/` → **65 passed / 0 failed / 0 skipped**
> （原 40；新增的 25 条来自 5 条新向量 × 场景 / kernel / 词表 / 前向四类断言）。
>
> **状态（2026-10-21）：信号灯成为可被外部动作驱动的控制面。**
> 两侧各持一份**自己拥有的**动作词表（五个动作名 + 三个语义常量），
> 词表被写进 golden，由 Python 契约测试**逐项**比对 —— 这是那一轮的
> 跨语言门禁。
> **注意：那一轮没有引入「跨语言相位序列」断言**（原因见
> 「What the contract does NOT cover」新增的一节），
> 因此**每个动作的语义只由各自一侧的单元测试把关**。
> 实测（2026-10-21）：`pytest tests/contract/` → **40 passed / 0 failed / 0 skipped**
> （首批交付 35；审阅中发现并修掉一个**信号灯永久卡死**的缺陷后 +5，见
> 「修复波」一节）。

## Why this exists

The Python training sim (`TraffSim3D-backend/app/apps/rl/sim_core.py`) and the
TypeScript side are two independent implementations of the same model. The
contract exists so that **a PPO policy trained in Python behaves the same in
the browser** — and so that drift on either side is caught by a test instead of
by a user noticing a bad drive.

## What the contract checks

| Layer | What | Compared against | Golden |
|---|---|---|---|
| **L1 kernel** | ego speed integration | the **product replay path** (`tick.ts`) | `ts_kernel_<name>.json` |
| **L3 scenario** | full SimCore semantics — termination rules, reason strings, trajectory | the **contract mirror** (`simCoreMirror.ts`) | `ts_<name>.json` |
| **L4 vocabulary** | the five signal-action names + the four semantics constants | the **Python training sim**'s own copy (`sim_core.SIGNAL_ACTION_NAMES`) | the `signal_vocabulary` block inside `ts_<name>.json` |
| **L5 action-driven** | the **trajectory under an explicit action sequence** | the **contract mirror** (`simCoreMirror.ts`) applying the same actions at the same steps | the `ts_signalled_light_*.json` goldens |
| **L6 forward pass** | the **discrete** policy's argmax over the action logits | the **Python training side**'s own forward pass (SB3's own policy forward + a pure-Python reference) | `discrete-policy-fixture.json` (in the frontend's fixtures folder) |

**L4 (the signal-action vocabulary)** was added later. The
traffic signal became an externally-actionable control surface: both sides
accept the same five action names, so a policy trained in Python can drive
the browser's signal. Each side owns **its own copy** of the list —
`SIGNAL_ACTION_NAMES` in
`TraffSim3D-frontend/src/shared/constants/simulation.ts` and
`sim_core.SIGNAL_ACTION_NAMES` in Python — on purpose: a file both sides
read would make the assertion vacuous. The TypeScript generator writes its
copy into every scenario golden; the Python contract test compares it
**item by item** (the order is part of the contract), so if the two sides
ever disagree on the vocabulary, `pytest tests/contract/` goes red.

**L5 (action-driven trajectories)** was added later.
Until then the contract only proved that the two sides agree on the **default**
trajectory and on the action **vocabulary** — it did **not** prove that the two
sides *interpret the five actions the same way*. L5 closes that gap: a contract
vector may carry an explicit action sequence, and both sides apply the same
actions at the same steps and must still produce **bit-identical** trajectories.

The **step convention** is part of the contract: an action labelled
`{"step": N}` is applied **before** the N-th simulation step, i.e. it is
consumed by that step. In Python that is `light.apply_action(name)` immediately
before `core.step(...)`; in the mirror it is `applySignalAction(name)`
immediately before `mirror.step(...)`.

Measured on the committed vectors (the `signalled_light_*` family, 400 steps,
roundabout with an overridden NS-green light — the roundabout's own light is
both-green, so its swap would be a no-op):

| Vector | Action(s) | Effect on the sampled light bits |
|---|---|---|
| `signalled_light_baseline` | — | the reference (the axis swaps at step 300) |
| `signalled_light_extend_green` | `extend_green` @ 10 | the swap moves 300 → **350** (5 s later) |
| `signalled_light_shorten_red` | `shorten_red` @ 10 | the swap moves 300 → **250** (5 s earlier) |
| `signalled_light_preempt` | `preempt` @ 10 | all-red from step 10, the phase resumes afterwards |
| `signalled_light_preempt_boundary` | `preempt` @ 10 **and** @ 40 | two clearances, the second one landing on the boundary step — the exact case that used to wedge the light permanently (see "修复波") |

⇒ The action **semantics** are now verified cross-language at the trajectory
level, not merely asserted. And the vectors are **not vacuous**: each one
differs from the baseline golden in the sampled light bits (5 / 5 / 6 / 12
sampled points respectively).

**What L5 does NOT cover**: the *values* of the signal agent's observation.
The browser's traffic is a lane-level sandbox and Python's is free-space NPCs,
so the two sides compute "the queue on the north axis" from different objects.
Only the **schema** (dimension, order, normalisation, meaning) is shared — see
"the signal observation schema" below.

The **mirror** exists because the *product* TS sim is a lane-based,
Rapier-driven sandbox, structurally incompatible with Python's free-space
model (cross-language difference #6). A trajectory comparison against the
product sim would therefore be meaningless. The mirror is the contract-side
counterpart, and — crucially — the ego kinematics it uses are **shared** with
the product replay path through `@domain/services/egoKernel`, so the mirror
and the product cannot drift apart on the ego model.

**L2 (observation encoding)** is not asserted yet: `buildReplayObs` was
aligned with Python's `_obs()`, but a cross-language assertion for
it needs a scalar-level entry point into the obs builder. See "Not covered".

## The vectors

| Vector | Scene | What it pins |
|---|---|---|
| `cross_baseline` | cross | The straight-line reference run: ego kinematics, the `success` termination at step 58. |
| `corridor_baseline` | corridor | The same in the corridor scene (`success_corridor` termination). |
| `cross_action_overrange` | cross | The **cross-language action clip**: every action is `2.0`, outside the policy's `[-1, 1]` range. |
| `t_junction_lights` | t_junction | The **longest signalled episode**: a parked ego that collides at step 257, sampled every 10 steps (26 samples, steps 0…250). This is the vector that makes the traffic-light phase observable at all. |
| `roundabout_truncation` | roundabout | The **truncation** path: the episode runs to the step limit (400) and ends `truncated` with no termination reason. Its light is both-green, so the phase swap is a no-op — the vector pins the truncation semantics, not the phase. |
| `signalled_light_baseline` | roundabout | The **signalled** reference run: the same scene, but with a plain NS-green light (the roundabout's own light is both-green, so its swap is a no-op). No action — the default phase timeline, observed over a full 400-step episode. |
| `signalled_light_extend_green` | roundabout | `extend_green`: the swap moves 5 s later (step 300 → 350). |
| `signalled_light_shorten_red` | roundabout | `shorten_red`: the swap moves 5 s earlier (step 300 → 250). |
| `signalled_light_preempt` | roundabout | `preempt`: all-red for 3 s, then the interrupted phase resumes and the swap lands 30 steps later (step 330). |
| `signalled_light_preempt_boundary` | roundabout | The **clearance-boundary** case: a second `preempt` on the very step the phase resumed (step 40). The light must come back (step 70) — the regression the fix wave repaired, now pinned at the trajectory level. |
| `steer_lateral_offset` | roundabout | **The turning vectors.** The ego starts **60 m** to the side of its target line (`ego_start`), so Pure Pursuit's angle is non-zero from the first step: `steer ≠ 0` on every step and the `MAX_STEER` clamp is actually reached (8 consecutive steps). This is what makes `LOOKAHEAD_DISTANCE` / `MAX_STEER` / `EGO_WHEELBASE` observable. 60 steps, truncated at the limit. |
| `steer_heading_offset` | roundabout | The **other** turning trigger: the ego starts on its target line but with its heading offset by **2.0 rad**, so it has to correct hard and immediately (the clamp binds for 34 steps). Same coverage, a different path into the Pure Pursuit. |
| `red_light_axis_disagreement` | cross | **The red-light axis rule.** The ego **drives into** the intersection on a heading of **50°**, i.e. inside the band where the traffic model's `approach_axis()` (ns) and the old "within 0.5 rad of north" heuristic (ew) disagree, with the NS axis red. It starts on the 50° ray towards the Pure Pursuit target, so the scripted steer is exactly 0 and the heading cannot drift out of the band; it **enters the box at step 30** — a *sample point*, with a 0.54 m margin outside and 0.15 m inside, so a 1-ULP difference between the two runtimes cannot flip the entry. Both sides call it a red-light run; the old rule let it through. This is the vector that makes the axis rule **observable** instead of implicit. |
| `off_road_no_success` | cross | **The success's road constraint.** The ego starts **6 m** off the centreline (beyond the 3.5 m road half-width) and drives **across** the goal line: the route is wrong, so neither side may score the success. The latch is permanent — leaving the road and coming back does not restore it. |
| `steer_residual` | cross | **The steering residual.** A non-zero `action[1]` (0.5), i.e. the policy's correction **on top of** the scripted Pure Pursuit steer. The old mirror ignored `action[1]` entirely, so this vector is what makes the steering channel observable on both sides. 30 steps, truncated at the limit (a turning trajectory ⇒ compared within the libm noise floor). |
| `cross_signalled_light_phase` | cross_signalled | **The signalled scene's light schedule.** The ego's own axis starts **red** and the scene runs a **12 s** cycle, so the phase changes twice inside the episode: the sampled light bits flip on the samples of steps **130** (green) and **250** (red). This is the first vector that makes a scene's **own** light schedule observable — the four default scenes' 30 s cycle swaps on step 300, which no episode reaches. The ego stands still, so the episode truncates at step 300. |
| `cross_signalled_red_light` | cross_signalled | **The red-light rule, in a scene that has one.** Full throttle: the ego enters the intersection on step **34**, while its own axis is still red, and both sides call it a red-light run. It is the vector that makes "the ego faces a red light" a *contract-covered* fact rather than a claim about the training. |
| `cross_signalled_full_crossing` | cross_signalled | **The scene's Pure Pursuit target.** The light is overridden to green and the ego drives across the intersection **with a steering residual of 0.05**, so the trajectory keeps turning. That is what makes the scene's own pursuit target observable: the target is the **goal line** (0, +25), not the intersection centre (0, 0) — the centre is a point the ego passes on the way, and a pursuit that keeps aiming at it pulls the ego back after the crossing (measured: the heading drops, and the policy - whose "brake" behaviour is keyed on the heading - then stops 2.3 m short of the goal line). With the target on the goal line the two variants differ by **2.59 m** of x. A perfectly straight ego is *insensitive* to the target (the pursuit angle is ±π, whose sine is ~1e-16), which is why the residual is needed. |

> **这两条向量是刻意极端的压力用例**，不是现实场景（偏出 60 m、航向偏 115°）。
> 极端是有理由的：契约比较的是**采样点**（每 10 步一个），
> 而限幅只在**原始转向超过 0.4 rad** 的那些步上起作用。
> 实测（60 步、采样比较）：
>
> | 几何 | 限幅咬住步数 | `MAX_STEER` 变异的采样漂移 |
> |---|---|---|
> | 偏出 6 m | 1 | 1.0e-03 m（被采样网格稀释到阈值边缘） |
> | 偏出 33 m | 1 | 1.0e-03 m |
> | 偏出 60 m | 8 | 1.2e-01 m |
> | 航向偏 1.2 rad | 12 | 2.2e-01 m |
> | **航向偏 2.0 rad** | **34** | **1.7e+00 m** |
>
> ⇒ 选定 **60 m / 2.0 rad**：限幅长期咬住，采样漂移比 1e-9 的比较地板高 5～6 个量级。

`cross_action_overrange`'s scenario golden is **identical to
`cross_baseline`'s** — every sample and the whole `final_state` — because
*both* sides clip the action into `[-1, 1]` before scaling it, so `2.0` and
`1.0` are the same command on both sides. That equality is the point: the
vector is a two-sided assertion that the clip happens at the same place, in
the same operation sequence, on both sides. (Its kernel golden is the
baseline's 95-step speed series extended to 100 steps — the extra five steps
carry the same values.) The name says "action over range", not "more
acceleration": the vector does **not** accelerate harder than the baseline.

### The vector file's schema

`test_vector.json` holds the fixed input both sides read. Its per-vector
fields:

| Field | Meaning |
|---|---|
| `name` | The vector's name. It selects the goldens `ts_<name>.json` and `ts_kernel_<name>.json`, and the regenerated `python_<name>.json`. |
| `scene_kind` | The Python scene to run: `cross` / `corridor` / `t_junction` / `roundabout` / `cross_signalled` (the fifth scene). An **unknown** name is an error on the Python side (`SimCore.reset()` raises) — it used to fall through to the `cross` scene, which silently measured a different scene. |
| `ego_id` | The ego's id, recorded in every sample. |
| `n_steps` | The **expanded** action count (see the expansion rule below). Neither side reads it today. |
| `actions` | The literal action list. Each entry is a **pair**, and **both elements are read**: the first is the acceleration command, clipped to `[-1, 1]` and scaled to 3 m/s²; the second is the **steering residual** — a correction *on top of* the scripted Pure Pursuit steer, clipped to `[-1, 1]`, scaled by `MAX_STEER` and clipped together with the scripted steer. It used to be that **only the first element was read** ("the steer is not taken from the action — both sides compute it with Pure Pursuit"), and every vector's second element was `0.0`, so the two sides *coincidentally* agreed. The `steer_residual` vector (second element `0.5`) is what makes the dimension observable. |
| `repeat` | **Optional.** Expands `actions` this many times. Absent → the sequence is `actions` itself. |
| `max_steps` | **Optional.** The episode's step limit (Python `SimCore.max_steps`). Absent → `MAX_STEPS_DEFAULT` (200). |
| `light_override` | **Optional.** The light to install right after the scene's `reset()`: `{"ns_green": bool, "ew_green": bool}`. It exists because the roundabout's own light is both-green ("no traffic lights there"), so its swap is a no-op; the *signalled* vectors override it with a plain NS-green light — the same override `tests/contract/test_signal_actions.py` applies. |
| `signal_actions` | **Optional.** The external signal actions to apply: `[{"step": N, "action": "<one of the five names>"}, …]`. **The step convention:** an action labelled `"step": N` is applied **before** the N-th simulation step — it is *consumed by* that step (`light.apply_action(name)` immediately before `core.step(...)` in Python, `applySignalAction(name)` immediately before `mirror.step(...)` in TypeScript). The steps are **1-based**. |
| `ego_start` | **Optional**. The ego pose to install right after the scene's `reset()`: `{"x": …, "z": …, "heading": …, "speed": …}`. It exists because every other vector is a straight-line scenario, where Pure Pursuit's angle is `≈ 0`, `steer ≡ 0`, and the three turning constants cannot change any trajectory. The override is applied **after** `reset()` on both sides (Python: `core.ego = Vehicle(...)`; TypeScript: `mirror.ego = {…}`), and it lives in the **contract harness**, not in `sim_core.py` — so the scenes and the existing goldens stay byte-identical. |

The **expansion rule**, identical on both sides, one line each:

> if the vector has `repeat`, the actual action sequence is `actions`
> repeated `repeat` times; otherwise it is `actions` itself.

`n_steps` in `test_vector.json` must therefore equal the vector's
**expanded** action count — `len(actions)` when there is no `repeat`, and
`len(actions) × repeat` when there is one. The five vectors expand to
95 / 160 / 100 / 400 / 400 actions. The two long vectors declare a
one-entry `actions` list plus `repeat: 400`; their *expanded* count is 400,
not 1. Neither side reads `n_steps` today, but a wrong value is a trap for
whoever adds the next vector.

A malformed `repeat` — `null`, a non-integer, zero or negative — must fail
**loudly on both sides**. Python raises; the TypeScript generator throws
instead of silently running an empty episode (`Array.from({length: null})`
would otherwise yield an empty action list and a vacuous "agreement").

What the contract guarantees is that a divergence which changes the
**observable** episode is caught — the sample count or a sampled value. It
does not follow that *every* divergence is caught: when both episodes
terminate at the same step, a count difference *beyond* that step (e.g. TS
`repeat: 401` vs Python `repeat: 400` on a vector that ends at step 257)
produces byte-identical output and no red.

`tolerance: 0.01` in `test_vector.json` is **not** used by any assertion —
the assertions are exact equality (below). The key is a leftover of the
the original vector-file format; nothing reads it.

### The golden file's schema

Each `ts_<name>.json` — and the regenerated `python_<name>.json`, which has
the same shape — looks like this:

```json
{
  "name": "t_junction_lights",
  "scene_kind": "t_junction",
  "ego_id": "v-1",
  "signal_vocabulary": {
    "actions": [
      "extend_green",
      "shorten_red",
      "preempt",
      "force_all_red",
      "no_op"
    ],
    "all_red_seconds": 3,
    "phase_adjust_seconds": 5,
    "max_green_seconds": 60,
    "min_green_seconds": 10,
    "inter_green_seconds": 6
  },
  "final_state": {
    "terminated": true,
    "truncated": false,
    "reason": "collision",
    "final_step": 257,
    "final_z": -25.0,
    "final_x": 0.0,
    "final_speed": 0.0
  },
  "samples": [
    {
      "step": 0,
      "ego_id": "v-1",
      "x": 0.0,
      "z": -25.0,
      "heading": 1.5707963267948966,
      "speed": 0.0,
      "light": { "nsGreen": true, "ewGreen": false }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `signal_vocabulary.actions` | The five signal-action names, **in contract order**. The Python side compares this list item by item against `sim_core.SIGNAL_ACTION_NAMES`. |
| `signal_vocabulary.all_red_seconds` | The all-red clearance (s) applied by `preempt` / `force_all_red`. Compared against `sim_core.ALL_RED_SECS`. |
| `signal_vocabulary.phase_adjust_seconds` | The phase-adjust amount (s) applied by `extend_green` (+5 s) and `shorten_red` (-5 s). Compared against `sim_core.PHASE_ADJUST_SECS`. |
| `signal_vocabulary.max_green_seconds` | The upper bound (s) on a green phase's **remaining** time after `extend_green`. Compared against `sim_core.MAX_GREEN_SECS`. |
| `signal_vocabulary.min_green_seconds` | The lower bound (s) on a green phase's **remaining** time — a green may not be shortened below it. Compared against `sim_core.MIN_GREEN_SECS`. |
| `signal_vocabulary.inter_green_seconds` | The **inter-green clearance** (s) a phase change costs: the time between the end of one axis' green and the start of the other axis' green, during which no new vehicle may go. The browser derives it from its clearance-yellow (3 s) plus the all-red the conflict resolution forces (3 s); the Python training sim charges the same 6 s on every phase change (`sim_core.CLEARANCE_SECS`). Compared against `sim_core.CLEARANCE_SECS`. |
| `road_rules` | The road rules — the road's half-width and each scene's goal line — as the **TypeScript side's** copies. The Python side compares them item by item against its own `sim_core` copies. |
| `scene_light` | The **scene's own** light schedule: `{"cycle_seconds": …, "ns_green_at_reset": …, "ew_green_at_reset": …}` — the phase the light starts in and the length of a phase. It is the scene's light, *before* any vector-level `light_override` (which is recorded separately). The Python side compares it against the light its own `SimCore.reset()` installs. |
| `light_override` | **Optional** — present only when the vector has one. The light the mirror actually ran with: `{"ns_green": …, "ew_green": …}`. The Python side cross-checks it against the vector's copy. |
| `signal_actions` | **Optional** — present only when the vector has some. The signal-action sequence the mirror actually applied: `[{"step": N, "action": "…"}, …]`. **The Python side reads the sequence from here** (the golden is the single source it applies, exactly like the `signal_vocabulary` block) and cross-checks it against the vector's copy, so a golden that was not regenerated after a vector edit cannot hide the drift. |
| `ego_start` | **Optional** — present only when the vector has one. The pose the mirror actually started the ego from: `{"x": …, "z": …, "heading": …, "speed": …}`. The Python side cross-checks it against the vector's copy, exactly like `light_override`. |
| `final_state.terminated` | The episode ended by a **termination** — success, collision or red light. |
| `final_state.truncated` | The episode hit the **step limit** instead. The two flags are mutually exclusive (the limit is only reached when the episode has not terminated), and a truncated episode carries **no** termination reason: `reason` is the empty string. |
| `final_state.reason` | The termination reason, or `""` when the episode was truncated. |
| `final_state.final_step` | The step the episode ended on. |
| `final_state.final_z` / `final_x` / `final_speed` | The ego's final pose and speed. |
| `samples[].step` | The step the sample was taken at. Steps 0, 10, 20, … are sampled (`sample_every`), plus the last action index. |
| `samples[].light` | The traffic-light bits at that sample: which axis is green. This is the **only** common semantic between Python's `ns_green` / `ew_green` pair and the frontend's 10-value phase enum ("which axis is green"). Comparing them directly is what makes the signal phase **duration** observable — before the light bits were sampled, a change to the cycle length was invisible to every gate. |

## The assertions are exact, not approximate

Both sides execute the same floating-point operation sequence, so their
trajectories are **bit-identical**. Measured on the `cross` vector:

| Quantity | Python | TS |
|---|---|---|
| `speed` series (58 steps) | — | 0 differences / 58 |
| `x` series (58 steps) | — | 0 differences / 58 |
| `final_z` | `26.20100000000003` | `26.20100000000003` |
| `final_x` | `1.467525924532092e-14` | `1.467525924532092e-14` |

The assertions therefore use **exact equality** (`==`). A tolerance would hide
exactly the failure this contract exists to catch: silent drift on one side.

This is only possible because of the porting rules, all enforced in
`egoKernel.ts` and `simCoreMirror.ts`. Six are listed here; the seventh — the
platform assumption about V8's transcendental functions — has its own section
below.

1. The Pure Pursuit denominator is the **constant** `LOOKAHEAD_DISTANCE = 8.0`,
   never the actual distance to the target.
2. The Pure Pursuit **alpha sign** is the textbook one:
   `alpha = target_angle - heading` — the angle **from the heading to the
   target**, so the steer turns **towards** the target. It was the other way
   round until 2026-10-21; see "The Pure Pursuit sign" below.
3. Update order is speed → heading → position, and `steer` is computed from
   the state *before* the update.
4. `wrapPi` replays CPython's float-modulo algorithm exactly (`fmod` plus one
   conditional add of the modulus). The shorter "always add 2π and re-mod"
   spelling is **not** equivalent — it adds a rounding step.
5. Statement order mirrors Python's, and the action is converted with
   `Math.fround` before clipping — Python's actions always pass through
   `np.float32`, and the policy's output layer has no tanh, so raw actions can
   leave `[-1, 1]`. Skipping the cast made the two sides differ on 11584 of
   12000 steps in a randomised cross-check.
6. **NaN semantics are pinned, and the two clamp flavours are not
   interchangeable.** Python clips the *action* and the *steer* with numpy's
   `np.clip`, which **propagates** NaN; it clamps the *speed* with
   `max(0.0, min(16.67, v))`, and CPython's `min` keeps its first argument
   when the comparison is False — so a NaN collapses to **16.67**, the speed
   limit. The TS kernel mirrors this with two helpers (`npClip` and
   `pythonMaxMin`), and a unit test pins
   `pythonSpeedStep(5, NaN, 0.1) === 16.67`. With a single NaN-propagating
   clamp, a corrupt checkpoint (a policy whose forward pass yields NaN) put
   NaN positions in the browser replay while Python silently clamped to the
   speed limit — the "same floating-point operation sequence" claim did not
   hold for NaN.

### The Pure Pursuit sign (2026-10-21)

The steering law `steer = atan2(2·L·sin(alpha), lookahead)` is only correct for
the **textbook** alpha — the angle from the vehicle's heading to the target
direction. The sim computed the **negative** of it, so the ego steered **away**
from its target.

Measured (120 steps, full throttle, target 25.7 m away):

| | distance to the target |
|---|---|
| before the fix (`alpha = heading - target_angle`) | 25.7 m → **150.9 m** (driving away) |
| after the fix (`alpha = target_angle - heading`) | 25.7 m → **5.8 m** (arriving) |

**Why it survived for years**: every scene and every contract vector put the ego
on a **straight line** to its target, so `alpha ≈ 0` and `steer ≡ 0` — the sign
was invisible. The contract could not see it either: both sides implemented the
same wrong sign, so they matched bit for bit. Only a vector whose target is
**off** the ego's heading exposes it (the `steer_*` vectors above).

**What did NOT change**: the browser's lane-following controller
(`src/domain/services/purePursuit.ts`) computes the same-looking expression
with the opposite sign — **on purpose**. There the steering is handed to Rapier
as an angular velocity about the **y axis**, whose sense is opposite to the
(x, z) plane's `heading` convention the sim integrates. Both files are correct
in their own frame; the browser's traffic demonstrably follows the lanes.
The product's RL replay path uses only the kernel's **speed** half, so the
browser's behaviour is unaffected by the fix either way.

> **⚠ 2026-10-22 更正：上面那段「浏览器故意用相反符号」是错的，那条推理不成立。**
>
> 浏览器侧的转向确实交给 Rapier 当 **+Y 角速度**（`setVehicleAngularVelocity`
> → `setAngvel({y: omega})`），但**仿真报告的 heading 就是同一个 +Y 偏航**
> （`readPose` → `atan2(2(wy+xz), 1-2(y²+x²))`，对偏航四元数即 h 本身）
> ⇒ **+Y 角速度使 heading 增大**，与教科书式推导假设的方向**一致**，
> **不存在需要补偿的反向坐标系**。
>
> 实测（仓库自己的 `tick()` + 真实 Rapier WASM，同一场景同一随机种子，
> 只改 `purePursuit.ts` 的 alpha 符号）：
>
> | `purePursuit.ts` 的 alpha | 15 秒内 5 m 漂移守卫回弹次数 |
> |---|---|
> | `heading - lookaheadAngle`（旧） | **5** |
> | `lookaheadAngle - heading`（新，与 `pythonSteer` 一致） | **0** |
>
> ⇒ 旧符号让浏览器的车**转向远离车道**，再被 5 m 守卫拽回、速度清零，
> 反复循环；而且 `purePursuit.spec.ts` 把反号断言成了「正确」，**把 bug 锁在了单测里**。
> ⇒ 现在三处（`sim_core.py`、`egoKernel.ts` 的 `pythonSteer`、
> `purePursuit.ts`）**统一为教科书式 alpha**。
>
> **为什么契约看不见它**：契约比的是 `sim_core.py` ↔ `simCoreMirror.ts`
> （训练侧的 1:1 移植），**浏览器那条 Rapier 路径根本没有向量**。
> ⇒ 现在补上的钉子：`purePursuit.spec.ts` 断言
> **① 转向必须让航向朝目标靠近**（性质断言，不再锁死某个符号）、
> **② `computeSteeringAngle` 必须与 `pythonSteer` 在同一几何上完全一致**
> ——而 `pythonSteer` 是被 169 组契约向量对着 Python 钉住的，
> 于是浏览器路径**传递性地**被钉住。

**Consequence for the trained policies**: an ego agent trained before this fix
learned to steer the wrong way ⇒ **it has to be retrained**. The checkpoints
are not committed, so nothing stale is left in the repository.

> **⚠ 2026-10-21 更正（重训的实测推翻了这个推论）**：上面那句「旧策略作废」**是错的**，
> 撤回。实测：**`SimCore.step` 从不读 `action[1]`**（`sim_core.py:496` 只读油门）
> ⇒ 训练出来的 ego 策略是**油门控制器**，转向是**脚本化的 Pure Pursuit**；
> 而四个训练场景里 ego 的路径精确为 **x ≡ 0**（max|x| = 0.000000）
> ⇒ `alpha ≡ 0` ⇒ **转向符号在训练环境里完全不起作用**
> ⇒ 符号修复**没有改变任何训练场景** ⇒ 旧策略并未因此作废。
>
> ⇒ 这一次修对的仍然是**模型本身**（对「将来有转向权限的策略」和对**契约覆盖转向
> 维度**都是必需的），但「旧策略作废」这个推论不成立。
> **「AI 学会开车」的真实现状**：策略没有转向权限，且它的油门策略
> （60.227）**输给一个人手调的常数油门**（60.835）—— 那点优势全部来自
> 奖励里的逐帧存活奖励。

## The contract is two-sided, with two different oracles

This is the part that is easy to get wrong. The backend test compares
**Python's live output** against the **committed TS golden** — it is a golden
test. Therefore:

| Drift | What catches it |
|---|---|
| **Python-side** — the behaviour the vectors actually observe | `pytest tests/contract/` goes red |
| **Python-side** — the constants the vectors do **not** observe (see below) | **nothing goes red** — the mutation is invisible to every gate |
| **TS-side** — the mirror, the kernel, the replay path | `npm run test:contract` reports the goldens stale; the TS unit specs for the mutated module also go red |
| **A missing golden** | `pytest tests/contract/` goes red (`test_contract_snapshots_are_present`) |

⇒ **The repository has CI**: `.github/workflows/ci.yml`. It runs four jobs.

| Job | What it runs | Why it matters here |
|---|---|---|
| `backend` | `pytest --cov=app --cov-fail-under=70`, `ruff`, `black` | The Python side's own gates. |
| `frontend` | `vitest run --coverage`, `vue-tsc --noEmit`, `eslint`, `prettier` | The TypeScript side's own gates — including the TS unit specs that pin the mirror's behaviour. |
| `contract` | `pytest tests/contract/` **and** `npm run contract:check` | **The important one.** Both oracles, in one job. |
| `e2e` | Playwright against a live frontend + backend | Non-blocking for now (`continue-on-error: true`) — the 25 visual baselines were recorded on Windows, so a Linux runner's pixel output is expected to differ. The visual specs are **not** excluded and the tolerance is **not** widened. |

The `contract` job is the one that protects the model, and it needs **both**
of its steps:

1. `pytest tests/contract/` runs the **live Python sim** and compares it
   with the committed TypeScript goldens.
2. `npm run contract:check` re-generates those goldens from the
   **TypeScript sources** and fails if they no longer match.

Step 1 alone would not notice a change in the TypeScript sources at all,
because the goldens are committed artefacts; step 2 alone would only prove
that the goldens match the TypeScript code, not that the two
implementations agree. Together they are the contract.

### Run the same gates locally

```sh
# backend oracle (Python vs the committed TS goldens)
cd TraffSim3D-backend && .\.venv\Scripts\python.exe -m pytest tests/contract/ -v

# TS oracle (the committed goldens vs what the TS code produces now)
cd TraffSim3D-frontend && npm run contract:check   # alias of npm run test:contract
```

## What the contract does NOT cover

These are measured, not assumed. Both sweeps below mutate a constant at
runtime (Python: patch the module / instance; TS: patch the exported
`PYTHON_SIM` object), re-run every vector, and compare the full snapshot —
reason, `final_step`, `final_x/z/speed` and every sample (TS: compare the
recomputed golden against the committed file).

| Constant | Python side | TS goldens | In the previous version's blind-spot list? |
|---|---|---|---|
| `SPEED_LIMIT` | caught | caught | — (it was caught) |
| `DT` | caught | caught | — (it was caught) |
| `COLLISION_DISTANCE` | caught | caught | — (it was caught) |
| `MAX_STEPS_DEFAULT` | caught **only below step 58**; `200 → 100` is blind | same | — (listed as caught; it is only caught below step 58) |
| `LOOKAHEAD_DISTANCE` | **caught** | **caught** | was blind — now caught by the `steer_*` vectors (a 25 % change moves the trajectory by 1.2–2.0 m) |
| `MAX_STEER` | **caught** | **caught** | was blind — now caught by the `steer_*` vectors (a 25 % change moves the trajectory by 1.4 m) |
| `EGO_WHEELBASE` | **caught** | **caught** | was blind — now caught by the `steer_*` vectors (a 25 % change moves the trajectory by 0.6–1.5 m) |
| `INTERSECTION_RADIUS` | **blind** | **blind** | **no** |
| `ROUNDABOUT_RADIUS` | **blind** | **blind** | **no** |
| `NPC_SPEED` | **blind** | **blind** | **no** |
| `ROAD_HALF_WIDTH` | **caught** — the golden's `road_rules` block carries the TS side's copy and the Python side compares it item by item | **caught** (same block) | **no** (it did not exist before the `road_rules` block) |
| `SCENE_GOAL_Z` | **caught** — same block, per scene | **caught** (same block) | **no** (it did not exist before the `road_rules` block) |
| **traffic-light phase duration** (`TrafficLight.cycle_duration` / `PYTHON_SIM.LIGHT_CYCLE_SECONDS`) | **partially covered** — caught when the first flip lands inside the *sampled* window (≤ 25.0 s); a drift of 30 → 26 s is **not** caught | same | **no** (was fully blind) |
| **a scene's own light schedule** (the start phase + the cycle length) | **caught** — the golden's `scene_light` block carries the TS side's copy and the Python side compares it item by item | **caught** (same block) | **no** (it did not exist before the `scene_light` block) |
| **the browser's Rapier path** (`purePursuit.ts` + `tick.ts` + `RapierWorld.ts`) | **not comparable** — it is a *physics* path, not the hand-rolled kinematics this contract compares | **not comparable** (same) | **no** — this gap is what let the Pure Pursuit alpha sign bug survive in the browser while the training sim was fixed (2026-10-22) |

### The browser's Rapier path — covered by a different mechanism, and how that failed once

The vectors compare `sim_core.py` against `simCoreMirror.ts` — the **training
sim's** 1:1 TypeScript port. The **browser's** simulation is a different
implementation (`purePursuit.ts` + `tick.ts` + Rapier WASM), and **no vector
compares it**. That gap is not academic: on 2026-10-22 the browser's Pure
Pursuit alpha sign was inverted (the training sim's had been fixed three
months earlier), the browser's traffic steered away from its lane, and the
5 m drift guard kept snapping it back — while 169/169 contract vectors and
the frontend unit suite stayed green. The unit test asserted the wrong sign
as correct.

**How it is pinned now** (a different mechanism, deliberately):

| Pin | What it asserts |
|---|---|
| `purePursuit.spec.ts` — "steering always turns the heading TOWARD the lookahead point" | a **property**, not a memorized sign: applying the steering must reduce the heading error. A flipped alpha fails it |
| `purePursuit.spec.ts` — "agrees with the training sim kernel (`pythonSteer`) on the same geometry" | the browser controller and the contract-pinned kernel must produce the **same** steering angle for the same geometry |

Because `pythonSteer` is pinned against Python by the vectors above, the
browser's controller is pinned **transitively**. Two caveats are stated
plainly rather than left implicit:

- the browser's steering clamp is **π/4**, the training sim's is
  `MAX_STEER = 0.4` rad — a known cross-language difference (documented
  separately), so the agreement test only compares inside the shared range;
- the browser's **tick loop, lane model, stop line and trajectory exporter**
  are still outside any committed test. They are not covered by this document
  and should not be described as if they were.

### The traffic-light phase duration — partially covered

The signal phase is cross-language difference #1 and the central topic of this
document, so its coverage is stated precisely rather than as a yes/no.

**What changed**: the golden samples now carry the light
bits (`nsGreen` / `ewGreen`) and the contract compares them. Two long vectors
were added, so an episode can now run past the old 58-step horizon.

**The remaining limit is a property of the episodes, not of the assertion.**
The phase flips at `duration × 10` steps, and the longest *signalled* episode
is the `t_junction_lights` vector, which ends by **collision at step 257**.

**The observable window is the *sampled* window, 0…250 — not 0…257.**
`sample_every` is 10, and the terminating step 257 is **not** a sample point
(257 is neither a multiple of 10 nor the last action index), so the last
sample the contract actually compares is **step 250**. A flip is observable
only if it lands at or before step 250. Measured flip steps (Python side;
the TS mirror accumulates the same bits):

| phase duration | first flip | inside the sampled window (0…250)? |
|---|---|---|
| 30 s (shipped) | 300 | no → the episode ends at 257 first |
| 26 s | 260 | **no → invisible** |
| 25.5 s | 255 | **no → invisible** — between the last sample and the collision |
| 25.0 s | 250 | yes → caught |
| 20 s | 200 | yes → caught |
| 10 s | 101 | yes → caught |

⇒ **A phase-duration drift is caught only if it moves the first flip into the
sampled window** — i.e. if the new duration is ≲ **25.0 s**. A drift of
30 → 26 s (or 30 → 25.5 s) escapes every gate. Measured on both sides (Python
instance attribute and the TS `PYTHON_SIM` object); the same bound holds.

The bound is asserted, not just described: `tests/contract/test_light_phase.py`
runs the `t_junction` episode at 30 s / 25.5 s / 25.0 s and checks that the
25.5 s flip changes no sample while the 25.0 s flip does.

### Root cause of the remaining limit

1. **The longest signalled episode is 257 steps.** A parked ego (zero
   acceleration) is hit by an NPC long before the 30 s phase: measured
   reachable episode lengths are `cross` 39, `corridor` 45, `t_junction` 257,
   `roundabout` 400 (truncation only, and its light is both-green so its swap
   is a no-op). The `cross` scene is the worst case: the northbound NPC
   respawns on the ego's own line. — **a fifth scene was added**,
   `cross_signalled`, whose layout is built from that same measurement (no
   north-south NPC ⇒ a parked ego is never hit) and whose cycle is 12 s, so
   its phase changes land on steps 121 and 241 — well inside the episode.
2. ~~**Every vector is straight-line**, so `steer ≡ 0`. The Pure Pursuit
   denominator, the steer clamp and the wheelbase therefore cannot affect the
   trajectory at all.~~ — **closed**: the two `steer_*` vectors
   start the ego off its target line, so `steer ≠ 0` on every step and the
   clamp is actually reached (the peak steer equals `MAX_STEER` exactly).
3. **The NPCs never interact with the ego** in the vectors that matter — no
   collision, no influence on the ego's path — so `NPC_SPEED` and the scene
   radii are invisible.

### How to close the rest

1. ~~**Add a Python scene whose signalled ego can idle for ≥ 300 steps** — the
   phase flips at 300 steps, so the window must reach that far. This needs a
   scene whose NPC layout never reaches the ego, which is scene-extension
   work, not a vector change: with the current four
   scenes it is **provably impossible** (the reachability numbers above).~~
   — **done**: the `cross_signalled` scene is exactly that
   scene. Its NPC layout was chosen from a **measurement**, not by taste: the
   default traffic model's out-of-bounds rule mirrors an NPC's x
   (`x -> -0.8 x`), which converges onto the ego's own centreline within two
   respawns (measured: `-3.5 -> 2.8 -> -2.24 -> 1.79`), so a **north-south**
   NPC would rear-end a stopped ego. The scene therefore carries only the
   east-west cross traffic, which never comes within **5.2 m** of an ego
   stopped at the stop line (measured over 400 steps). The
   `cross_signalled_light_phase` vector then idles for 300 steps and records
   **two** phase changes. (The cross traffic plays **no part** in the winning
   run: it crosses the ego's path on steps 17-21 / 107-111 / 199-203 /
   289-293, which do **not** overlap the light-aware drive's crossing window
   (~150-167) ⇒ the scene's discriminating power comes **entirely from the
   red light**.)
2. ~~**Add a vector that actually steers** (a target off the ego's heading), so
   `LOOKAHEAD_DISTANCE`, `MAX_STEER` and `EGO_WHEELBASE` become observable.~~
   — **done** (the `steer_lateral_offset` and
   `steer_heading_offset` vectors, plus the `ego_start` override they need).
3. ~~**Record the light bits in the golden samples**~~ — **done**:
   the light is now compared directly instead of only through its side
   effect on the termination reason.
4. **The new scene's *own* schedule is pinned as a constant** — **done**:
   the golden's `scene_light` block carries the TypeScript
   side's copy of every scene's start phase and cycle length, and the Python
   side compares it item by item. A one-sided change of either turns the
   contract red even when the sampled bits happen not to move.

### The turning dimension — the exact-equality premise, measured

ADR-008 D3 compares the two sides with `==`, because "both sides execute the
same floating-point operation sequence". That premise holds for the
straight-line vectors — their only transcendental arguments are exactly `0`
(the Pure Pursuit angle) and `π/2` (the heading), which every libm reproduces
bit for bit — but **not** for a trajectory that turns.

V8's `Math.sin` / `Math.atan2` and CPython's `math.sin` / `math.atan2` are
different implementations (V8 ships an fdlibm-derived port, CPython calls the
platform libm), and they disagree by **1 ULP** for a few percent of the
angles a turning trajectory visits. Measured on the `steer_lateral_offset`
vector (60 steps, this machine): the first divergence is at sample step **20**
— `heading` 2.22e-16 rad — and the largest is `z` 3.55e-15 m. ADR-008's own
randomised sweep measured up to 1.09e-13 m.

⇒ A turning trajectory therefore **cannot** be compared with `==`. The
contract now compares it within a bounded floor (`_LIBM_NOISE_FLOOR = 1e-9`),
which is four orders of magnitude above the measured divergence and six
orders below the smallest drift the contract must catch (a mutated turning
constant moves the trajectory by metres). The **straight-line vectors keep the
exact `==` assertion** — the floor is only used where the trajectory actually
turns (a heading that moves by less than 1e-9 rad over the whole episode
counts as straight: that is the last-bit wobble the ego picks up after it
passes its target, where the Pure Pursuit angle is `≈ π` and the steer
`≈ 1e-16`). The floor is pinned by its own test
(`tests/contract/test_steering_vectors.py`), so it cannot be widened silently.

Two consequences worth knowing:

- The comparison floor is **platform-dependent in principle**: the TypeScript
  side always runs V8's fdlibm, while the Python side runs the platform libm
  (glibc on the Linux CI runner, the MSVC CRT here). A floor is what keeps
  the `contract` CI job green on both.
- The Pure Pursuit steer depends on `LOOKAHEAD_DISTANCE` and `EGO_WHEELBASE`
  **only through the ratio** `2 · EGO_WHEELBASE / LOOKAHEAD_DISTANCE`.
  Scaling both by the same factor leaves the trajectory bit-identical — so a
  mutation check that changes both at once proves nothing. Each constant has
  to be moved on its own.

### The signal phase timeline — NOT covered

That work made the signal an externally-actionable control surface on both
sides and added the **vocabulary** assertion (L4, above). It did **not**
add a cross-language **phase timeline** assertion — and it cannot: the two
models of "the signal" are structurally different.

| | browser (`tick.ts` + `RLController`) | Python (`sim_core.TrafficLight`) |
|---|---|---|
| unit of control | **one light** — the two axes of an intersection are separate entities | **one intersection** — a single object with two axis bits |
| phases | 10-value enum: green / yellow (3 s) / red / … / allRed | two bits: which axis is green — **no yellow phase** |
| "all red" | the `AllRed` phase, 3 s | `(ns_green=False, ew_green=False)` for 3 s |
| phase clock | `phaseRemaining` per light, decremented by the frame delta | one `cycle_timer` for the axis pair |

⇒ The **axis-green projections necessarily differ at the transitions**: the
browser goes green → yellow → red over 3 s, Python goes green → red in one
step. A timeline assertion would compare two different things.

⇒ What the two sides **do** agree on **is** asserted: the **vocabulary**
(L4). The **per-action semantics** are gated by each side's own unit
tests:

| Side | Test module | What it pins |
|---|---|---|
| TypeScript | `src/application/services/controllers/RLController.spec.ts` | each of the five actions, the "applyAction only queues" rule, the queue's single consumption, and the action-source seam |
| TypeScript | `src/application/services/simCoreMirror.spec.ts` | the mirror's port of the Python light's action semantics |
| Python | `tests/contract/test_signal_actions.py` | each of the five actions on the Python light, the default cycle, and the all-red clearance |

Three semantic differences are known and deliberate:

1. **`shorten_red`'s floor.** The browser floors the red phase at
   `MIN_RED_SECS` (10 s — the `ActuatedController`'s existing convention).
   Python has no minimum-red convention, so its `shorten_red` always takes
   the full 5 s off (capped only by the cycle duration: if less than 5 s
   remain, the swap happens on the next step).
2. **What "shorten the red" means.** The browser's two axis-lights are
   independent entities, so shortening one light's red does not touch the
   other axis. Python has a single phase clock, so `extend_green` (delay
   the swap by 5 s) also lengthens the red axis's wait, and `shorten_red`
   (advance the swap by 5 s) also shortens the green axis's remaining.
3. **The max-green bound is a *remaining* bound, not a wall-clock bound.**
   Both sides cap the green's **remaining** time at `MAX_GREEN_SECS` (60 s)
   — the browser's existing convention, and the constant the L4 assertion
   compares. It does **not** bound how long the green lasts in wall-clock
   terms: a policy that applies `extend_green` on *every* decision keeps
   the remaining topped up and can hold one axis green indefinitely.

The first two are consequences of the two models' shapes, not of the
vocabulary; closing them means aligning the two signal models — later work.
The third is a **known residual risk**, mitigated where it belongs:

- the mitigation for a degenerate policy is the **reward function** — the
  cross-axis delay has to be in it;
- a hard wall-clock bound on the green needs the two phase models aligned,
  because the browser counts per light and Python
  counts per axis pair.

Nothing above is *enforced* by the cross-language contract: it compares the
**vocabulary and the constants**, not the resulting timelines. (The
**mirror's** action semantics *are* asserted now — see the next section.)

### The action semantics — asserted against the mirror

The section above is about the **browser's** signal (`tick.ts` +
`RLController`), whose 3 s yellow phase per light makes its axis-green
projection differ from Python's at the transitions. That difference is
structural and still stands.

What **is** asserted cross-language is the **contract mirror**
(`simCoreMirror.ts`) against the Python training sim: the five
`signalled_light_*` vectors apply the **same action at the same step** on
both sides, and the trajectories must still be bit-identical. The
per-action semantics are therefore no longer "gated by each side's own
unit tests only" — the contract gates them too:

| Vector | Action | What the golden pins |
|---|---|---|
| `signalled_light_extend_green` | `extend_green` on step 10 | the swap moves from step 300 to step 350 |
| `signalled_light_shorten_red` | `shorten_red` on step 10 | the swap moves from step 300 to step 250 |
| `signalled_light_preempt` | `preempt` on step 10 | all-red on steps 10…39, the phase resumes inside step 40, the swap lands on step 330 |
| `signalled_light_preempt_boundary` | `preempt` on steps 10 and 40 | the second clearance does **not** wedge the light: the phase resumes inside step 70, the swap lands on step 360 |

Two limits of that assertion are worth stating plainly:

1. **The browser is not in it.** The vectors drive the *mirror*, not the
   product's signal — the browser's yellow phase is still a separate,
   unaligned model.
2. **The sample stride is 10 steps.** A phase change is observed at the
   first sample after it, so an action applied one step later than the
   contract says is visible only when the change lands on a sample
   boundary. The `preempt` vectors are therefore scheduled on multiples
   of 10 — otherwise the 30-step all-red window would hide a ±1 step
   error. A ±1 step error in `extend_green` / `shorten_red` is invisible
   at **any** stride: that is not a gap in the vectors but a property of
   the model, because the phase clock is continuous — the swap is "5 s
   later" whatever the clock happened to be, and a one-step shift of the
   adjustment cancels out.

### 修复波 — 审阅中发现并修掉的信号灯永久卡死

那一轮交付的审阅里复现了一个**真实缺陷**：两侧的「清空结束」边界上，
一次 `preempt` 会把**恢复点**记成全红状态，之后该路口的一个轴**永远不再变绿**。

**实测复现**（Python，`roundabout` 场景 400 步）：

| 施加 preempt 的步 | 结果 |
|---|---|
| 仅第 1 步 | 第 31 步恢复绿灯 ✅ |
| 第 1 步 + 第 20 步（清空中途） | 第 50 步恢复绿灯 ✅（清空被延长，恢复点保留） |
| 第 1 步 + **第 31 步（清空刚结束的那一步）** | **120 步内从未变绿 ❌ 永久卡死** |

**根因**：清空在第 30 步结束，但灯的轴位要等到第 31 步的 step 内部才恢复成绿。
在那个窗口里「是否正在清空」的判据（Python 的 `all_red_steps == 0`、浏览器的
`simTime >= allRedUntil`）都判定为「不在清空」，于是新的 `preempt` 把恢复点
覆盖成了全红状态。

**修法**：两侧都改成**先恢复、后消费动作**——清空结束时先把相位恢复回原状，
再消费本步的动作；并且恢复点**只记录真的有绿灯轴的状态**。两侧语义对称：

- Python：`sim_core.py` 的 step 块把 `resume_state` 的恢复提到 `consume_actions()` **之前**；
- TS 镜像：`simCoreMirror.ts` 逐句对应；
- 浏览器：`RLController.decide()` 的「清空结束」恢复提到动作应用**之前**，
  并且「是否正在清空」改用 `allRedUntil === -Infinity` 判定（与 Python 的
  恢复先行顺序一致）。

**验证**：两侧各加了回归测试；并做了**变异校验**——把浏览器的修复回退，
新测试立刻失败（`expected 'allRed' to be 'green'`，正是卡死的症状），
还原后重新变绿。默认行为**逐位不变**：5 个 golden 全部是**纯插入**
（12 增 0 删），只有 `signal_vocabulary` 块多了一个常量。

**同时做了一个决策**：`extend_green` 加 `MAX_GREEN_SECS`（60 s）上限。
不加的话，一个策略可以在训练里学会「永远延长绿灯」，把对向饿死——而
后续的策略是**照着这个动作空间训练**的，事后再改语义就作废了训练结果。
上限沿用项目既有的 `MAX_GREEN_SECS` 约定（`ActuatedController` 同款），
并作为第三个常量进入 L4 词汇断言。

### 最小绿灯时间（约束加在控制器层，不动物理灯模型）

实测发现：模型允许一个「闪烁」调度（每步 `shorten_red`），每个相位
只剩 0.6 s，车辆**不停车**因而不计延误，奖励恰好 **0.0**——严格优于任何诚实调度，
是个退化策略。

**修法**：加最小绿灯时间 `MIN_GREEN_SECS = 10`，与既有的 `MIN_RED_SECS` 对称——
「红灯不短于 10 s，绿灯也不短于 10 s」。**加在控制器 / 环境层**：

- Python：`SignalEnv` 把会破坏下限的 `shorten_red` **屏蔽**（动作不施加，灯不动作）；
  `sim_core.TrafficLight.consume_actions` 与换相逻辑**一字未动**；
- 浏览器：`RLController.shrinkRed` 给绿灯相位加同样的下限（红灯相位的
  `MIN_RED_SECS` 下限保持不变，黄灯/全红仍然无下限）；
- 两侧各持一份常量，作为第四个常量进 L4 词汇断言
  （`signal_vocabulary.min_green_seconds`）。

**为什么不动物理灯模型**：物理灯模型是跨语言契约的敏感区，而默认周期 30 s > 10 s，
本来也不受这条约束影响 ⇒ 契约黄金的**轨迹部分零改动**。本次只有
`signal_vocabulary` 块多了一个字段：10 个 golden 全部是**纯插入**（20 增 10 删，
删掉的那 10 行只是被插入行挤掉逗号的上一行，字段值未变），10 个 `ts_kernel_*.json`
逐字节不变。

**实测（600 步，同一初始状态）**：

| 调度 | 加最小绿灯之前 | 加最小绿灯之后 |
|---|---|---|
| 默认（`no_op`，30/30 交替） | −109.2 | −109.2（未变） |
| 闪烁（每步 `shorten_red`） | **0.0** | **−97.2**（退化成 15 s/15 s 的合法定时方案） |

⇒ 「0 延误白拿」的退化没了，但**闪烁仍然优于默认**：Python 的灯模型**换相零损耗**
（没有黄灯、没有全红），车辆也完全能在 15 s 绿灯内清空路口，所以对「队列长度曲线下
面积」这个延误指标而言，周期越短越划算。真正还缺的是那次实测诊断里的第 (b) 项——
**路口冲突模型**（以及每次换相的清空时间），留给后续的「训练环境与浏览器同源」工作。

### 换相清空时间（inter-green）+ 稠密训练场景

最小绿灯与最短红灯都落地之后模型还缺两样物理，这一次补齐：

**（1）换相清空时间。** 浏览器每次换相要付 Green→**黄灯 3 s**→全红 **3 s**，
两侧合计 **6 s** 的 inter-green——期间**没有新车获准起步**。Python 的灯模型原本
**瞬时换相**，于是「切得越勤越划算」，信号灯 agent 的最优解就是一个固定周期
控制器。

- 清空时间由 **`SimCore`** 收取（**不是** `TrafficLight` 数据类——那是契约的敏感区，
  一个字段都不能加），且**只在 `responsive_traffic` 打开时生效** ⇒ 默认路径逐位不变；
- 语义与既有的全红清空一致：**两轴都不放行** + **相位钟冻结**；清空期间相位调整
  也被中和（否则落在冻结的 0 上的调整会悄悄缩短**下一个**绿灯，绕过最小绿灯
  下限）；
- 常量 `CLEARANCE_SECS = 6.0`，作为**第五个**常量进 L4 词汇断言
  （`signal_vocabulary.inter_green_seconds`）；浏览器侧对应的是**推导**出来的
  `MIN_INTER_GREEN_SECS = YELLOW_CLEAR_SECS + CONFLICT_ALL_RED_SECS`（= 6 s），
  不是写死的字面量 ⇒ 数字不会与实现它的代码悄悄漂移。

**（2）稠密训练场景。** 交叉场景每条车道只有 1 辆车（约每 9.4 s 一辆），红灯期排不出
队列 ⇒ 「饿死对向」几乎免费。`SignalEnv` 现在在每条车道上铺一条**规则车流**
（沿车道的循环路径每 24 m 一辆，从重生点开始），红灯期能堆起 6～8 辆的队列。

**⚠ 两轴的需求刻意不等**（EW 轴比 NS 轴多 1/3 的车流）。这不是给测试放水，而是
**模型可用性的前提**：奖励是「队列长度曲线下面积」，而队列长度**不可能超过该轴上
的车数**⇒ 被饿死那一轴的延误有上限（车数 × episode 长度）。实测**需求平衡**的
稠密场景里，模型把「永远吊着一轴绿灯」排在**交替调度之上**（−238.4 vs −241.8，
600 步）：交替调度每次换相都要付 inter-green，而饿死调度根本不换相，被封顶的延误
补不回来——那是个**退化最优解**（agent 会学会饿死一轴）。需求不平衡之后取舍才
是真的：agent 必须决定把绿灯怎么分给忙轴和闲轴。

**实测（600 步，同一初始状态，seed 0）**：

| 调度 | 加 inter-green 之前 | 加 inter-green 之后（闭合回路） | **换开放车流之后** |
|---|---|---|---|
| 默认 `no_op`（30/30 交替） | −109.2 | −423.1 | **−292.8** |
| 闪烁（每步 `shorten_red`） | −97.2 | −437.2 | **−260.8** |
| 饿死对向（每步 `extend_green`） | −117.2 | −455.4 | **−553.8** |
| 每步 `preempt`（全红） | −223.6 | −777.6 | **−888.0** |

⇒ **这两条不等式在换开放车流之后翻转了一条**：闭合回路里「交替 > 闪烁」成立
（−423.1 > −437.2），因为当时最贵的是**换相的 6 s 清空时间**（它把整队车按住）；
开放车流里排队的不再是固定车队，最贵的是**红灯的时长** ⇒ 换得更勤（红灯更短）
反而更便宜 ⇒ 闪烁（−260.8）**好于**固定周期（−292.8）。
⇒ **但 inter-green 的前提保住了，而且更强**：「饿死对向」**永远是最差的**（−553.8，全红
−888.0）⇒ 需求仍然刻意不等（EW 比 NS 多 1/3）⇒ 模型里**没有**「吊着一轴绿灯」
的退化最优解。
⇒ **⇒ 出厂门槛因此是「最强常调度」（闪烁 −260.8），不是固定周期**（−292.8）。

**饿死惩罚不再被封顶（换开放车流的核心门禁，实测）**：「只服务单轴」的调度
（每步 `preempt`）在三个 horizon 上的延误 ——

| horizon | 开放车流 | 闭合回路 | 开放的最大队列 | 闭合的最大队列 |
|---|---|---|---|---|
| 600 步 | **−888.0** | −777.6 | 26 | **14（= 车队规模，钉死）** |
| 1200 步 | **−3189.6** | −1617.6 | 50 | 14 |
| 2400 步 | **−11996.0** | −3297.6 | 96 | 14 |

⇒ 闭合回路的延误**线性**增长（队列被车队规模封顶），开放车流的**超线性**增长
（队列在长 ⇒ 曲线下面积在长）⇒ **「饿死一轴」的代价不再有上限**。

**golden 改动**：只有 `signal_vocabulary` 块多了一个键——10 个 golden 全部是**纯插入**（20 增 10 删，删掉的那 10 行只是被插入行挤掉逗号的上一行，字段值未变），
10 个 `ts_kernel_*.json` 逐字节不变；每个 `samples[]` 条目、每个 `final_state`
字段、每个既有词汇值都**逐字节相同**（机械校验过）。

**⚠ 覆盖边界（必须记下）**：**响应式交通模型目前是 Python 独有的**——契约镜像
（`simCoreMirror.ts`）没有实现它，所以**交通模型本身没有被跨语言验证**，inter-green
清空也一样。契约覆盖的仍然是「默认交通路径 + 信号语义」。「训练环境与浏览器同源」
正是要把这块补齐。

**✅ 迁移风险已消掉（2026-10-22）**：这条风险记在下面，它说的是
Python 训练场景的车流是**闭合回路**——每条车道只有固定几辆车在循环 ⇒ **被饿死
那一轴的延误有上限**（车数 × episode 长度），而浏览器的车流是**开放生成**的，
饿死一个轴的代价**无界增长** ⇒ 在 Python 里训出来的策略对「饿死一轴」的惩罚偏轻，
搬到浏览器后会更倾向于饿死对向。

**训练场景的车流换成了开放流**：车辆按**固定车头时距**在车道入口生成
（需求 = `TrafficCondition` 的**每轴每小时到达数**），驶过路口后**离开世界**、
不再循环回来 ⇒ 红灯期的排队**向上游累积**，**车队规模不再封顶延误**。
实测（见上面的表）：饿死一轴的延误在 600 / 1200 / 2400 步上是 −888.0 / −3189.6 /
−11996.0（**超线性**），而闭合回路是 −777.6 / −1617.6 / −3297.6（**线性**，队列
被车队规模钉死）⇒ **风险已消**。

⇒ **⇒ 代价**：闭合回路下发布的那批数字（−423.1 / −437.2 / −455.4 / −777.6 与
训练/评估条件分离那一轮的 −399.9 / −498.2 / −375.4 等）**语义变了**（它们是闭合回路下的值）⇒
**文档按新数字改写**，不是追加一行「已过期」。

### 训练条件与评估条件分离（best-of-N）

这一轮交付的是**流程**：训练脚本支持跑多个种子并按**实测评估回报**取最优，
每个种子的数字都写进产物元数据（失败的种子不许被藏起来）。

**为什么「换一个种子」不算分离**：这个 sim **完全没有随机数**（`sim_core.py`
里一处都没有）⇒ 换一个 RNG 种子，episode 一模一样。所以「在另一个种子上评估」
是自欺；**评估集必须是一个不同的初始条件**。为此新增
`app/apps/rl/signal_conditions.py` 的 `TrafficCondition`——场景初始状态的三个旋钮：

| 旋钮 | 含义 |
|---|---|
| `ns_vehicles_per_lane` / `ew_vehicles_per_lane` | **初始车队**：每条车道**开局时**在路上的车数（换开放车流之后它不再决定需求，只决定初始状态） |
| `ns_arrivals_per_hour` / `ew_arrivals_per_hour` | **需求**（开放车流新增）：每条车道**每小时到达数** —— 闭合回路表达不了需求，只有开放车流能 |
| `stream_start` / `stream_spacing` | **摆位**：初始车流从哪儿开始、车距多少 |
| `phase_offset` | **信号偏移**：相位钟从第几秒开始 |

三个条件：

| 条件 | 用途 | 需求 NS/EW（每车道每小时） | 初始车队 NS/EW | 起点 / 车距 | 相位偏移 | 固定 30/30 基线（600 步，**开放车流**） |
|---|---|---|---|---|---|---|
| `TRAIN_CONDITION` | **训练** | 300 / 400 | 3 / 4 | −24 m / 24 m | 0 s | **−292.8** |
| `EVAL_CONDITION` | **评估 + 选优**（留出集） | 400 / 500 | 4 / 5 | −30 m / 18 m | 7 s | **−313.6** |
| `HOLDOUT_CONDITION` | **只做最终报告**（从不用来选） | 300 / 400 | 3 / 4 | −32 m / 20 m | 13 s | **−233.8** |

⇒ **两轴的需求仍然刻意不等**（EW 比 NS 多 1/3）⇒ inter-green 的前提（模型里没有「吊着
一轴绿灯」的退化最优解）**保住**：实测在开放车流下「饿死对向」是**最差**的调度
（−553.8，全红 −888.0）。
⇒ **基线变了**：上表是**开放车流**下的读数；闭合回路下同样是这三个条件，基线是
−423.1 / −505.3 / −393.8 ⇒ 旧数字是**闭合回路**的数字，语义不同。

- 选优（best-of-N）**只在 `EVAL_CONDITION` 上做** ⇒ 选出来的不是「背下了训练
  episode」的那个种子；
- 最终报告再用 `HOLDOUT_CONDITION` 跑一遍 ⇒ 这个数字是**没被任何选择用过的**
  集合上的数字，是「选优本身带来的乐观偏差」之外的一个诚实读数；
- 单个种子内部的「保留本轮最好的 checkpoint」仍然在**训练条件**上选（这是
  「留本轮最好的」这个常规做法），留出条件只花在跨种子的选择上。

**⚠ 覆盖边界（必须记下）**：这三个条件**完全是 Python 训练侧的概念**——
契约镜像（`simCoreMirror.ts`）既没有稠密场景，也没有任何条件切换，更没有
**开放车流**；契约覆盖的仍然是「默认交通路径 + 信号语义」⇒ **golden 零改动**。
换开放车流之后这条边界更宽了：连**交通模型本身**（响应式 + 开放）都是 **Python 独有**
的 ⇒ 交通模型**仍未经过跨语言验证**（见上面「The three training-only knobs」）。
「训练环境与浏览器同源」要解决的是同一件事的另一面：
浏览器只有一种场景，没有「留出集」的概念。

### The signal observation schema — schema only, never values

The traffic-signal agent has its **own** observation (the ego's 14-dim
observation is a different agent's and is untouched). The shared schema is
**six** dimensions:

| idx | meaning | normalisation | browser side | Python side |
|---|---|---|---|---|
| 0 | north-south queue length | `min(q / MAX_QUEUE, 1)` | `getQueueLength(nsLight, network)` | `core.queue_length("ns")` |
| 1 | east-west queue length | `min(q / MAX_QUEUE, 1)` | `getQueueLength(ewLight, network)` | `core.queue_length("ew")` |
| 2 | north-south has right of way | 0 / 1 | the light's phase ∈ {Green, Yellow} | `light.ns_green` |
| 3 | east-west has right of way | 0 / 1 | the light's phase ∈ {Green, Yellow} | `light.ew_green` |
| 4 | all-red (neither axis may go) | 0 / 1 | both lights outside {Green, Yellow} | `not ns_green and not ew_green` |
| 5 | current phase clock — the **elapsed** fraction | `(cycleSeconds − phaseRemaining) / cycleSeconds` | `cycle_timer / cycle_duration` |

**Why the values are NOT compared.** The two sides' traffic models are
different objects: the browser's vehicles live on lanes (`s`, `roadId`,
`stopLineS`) and Python's are free-space NPCs. "The queue on the north axis"
has the same *meaning* on both sides and is computed from *different* things —
comparing the numbers would be comparing two different quantities and would
either be vacuous or produce false alarms. Only the **schema** is shared.

**Why the schema is still worth pinning.** The dimension count, the order and
the normalisation are exactly the things a policy transfer depends on: if the
browser's observation were built in a different order, the exported weights
would silently consume the wrong inputs. Pinning the schema makes that a
compile-time/assertion failure instead of a mysteriously bad policy.

⇒ The observation schema is asserted **inside each side** (each side has its
own test); the *cross-language* assertion on it is deliberately **schema-only**
and is recorded in row 1d of the cross-language-difference table below.

### The rest of the uncovered ground

- **The product's full trajectory** — difference #6 (free space vs lane arc
  length) is structural. The contract compares the *ego dynamics* and the
  *scenario semantics*, not the product's lane-constrained path.
- **The product's Rapier path** — there `v.speed` is re-read from the Rapier
  pose rather than from the previous `targetSpeed`, so multi-step browser
  trajectories are not bit-identical to Python even at `dt = 0.1`. The
  contract claims item-by-item equality for the **hand-rolled** path only.
- **`dt` other than `PYTHON_SIM.DT` (0.1)** — the product passes a variable
  frame delta; the golden is generated with 0.1.
- **Observation encoding (L2)** — Python's `_obs()` returns **float32**
  (`np.zeros(OBS_DIM, dtype=np.float32)`); the mirror returns float64, about
  1e-7 apart. No current assertion compares obs.
- **The replay vehicle's road-end clamp** — the replay target is exempt from
  the constraint layer (the policy owns its speed), so it is *not* force-
  stopped at a road end. A replay vehicle that stalls there reports
  `desiredStatus: 'driving'` while its speed is 0 (the Rapier branch still
  zeroes the speed). This is a deliberate consequence of "the policy owns the
  speed", not a defect to be fixed here — re-arming the clamp would hand the
  constraint layer ownership of a speed the policy is supposed to own. The
  vehicle was already stuck before the exemption existed.

### The three training-only knobs — **named blind spots**

Three things the Python training sim has and the contract does **not** compare.
All are listed here on purpose: a blind spot that is not written down is
indistinguishable from a coverage gap nobody noticed.

| Blind spot | What it is | Why the contract does not cover it |
|---|---|---|
| **The reward function** | `reward = PROGRESS_WEIGHT * progress − TIME_COST`, and the mileage is only earned **while the ego is on the road** (`progress = 0` once the off-road latch is set) | The mirror has **no reward at all** — the contract compares the trajectory, the termination and the light bits, never a return. The goldens' samples carry the pose and the light bits only (**no reward field**), so changing the reward **cannot** move a golden. Measured: after the reward was changed, **every committed golden stayed byte-identical** (`git diff` on `tests/contract/snapshots/` is empty) and the contract still passes (169). |
| **`SimCore.light_cycle_seconds`** | An **optional override** of the signalled scene's light cycle, used by the light curriculum in `app/apps/rl/train.py` (`--light-curriculum`). `None` — the default — is the scene's own cycle, and that is the value the `scene_light` block pins | The TypeScript mirror has **no counterpart** (the mirror always runs the default cycle), and the contract vectors always run the default too. It is a **training-only** knob, exactly like `responsive_traffic` (see the coverage boundary above). The default is pinned *as a constant* by the `scene_light` block, so a one-sided change of the default still turns the contract red. |
| **The traffic model itself** (`responsive_traffic` and, since the open-traffic change, the **open** traffic) | The vehicles' behaviour: whether they obey the light, queue up behind each other, and — since then — whether they are **generated and disappear** (open) or **respawned** (closed loop) | The mirror implements **no** traffic model at all: its NPCs drive straight through the intersection at a constant speed. The contract therefore covers the **default path** (`responsive_traffic=False`, no open traffic) — which is exactly what the goldens run — and **nothing** about the responsive or open models. **⇒ the traffic model is still not cross-language verified.** The open traffic is a **knob** (`SimCore.open_traffic`, default **off**) precisely so that the default path could not move: measured, the 18 contract vectors stayed byte-identical and the contract still passes (169). |

⇒ **What this means for a reader**: the contract proves the two sides agree on
**what the ego does**, not on **what it is paid**, not on the training
knobs, and **not on the traffic**. A change to the reward, the demand or
the traffic can therefore pass every contract gate — which is why the
gates (the ego gate, the step lower bound, the training report, and the
open-traffic gates in `tests/test_signal_open_traffic.py`) are the ones that have to
catch it.

## Platform assumption

The bit-exact assertions depend on **V8's `Math.sin` / `Math.cos` /
`Math.atan2`**. ECMA-262 specifies these as *implementation-approximated* —
the engine picks the precision — so they are not guaranteed to be identical
across engines or versions.

Measured on a randomised cross-check (300 initial states × 40 steps of
adversarial steering): the two languages agreed on 11489 of 12000 steps, and
every disagreement was 1 ULP in the last bit of the heading, amplified by the
chaotic `x → atan2 → steer → heading` feedback. The largest absolute
divergence was **1.09e-13 m**. The contract's own vectors are unaffected —
they are straight-line, where `sin(0)` is exactly `0.0` and `atan2(dz, 0)` is
exactly `π/2` on both sides, so no libm divergence point is ever reached.

A V8 upgrade that changes `Math.sin`'s last bits would break the bit-exact
fixtures. If that happens, the failure is a platform change, not drift — but
it must be investigated as one, not silently relaxed.

## How to run

```sh
# 1. Regenerate the TS goldens (after changing either side's dynamics)
cd TraffSim3D-frontend && npm run contract:gen

# 2. Check the committed goldens still match what the code produces
cd TraffSim3D-frontend && npm run test:contract   # = npm run contract:check

# 3. Run the contract
cd ../TraffSim3D-backend
.\.venv\Scripts\python.exe -m pytest tests/contract/ -v
#   → all pass, 0 skipped
```

`npm run test:contract` exits non-zero naming the stale files, and reports
goldens that no vector produces. It never rewrites anything.

## The discrete forward-pass contract (L5)

The browser could only run a **continuous 2-dim** action policy. A
traffic-signal agent has a **discrete 5-way** action, and SB3's
`CategoricalPolicy` has **no** `log_std` — it produces action *logits*.
So there are two halves:

1. **The export** (`app/apps/rl/weights.py`): `log_std` is optional — it
   exists only for a continuous (Box) policy — and the export carries an
   explicit `action_space` field (`"discrete"` / `"continuous"`) so the
   consumer knows which forward pass to use. The continuous export is
   otherwise unchanged, so the fixtures exported before the discrete-policy
   export keep working.
2. **The forward pass** (`src/infrastructure/rl/mlpInference.ts`):
   `mlpForwardDiscrete(obs, weights)` runs the same layer layout
   (`policy_net.0 → Tanh → policy_net.2 → Tanh → action_net`) and takes
   the **argmax** of the logits. No softmax: argmax is monotonically
   equivalent for the decision and numerically steadier.

The **gate** is a committed fixture. The backend generates it:

```sh
cd TraffSim3D-backend
.\.venv\Scripts\python.exe scripts\gen_discrete_policy_fixture.py
```

It builds a real SB3 PPO with a `Discrete(5)` action space, exports it
through `export_weights` (the path under test — the export must succeed
*without* a `log_std`), and computes the expected action for a list of
observations twice: once with **SB3's own policy forward** and once with
a **pure-Python reference** on the exported weights. Both must agree, and
the fixture carries the result. The generation is deterministic (a fixed
seed), so re-running the script is a no-op in git.

The fixture lands in
`TraffSim3D-frontend/src/infrastructure/rl/fixtures/discrete-policy-fixture.json`
(next to the MLP fixture). The frontend's
`mlpInference.discrete.spec.ts` asserts that `mlpForwardDiscrete` returns
the committed actions, and the backend's `tests/test_rl_discrete_forward.py`
asserts the Python half.

One deliberate detail: the generator scales the action layer by a positive
constant before saving. SB3 initialises it with a gain of 0.01, so an
*untrained* policy's logits are nearly uniform — the top-2 margin of a
random observation would be ~1e-3, far too small for a float32 (SB3) vs
float64 (Python / TypeScript) comparison to mean anything. Scaling by a
positive constant leaves the **argmax unchanged** and multiplies the
margin by the same factor, so the fixture stays a sharp test.

## The signal policy's transfer check (L6)

The L6 fixture above pins the *forward pass* on an **untrained** policy.
The signal agent's fixture pins it on the policy the project actually
**trains** — the weights Python produces must be interpretable by the
browser, or "the AI commands the light" is a claim with nothing behind it.

```sh
cd TraffSim3D-backend
.\.venv\Scripts\python.exe scripts\gen_signal_policy_fixture.py
```

The generator **trains** a signal policy through the shipped entry point
(`app.apps.rl.signal_train.train_signal_policy`), exports it through
`export_weights` (the path under test — a discrete policy has no
`log_std`), and computes the expected action for a list of observations
twice: once with **SB3's own policy forward** and once with the
**pure-Python reference** on the exported weights. Both must agree. Unlike
the untrained fixture, this one needs no logit scaling: a trained policy
has wide margins, and the generator **drops** any observation whose
top-1/top-2 margin is too small for a float32 (SB3) vs float64 (Python /
TypeScript) comparison to be meaningful.

The fixture lands in
`TraffSim3D-frontend/src/infrastructure/rl/fixtures/signal-policy-fixture.json`.
The frontend's `signalPolicyFixture.spec.ts` asserts that
`mlpForwardDiscrete` returns the committed actions **and** that the action
index maps to the shared five-action vocabulary.

**What this does NOT cover**: the *observation values* the two sides feed
the network are still only **schema**-comparable (row 1d above) — the
browser's traffic model is not the Python training sim's traffic model.
What the fixture pins is that, given the same observation, both sides
compute the same action.

## Cross-language differences (status)

| # | Dimension | Status |
|---|---|---|
| 1 | Traffic-light phase model | ⚠️ mitigated — the observation pair stays one-hot; the 3 s yellow shifts the flip point by 3 s. The phase **duration** is **partially observed**: the golden samples carry the light bits, so a drift is caught if the first flip lands inside the sampled window (≤ 25.0 s) — see above |
| 1b | Signal-action **vocabulary** | ✅ aligned and **asserted cross-language** (L4): the five names + the three semantics constants are compared item by item |
| 1c | Signal-action **semantics** / phase timeline | ⚠️ **partially** asserted cross-language: the **mirror's** per-action semantics are now compared at the trajectory level (the `signalled_light_*` vectors apply the same action at the same step on both sides and must stay bit-identical). The **browser's** phase timeline is still **not** asserted — it has a 3 s yellow per light and Python has none, so the axis-green projections differ at the transitions |
| 1d | Signal agent's **observation values** | ⚠️ **schema only, never values**: the two sides' traffic models are different objects, so "the queue on an axis" is the same *meaning* computed from different things. The schema (dims, order, normalisation) is shared and pinned; the numbers are not compared — see "the signal observation schema" |
| 2 | `obs[6:8]` semantics | ✅ aligned |
| 3 | Pure Pursuit denominator (`LOOKAHEAD_DISTANCE`) | ✅ **covered** — the `steer_*` vectors actually steer, and mutating the constant turns the contract red (a committed gate, not a one-off measurement) |
| 4 | Steer clamp (`MAX_STEER`) | ✅ **covered** — the turning vectors reach the clamp, and mutating the constant turns the contract red |
| 5 | Heading integration | ❌ separate topic |
| 6 | Motion constraint (free space vs lane) | ❌ structural — separate topic |
| 7 | Speed integration | ✅ aligned for the replay path |

## File layout

```
tests/contract/
├── test_vector.json                  # fixed inputs (git tracked)
├── test_cross_lang_consistency.py    # the comparison (never skips) + the snapshot writer
├── test_python_snapshot.py           # refreshes python_<name>.json (same schema as above)
├── test_light_phase.py               # the phase-flip boundary, pinned on the Python side
├── test_signal_actions.py            # the five signal actions, pinned on the Python side
└── snapshots/
    ├── ts_cross_baseline.json        # TS goldens — COMMITTED
    ├── ts_corridor_baseline.json
    ├── ts_cross_action_overrange.json
    ├── ts_t_junction_lights.json
    ├── ts_roundabout_truncation.json
    ├── ts_signalled_light_*.json     # the action-driven vectors
    ├── ts_steer_*.json               # the turning vectors
    ├── ts_kernel_*.json              # kernel-level goldens — COMMITTED
    └── python_*.json                 # regenerated per run — gitignored
```

Each `ts_<name>.json` carries the `signal_vocabulary` block (the five
action names + the three semantics constants) — that block is the **L4**
cross-language assertion.

`python_<name>.json` has the **same schema** as the `ts_<name>.json` goldens
(light bits and `final_state` included). There is a single writer for it —
`_write_python_snapshot` in `test_cross_lang_consistency.py` — which the
legacy sibling test calls; two writers with two schemas is what used to make
the on-disk Python artefact lose the light bits.

The TypeScript side lives in
`TraffSim3D-frontend/src/domain/services/egoKernel.ts` (the shared ego
kernel), `TraffSim3D-frontend/src/application/services/simCoreMirror.ts`
(the contract mirror) and
`TraffSim3D-frontend/scripts/generate-contract-snapshots.ts` (the generator).
The **TypeScript copy of the action vocabulary** lives in
`TraffSim3D-frontend/src/shared/constants/simulation.ts`
(`SIGNAL_ACTION_NAMES`, `ALL_RED_SECS`, `PHASE_ADJUST_SECS`); the
**Python copy** lives in `app/apps/rl/sim_core.py`.

The design and the verification evidence for this contract are the sections
above; the two oracles described in "Run the same gates locally" reproduce
every measured number quoted here.

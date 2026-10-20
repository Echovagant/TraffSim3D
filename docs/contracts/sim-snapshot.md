# Cross-Language Sim Contract

> **状态（2026-10-20 起，Plan 071；2026-10-21 复测）：契约已激活并真实执行。**
> 比对测试不再跳过 —— TS 侧快照缺失时**失败**而不是跳过。
> 快照由 `TraffSim3D-frontend` 生成并入库，后端测试可独立跑完整契约。
> 实测（2026-10-21）：`pytest tests/contract/` → **16 passed / 0 failed / 0 skipped**。
>
> **状态（2026-10-21，Plan 072 修复波）：本文件此前高估了契约的覆盖面。**
> 下文「What the contract does NOT cover」一节已按**实测**的变异盲区重写：
> 信号相位时长在两侧都是**未被观测**的。修订前的版本只列了
> `MAX_STEER` / `LOOKAHEAD_DISTANCE` 两个盲点。
>
> **状态（2026-10-21，Plan 073 Sprint 2 / A2a）：信号灯成为可被外部动作驱动的控制面。**
> 两侧各持一份**自己拥有的**动作词表（五个动作名 + 两个语义常量），
> 词表被写进 golden，由 Python 契约测试**逐项**比对 —— 这是本 Sprint 的
> 跨语言门禁。
> **注意：本 Sprint 没有引入「跨语言相位序列」断言**（原因见
> 「What the contract does NOT cover」新增的一节），
> 因此**每个动作的语义只由各自一侧的单元测试把关**。
> 实测（2026-10-21）：`pytest tests/contract/` → **40 passed / 0 failed / 0 skipped**
> （Sprint 2 交付 35；审阅中发现并修掉一个**信号灯永久卡死**的缺陷后 +5，见
> 「Sprint 2 修复波」一节）。

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
| **L4 vocabulary** | the five signal-action names + the three semantics constants | the **Python training sim**'s own copy (`sim_core.SIGNAL_ACTION_NAMES`) | the `signal_vocabulary` block inside `ts_<name>.json` |

**L4 (the signal-action vocabulary)** was added in Plan 073 Sprint 2. The
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

The **mirror** exists because the *product* TS sim is a lane-based,
Rapier-driven sandbox, structurally incompatible with Python's free-space
model (cross-language difference #6). A trajectory comparison against the
product sim would therefore be meaningless. The mirror is the contract-side
counterpart, and — crucially — the ego kinematics it uses are **shared** with
the product replay path through `@domain/services/egoKernel`, so the mirror
and the product cannot drift apart on the ego model.

**L2 (observation encoding)** is not asserted yet: `buildReplayObs` was
aligned with Python's `_obs()` in Plan 069, but a cross-language assertion for
it needs a scalar-level entry point into the obs builder. See "Not covered".

## The vectors

| Vector | Scene | What it pins |
|---|---|---|
| `cross_baseline` | cross | The straight-line reference run: ego kinematics, the `success` termination at step 58. |
| `corridor_baseline` | corridor | The same in the corridor scene (`success_corridor` termination). |
| `cross_action_overrange` | cross | The **cross-language action clip**: every action is `2.0`, outside the policy's `[-1, 1]` range. |
| `t_junction_lights` | t_junction | The **longest signalled episode**: a parked ego that collides at step 257, sampled every 10 steps (26 samples, steps 0…250). This is the vector that makes the traffic-light phase observable at all. |
| `roundabout_truncation` | roundabout | The **truncation** path: the episode runs to the step limit (400) and ends `truncated` with no termination reason. Its light is both-green, so the phase swap is a no-op — the vector pins the truncation semantics, not the phase. |

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
| `scene_kind` | The Python scene to run: `cross` / `corridor` / `t_junction` / `roundabout`. |
| `ego_id` | The ego's id, recorded in every sample. |
| `n_steps` | The **expanded** action count (see the expansion rule below). Neither side reads it today. |
| `actions` | The literal action list. Each entry is a pair, but **only the first element is read**: it is the acceleration command, clipped to `[-1, 1]` and scaled to 3 m/s². The steer is *not* taken from the action — both sides compute it with Pure Pursuit. |
| `repeat` | **Optional.** Expands `actions` this many times. Absent → the sequence is `actions` itself. |
| `max_steps` | **Optional.** The episode's step limit (Python `SimCore.max_steps`). Absent → `MAX_STEPS_DEFAULT` (200). |

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
Plan 050 file format; nothing reads it.

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
    "max_green_seconds": 60
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
| `final_state.terminated` | The episode ended by a **termination** — success, collision or red light. |
| `final_state.truncated` | The episode hit the **step limit** instead. The two flags are mutually exclusive (the limit is only reached when the episode has not terminated), and a truncated episode carries **no** termination reason: `reason` is the empty string. |
| `final_state.reason` | The termination reason, or `""` when the episode was truncated. |
| `final_state.final_step` | The step the episode ended on. |
| `final_state.final_z` / `final_x` / `final_speed` | The ego's final pose and speed. |
| `samples[].step` | The step the sample was taken at. Steps 0, 10, 20, … are sampled (`sample_every`), plus the last action index. |
| `samples[].light` | The traffic-light bits at that sample: which axis is green. This is the **only** common semantic between Python's `ns_green` / `ew_green` pair and the frontend's 10-value phase enum ("which axis is green"). Comparing them directly is what makes the signal phase **duration** observable — before Sprint 1, a change to the cycle length was invisible to every gate. |

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
`egoKernel.ts` and `simCoreMirror.ts`. Five are listed here; the sixth — the
platform assumption about V8's transcendental functions — has its own section
below.

1. The Pure Pursuit denominator is the **constant** `LOOKAHEAD_DISTANCE = 8.0`,
   never the actual distance to the target.
2. Update order is speed → heading → position, and `steer` is computed from
   the state *before* the update.
3. `wrapPi` replays CPython's float-modulo algorithm exactly (`fmod` plus one
   conditional add of the modulus). The shorter "always add 2π and re-mod"
   spelling is **not** equivalent — it adds a rounding step.
4. Statement order mirrors Python's, and the action is converted with
   `Math.fround` before clipping — Python's actions always pass through
   `np.float32`, and the policy's output layer has no tanh, so raw actions can
   leave `[-1, 1]`. Skipping the cast made the two sides differ on 11584 of
   12000 steps in a randomised cross-check.
5. **NaN semantics are pinned, and the two clamp flavours are not
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
| `LOOKAHEAD_DISTANCE` | **blind** | **blind** | yes |
| `MAX_STEER` | **blind** | **blind** | yes |
| `EGO_WHEELBASE` | **blind** | **blind** | **no** |
| `INTERSECTION_RADIUS` | **blind** | **blind** | **no** |
| `ROUNDABOUT_RADIUS` | **blind** | **blind** | **no** |
| `NPC_SPEED` | **blind** | **blind** | **no** |
| **traffic-light phase duration** (`TrafficLight.cycle_duration` / `PYTHON_SIM.LIGHT_CYCLE_SECONDS`) | **partially covered** — caught when the first flip lands inside the *sampled* window (≤ 25.0 s); a drift of 30 → 26 s is **not** caught | same | **no** (was fully blind) |

### The traffic-light phase duration — partially covered

The signal phase is cross-language difference #1 and the central topic of this
document, so its coverage is stated precisely rather than as a yes/no.

**What changed (Plan 073 Sprint 1)**: the golden samples now carry the light
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
   respawns on the ego's own line.
2. **Every vector is straight-line**, so `steer ≡ 0`. The Pure Pursuit
   denominator, the steer clamp and the wheelbase therefore cannot affect the
   trajectory at all.
3. **The NPCs never interact with the ego** in the vectors that matter — no
   collision, no influence on the ego's path — so `NPC_SPEED` and the scene
   radii are invisible.

### How to close the rest

1. **Add a Python scene whose signalled ego can idle for ≥ 300 steps** — the
   phase flips at 300 steps, so the window must reach that far. This needs a
   scene whose NPC layout never reaches the ego, which is scene-extension
   work (Plan 073 Sprint 5), not a vector change: with the current four
   scenes it is **provably impossible** (the reachability numbers above).
2. **Add a vector that actually steers** (a target off the ego's heading), so
   `LOOKAHEAD_DISTANCE`, `MAX_STEER` and `EGO_WHEELBASE` become observable.
3. ~~**Record the light bits in the golden samples**~~ — **done** in Sprint 1:
   the light is now compared directly instead of only through its side
   effect on the termination reason.

### The signal phase timeline — NOT covered (Plan 073 Sprint 2)

Sprint 2 made the signal an externally-actionable control surface on both
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
  cross-axis delay has to be in it (Plan 073 Sprint 3 designs it);
- a hard wall-clock bound on the green needs the two phase models aligned
  (Plan 073 Sprint 5), because the browser counts per light and Python
  counts per axis pair.

Nothing above is *enforced* by the cross-language contract: it compares the
**vocabulary and the constants**, not the resulting timelines.

### Sprint 2 修复波 — 审阅中发现并修掉的信号灯永久卡死

Sprint 2 的交付审阅里复现了一个**真实缺陷**：两侧的「清空结束」边界上，
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
Sprint 3 的策略是**照着这个动作空间训练**的，事后再改语义就作废了训练结果。
上限沿用项目既有的 `MAX_GREEN_SECS` 约定（`ActuatedController` 同款），
并作为第三个常量进入 L4 词汇断言。

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

## Cross-language differences (status)

| # | Dimension | Status |
|---|---|---|
| 1 | Traffic-light phase model | ⚠️ mitigated — the observation pair stays one-hot; the 3 s yellow shifts the flip point by 3 s. The phase **duration** is **partially observed**: the golden samples carry the light bits, so a drift is caught if the first flip lands inside the sampled window (≤ 25.0 s) — see above |
| 1b | Signal-action **vocabulary** | ✅ aligned and **asserted cross-language** (Plan 073 Sprint 2, L4): the five names + the three semantics constants are compared item by item |
| 1c | Signal-action **semantics** / phase timeline | ⚠️ **not** asserted cross-language — the browser has a 3 s yellow per light and Python has none, so the axis-green projections differ at the transitions. Each side's semantics are pinned by its own unit tests — see "The signal phase timeline — NOT covered" |
| 2 | `obs[6:8]` semantics | ✅ aligned (Plan 069) |
| 3 | Pure Pursuit denominator | ❌ not covered by the contract vectors (see above) |
| 4 | Steer clamp | ❌ not covered by the contract vectors (see above) |
| 5 | Heading integration | ❌ separate topic |
| 6 | Motion constraint (free space vs lane) | ❌ structural — separate topic |
| 7 | Speed integration | ✅ aligned for the replay path (Plan 071) |

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

The design and the full verification evidence are in
the cross-language contract (ADR-008); the task-by-task execution
record is in the same ADR's implementation notes.

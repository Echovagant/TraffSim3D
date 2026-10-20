# Cross-Language Sim Contract

> **状态（2026-10-20，Plan 071 起）：契约已激活并真实执行。**
> 比对测试不再跳过 —— TS 侧快照缺失时**失败**而不是跳过。
> 快照由 `TraffSim3D-frontend` 生成并入库，后端测试可独立跑完整契约。
> 实测：`pytest tests/contract/` → **9 passed / 0 failed / 0 skipped**。
>
> **状态（2026-10-21，Plan 072 修复波）：本文件此前高估了契约的覆盖面。**
> 下文「What the contract does NOT cover」一节已按**实测**的变异盲区重写：
> 信号相位时长在两侧都是**未被观测**的。修订前的版本只列了
> `MAX_STEER` / `LOOKAHEAD_DISTANCE` 两个盲点。

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

`cross_action_overrange`'s scenario golden is **identical to
`cross_baseline`'s** — every sample and the whole `final_state` — because
*both* sides clip the action into `[-1, 1]` before scaling it, so `2.0` and
`1.0` are the same command on both sides. That equality is the point: the
vector is a two-sided assertion that the clip happens at the same place, in
the same operation sequence, on both sides. (Its kernel golden is the
baseline's 95-step speed series extended to 100 steps — the extra five steps
carry the same values.) The name says "action over range", not "more
acceleration": the vector does **not** accelerate harder than the baseline.

`n_steps` in `test_vector.json` must equal the vector's action count
(95 / 160 / 100). Neither side reads it today, but a wrong value is a trap
for whoever adds the next vector.

`tolerance: 0.01` in `test_vector.json` is **not** used by this contract —
the assertions are exact equality (below). It is still read by the legacy
sibling test `tests/contract/test_python_snapshot.py`, which copies it into
the Python-side snapshot files it writes; it applies to that legacy test
only.

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

This is only possible because of six porting rules, all enforced in
`egoKernel.ts` and `simCoreMirror.ts`:

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

⇒ **The repository has no CI.** There is no `.github/` directory and no other
pipeline configuration, so **both oracles are run manually**:

```sh
# backend oracle (Python vs the committed TS goldens)
cd TraffSim3D-backend && .\.venv\Scripts\python.exe -m pytest tests/contract/ -v

# TS oracle (the committed goldens vs what the TS code produces now)
cd TraffSim3D-frontend && npm run test:contract     # alias of npm run contract:check
```

Running only the backend test would not notice a change in the TypeScript
sources at all, because the goldens are committed artefacts — and nothing in
the repository enforces that the TS oracle is ever run.

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
| **traffic-light phase duration** (`TrafficLight.cycle_duration` / `PYTHON_SIM.LIGHT_CYCLE_SECONDS`) | **blind** | **blind** | **no** |

### The traffic-light phase duration is unobserved

This is the important one, because the signal phase is cross-language
difference #1 and the central topic of this document.

- **Python**: `cycle_duration` = 60 / 20 / 10 / 5 s all produce an
  **identical** result — same reason, same step, same `z`, `x`, speed and
  samples. It only becomes visible at **≤ 4.5 s**, and then only as a
  `red_light` termination (at step 34–45).
- **TS**: mutating `PYTHON_SIM.LIGHT_CYCLE_SECONDS` to 60 / 20 / 10 / 5 s
  leaves the recomputed golden **byte-identical** to the committed one, so
  `npm run test:contract` stays green. No unit spec under `frontend/src`
  references the phase duration at all.

⇒ **A change to the signal phase on either side passes all three gates
silently.** The contract does **not** guarantee that the two sides agree on
when the light changes.

### Root cause

Three structural facts about the vectors:

1. **Every vector terminates at step 58 (5.8 s)**, far short of the 30 s
   phase — the light never flips during an episode.
2. **Every vector is straight-line**, so `steer ≡ 0`. The Pure Pursuit
   denominator, the steer clamp and the wheelbase therefore cannot affect the
   trajectory at all.
3. **The NPCs never interact with the ego** — no collision, no influence on
   the ego's path — so `NPC_SPEED` and the scene radii are invisible.

The signal phase is observable only through its *side effect*: a `red_light`
termination, i.e. only if the phase flips while the ego is inside the
intersection box (`|x| < 8` and `|z| < 8`, roughly steps 34–47). Any phase of
5 s or more flips too late to matter.

### How to close it

1. **Add a vector that runs ≥ 300 steps**, so the light cycle is observable
   (the phase flips at least once while the ego is inside the intersection).
2. **Add a vector that actually steers** (a target off the ego's heading),
   so `LOOKAHEAD_DISTANCE`, `MAX_STEER` and `EGO_WHEELBASE` become
   observable.
3. **Record the light bits (`obs[6:8]`) in the golden samples**, so the phase
   is compared directly instead of only through its side effect on the
   termination reason.

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
| 1 | Traffic-light phase model | ⚠️ mitigated — the observation pair stays one-hot; the 3 s yellow shifts the flip point by 3 s. The phase **duration** is **not observed** by the contract (see above) |
| 2 | `obs[6:8]` semantics | ✅ aligned (Plan 069) |
| 3 | Pure Pursuit denominator | ❌ not covered by the contract vectors (see above) |
| 4 | Steer clamp | ❌ not covered by the contract vectors (see above) |
| 5 | Heading integration | ❌ separate topic |
| 6 | Motion constraint (free space vs lane) | ❌ structural — separate topic |
| 7 | Speed integration | ✅ aligned for the replay path (Plan 071) |

## File layout

```
tests/contract/
├── __init__.py
├── test_vector.json                  # fixed inputs (git tracked)
├── test_cross_lang_consistency.py    # the comparison (never skips)
└── snapshots/
    ├── ts_cross_baseline.json        # TS goldens — COMMITTED
    ├── ts_corridor_baseline.json
    ├── ts_cross_action_overrange.json
    ├── ts_kernel_*.json              # kernel-level goldens — COMMITTED
    └── python_*.json                 # regenerated per run — gitignored
```

The TypeScript side lives in
`TraffSim3D-frontend/src/domain/services/egoKernel.ts` (the shared ego
kernel), `TraffSim3D-frontend/src/application/services/simCoreMirror.ts`
(the contract mirror) and
`TraffSim3D-frontend/scripts/generate-contract-snapshots.ts` (the generator).

The design and the full verification evidence are in
the cross-language contract (ADR-008); the task-by-task execution
record is in the same ADR's implementation notes.

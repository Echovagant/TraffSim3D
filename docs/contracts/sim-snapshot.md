# Cross-Language Sim Contract

> **状态（2026-10-20，Plan 071 起）：契约已激活并真实执行。**
> 比对测试不再跳过 —— TS 侧快照缺失时**失败**而不是跳过。
> 快照由 `TraffSim3D-frontend` 生成并入库，后端测试可独立跑完整契约。
> 实测：`pytest tests/contract/` → **9 passed / 0 failed / 0 skipped**。

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

This is only possible because of four porting rules, all enforced in
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

## The contract is two-sided, with two different oracles

This is the part that is easy to get wrong. The backend test compares
**Python's live output** against the **committed TS golden** — it is a golden
test. Therefore:

| Drift | What catches it |
|---|---|
| **Python-side** (the sim, its constants, its termination rules) | `pytest tests/contract/` goes red |
| **TS-side** (the mirror, the kernel, the replay path) | `npm run contract:check` reports the goldens stale; the TS unit specs for the mutated module also go red |
| **A missing golden** | `pytest tests/contract/` goes red (`test_contract_snapshots_are_present`) |

⇒ **CI must run both**: the backend contract test *and* `npm run contract:check`.
Running only the backend test would not notice a change in the TypeScript
sources at all, because the goldens are committed artefacts.

## What the contract does NOT cover

These are measured, not assumed.

- **The Pure Pursuit denominator and the steer clamp** (differences #3/#4).
  Every contract vector is a straight-line scenario, in which `alpha` is
  identically 0 and `steer` is identically 0 — so neither constant can affect
  the trajectory. Proven by mutation: changing Python's `MAX_STEER` (0.4 → 0.5)
  or its `LOOKAHEAD_DISTANCE` (8.0 → 8.1) leaves the contract **green**.
  The TypeScript side *is* covered, by a unit test that pins the steer value
  against CPython.
  ⇒ Covering the steering parameters needs a vector that actually steers.
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
cd TraffSim3D-frontend && npm run contract:check

# 3. Run the contract
cd ../TraffSim3D-backend
.\.venv\Scripts\python.exe -m pytest tests/contract/ -v
#   → all pass, 0 skipped
```

`npm run contract:check` exits non-zero naming the stale files, and reports
goldens that no vector produces. It never rewrites anything.

## Cross-language differences (status)

| # | Dimension | Status |
|---|---|---|
| 1 | Traffic-light phase model | ⚠️ mitigated — the observation pair stays one-hot; the 3 s yellow shifts the flip point by 3 s |
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
    ├── ts_cross_overaccel.json
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

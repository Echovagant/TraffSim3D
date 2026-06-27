# Cross-Language Sim Contract (Plan 050)

## Why this exists

The Python sim (`TraffSim3D-backend/app/apps/rl/sim_core.py`) and the
TS sim (`TraffSim3D-frontend/src/application/services/tick.ts` + domain
entities) are **independent implementations** — not a 1:1 port. They
share the same ego dynamics formula (Pure Pursuit + Euler integration)
but differ in NPC behavior, signal controllers, and physics.

A state-trajectory diff would be brittle (NPC positions diverge
immediately because the two sims use different NPC speeds / collision
logic). So the contract test is **behavioral**, not state-equality.

## What the contract checks

For each scene (`cross`, `corridor`), with a fixed deterministic
action sequence, BOTH sims must:

1. Start ego at the same position/heading
2. Terminate with the same `reason` (e.g. both "success" or both
   "success_corridor")
3. Terminate within ±20% of the same step count
4. Reach roughly the same final `z` (within 1m)

NPC state is **not** compared.

## How to run locally

```sh
# 1. Run the e2e test to generate the TS-side snapshot.
cd TraffSim3D-frontend && npm run test:e2e -- contract-snapshot
#   → writes tests/contract/snapshots/ts_<name>.json

# 2. Run the backend contract test to compare Python + TS snapshots.
cd ../TraffSim3D-backend
uv run pytest tests/contract/ -v
#   → 3 tests pass: 1 snapshot generator + 1 consistency check
#     + 1 Python-side self check.
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
    ├── ts_cross_baseline.json             # from Playwright e2e
    └── ts_corridor_baseline.json          # from Playwright e2e
```

The `test_vector.json` and the test scripts are the contract; the
JSON snapshot files are the comparison data.

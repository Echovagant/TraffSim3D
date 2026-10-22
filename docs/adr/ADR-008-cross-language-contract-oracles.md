# ADR-008: Cross-language contract — what is compared, and by which oracle

- **Status**: ✅ **Accepted** (2026-10-21)
- **Date**: 2026-10-21
- **Deciders**: Project lead (contract scope)
- **Source**: the original master plan — project purpose (§1.1) and
  architecture principles (§6) — plus the cross-language contract design and
  implementation records: the executable contract and its two oracles

## Context

The project's purpose is **"let AI learn to drive and to decide in a virtual
city"**. The RL training sim lives in Python (`app/apps/rl/sim_core.py`); the
browser replays the trained policy in TypeScript. For that to mean anything,
the two implementations must not silently drift apart.

A cross-language contract test had been in the test suite from early on — and
it **never ran**. The TypeScript-side snapshot generator was never implemented,
so the test took a `continue` branch and reported success while comparing
nothing. A source-level audit later found the deeper problem: the contract's
premise was false. The original design asserted the two sims "share the same
ego dynamics", but they do not:

| # | Dimension | Python `sim_core.py` | TS `tick.ts` |
|---|---|---|---|
| 3 | Pure Pursuit denominator | constant `LOOKAHEAD_DISTANCE = 8.0` | actual distance to the target |
| 4 | Steer clamp | `±0.4` rad | `±π/4` |
| 5 | Heading integration | `heading += steer * dt` | Rapier angular velocity |
| 6 | Motion constraint | free space (`x += speed·cos(heading)·dt`) | lane arc length (`s`), position = `lanePoint(…)` |

Difference #6 is **structural**: the product sim is a lane-based sandbox with
OSM maps, traffic lights, lane changes and OOB cleanup; the training sim is a
free-space bicycle model with one intersection and four NPCs. A full-trajectory
comparison between them is meaningless, no matter how the tolerances are tuned.

## Decision

**Three decisions, together.**

### D1 — The contract compares a purpose-built *shadow mirror*, not the product sim

The TypeScript side of the contract is
`src/application/services/simCoreMirror.ts`: a statement-for-statement port
of the Python `SimCore` — same constants, same equations, same statement
order, same termination rules and reason strings.

The **product** sim is covered by a different, narrower contract: the shared
ego kernel (`src/domain/services/egoKernel.ts`) is used by *both* the product
replay path and the mirror, so the product's ego dynamics cannot drift from
the mirror's. The kernel-level contract asserts the product replay path's speed
series against Python's.

### D2 — Two oracles, because the golden files are committed artefacts

| Drift | Oracle |
|---|---|
| Python side (the sim, its constants, its termination rules) | `pytest tests/contract/` — runs the **live** Python sim against the committed goldens |
| TypeScript side (the mirror, the kernel, the replay path) | `npm run contract:check` — regenerates the goldens from the TS sources and fails when they no longer match |
| A missing golden | `pytest tests/contract/` — `test_contract_snapshots_are_present` |

**Both are required.** Running only the backend test cannot see a change in the
TypeScript sources at all, because the goldens are committed artefacts; running
only `contract:check` only proves the goldens match the TypeScript code, not
that the two implementations agree. The CI `contract` job runs both.

### D3 — Exact equality, with the platform assumption stated

The assertions use `==`, not a tolerance. Both sides execute the same
floating-point operation sequence, so their trajectories are bit-identical
(measured: 0 differences across 58 steps of the `speed` and `x` series;
`final_z = 26.20100000000003` and `final_x = 1.467525924532092e-14` on both
sides).

A tolerance would hide exactly the failure the contract exists to catch:
silent drift on one side.

**This depends on a stated platform assumption**: the bit-exactness relies on
V8's `Math.sin` / `Math.cos` / `Math.atan2`, which ECMA-262 leaves
*implementation-approximated*. On a randomised cross-check (300 initial states
× 40 adversarial steps) the two languages agreed on 11489 of 12000 steps, every
disagreement being 1 ULP in the last bit, largest absolute divergence
**1.09e-13 m**.

## Consequences

- **The contract is now real**: `pytest tests/contract/` → 16 passed / 0 skipped
  (it was skipping).
- **The ego model has one owner.** `egoKernel.ts` is the single definition of
  the ego kinematics, used by the product replay path *and* the mirror. The
  five porting rules in its header are the contract's normative spec; they
  must stay in sync with `sim_core.py`.
- **Turning parameters are covered** (as of 2026-10-21). This
  bullet used to read "Turning parameters are not covered yet": every contract
  vector was a straight-line scenario, so `steer ≡ 0` and the Pure Pursuit
  denominator, the steer clamp and the wheelbase could not affect any
  trajectory — measured: changing Python's `MAX_STEER` or
  `LOOKAHEAD_DISTANCE` left the contract green. The two `steer_*` vectors
  start the ego off its target line, and a mutation of any of the three
  constants now turns the contract red (metre-scale). **The equality
  criterion itself changed with them**: exact equality does not hold for a
  turning trajectory (V8's and CPython's `sin` / `atan2` differ by 1 ULP), so
  turning vectors are compared within a bounded, test-pinned noise floor
  while straight-line vectors keep bit-exact equality. That is
  [ADR-009](ADR-009-contract-equality-and-the-libm-noise-floor.md), which
  narrows D3's scope rather than overturning it.
- **The signal phase is only partially covered.** The observable window is the
  *sampled* one (0…250 for the longest signalled episode, because the
  terminating step 257 is not itself a sample point), so a phase-duration
  drift is caught only when it is ≲ 25.0 s. This bound is asserted by a test,
  not just documented.
- **A golden-file contract has a maintenance duty.** `npm run contract:gen`
  after an unreviewed change ratifies drift silently; `contract:check` is the
  guard, and CI must run it.
- **The two sims remain different systems.** The shadow mirror makes the
  *trajectory* comparable; it does not make the training environment and the
  browser the same world. Closing that gap (a training environment that can
  express lanes and multi-intersection topologies) is a much larger piece of
  work than anything in this ADR.

## Alternatives considered

- **Compare the product sim directly against Python (the original
  design).** Rejected: difference #6 is structural, so the comparison would
  need a tolerance wide enough to hide real drift — i.e. it would compare
  nothing.
- **Keep a tolerance (`±1e-3`, as originally specified).** Rejected: it cannot
  distinguish "one side drifted" from "both sides are fine but the arithmetic
  ordering differs". It would have let the 30→20 s phase-duration change
  through unnoticed.
- **Make the Python training sim a faithful port of the product sim.**
  Rejected for now: it would discard the training environment (free space,
  collision, red-light termination) that existing checkpoints were trained
  against. It remains the right long-term direction — a lane-aware training
  environment — but it is a re-implementation, not a refactor.
- **Derive the goldens from the product sim and compare only the ego
  trajectory.** Rejected: the product's ego position is `lanePoint(road,
  lane, s)`, which is not a function of the ego dynamics, so the comparison
  would be about lane geometry rather than about the model.

## Related

- `docs/contracts/sim-snapshot.md` — the contract as it stands, including the
  measured blind-spot table.
- `docs/adr/ADR-009-contract-equality-and-the-libm-noise-floor.md` — the noise floor narrowing D3.
- `simCoreMirror.ts`, `egoKernel.ts` and `tests/contract/` — the mirror, the kernel and the contract tests.

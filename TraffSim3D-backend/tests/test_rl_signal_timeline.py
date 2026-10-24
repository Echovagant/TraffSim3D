"""The training sim's signal timeline - the reference the browser matches.

**The browser's signal timeline must have the same shape as this one.** A
policy trained here only transfers to the browser if the two sides agree on
*when* an axis may go, and the timing is part of that agreement.

The timeline this module pins is the one the signal agent actually learns
against (``SignalEnv``, which turns ``responsive_traffic`` on - so a phase
change is separated by an inter-green clearance during which neither axis
is green), driven with the ``no_op`` action, i.e. the fixed cycle the
trained policy is compared against:

===== ==================================================================
  ns green 30 s -> 6 s clearance (neither axis green) -> ew green 30 s
  -> 6 s clearance -> ns green ...            (a 72 s period)
===== ==================================================================

The 6 s clearance is ``CLEARANCE_SECS`` - the sum of the clearance-yellow
(3 s) and the all-red (3 s) the browser runs as two separate phases.

**This module is the reference half of the cross-language check.** The
browser half is
``TraffSim3D-frontend/src/application/services/controllers/signalTimeline.spec.ts``,
which pins the same numbers (30 / 6 / 72) on the browser's side; the shared
constants are compared by the contract (``MIN_INTER_GREEN_SECS`` here).
Both sides have to move together, so both sides are pinned.

The windows are measured on the sim's own 10 Hz clock, so a green window
reads 30 s minus one step (29.9 s). The tolerance below covers that.
"""

from __future__ import annotations

from app.apps.rl.signal_env import SignalEnv
from app.apps.rl.sim_core import CLEARANCE_SECS, DT, SIGNAL_ACTION_NAMES

NO_OP = SIGNAL_ACTION_NAMES.index("no_op")

#: The phase the training sim serves each axis for (`cycle_duration`).
EXPECTED_GREEN_SECS = 30.0
#: The inter-green clearance: neither axis is green for this long.
EXPECTED_CLEARANCE_SECS = 6.0
#: 30 + 6 + 30 + 6 - the repeat period of the whole pattern.
EXPECTED_PERIOD_SECS = 72.0
#: The measurement is taken on the sim's 10 Hz clock - one step of slack.
TOLERANCE_SECS = 0.1


def _record(seconds: float) -> list[tuple[bool, bool]]:
    """Record ``(ns_green, ew_green)`` for every step of the fixed cycle."""
    env = SignalEnv(max_steps=int(seconds / DT))
    env.reset(seed=0)
    core = env.core
    rows: list[tuple[bool, bool]] = []
    for _ in range(int(seconds / DT)):
        env.step(NO_OP)
        rows.append((core.light.ns_green, core.light.ew_green))
    return rows


def _windows(rows: list[tuple[bool, bool]], axis: int) -> list[tuple[float, float]]:
    """The green windows of one axis, in seconds.

    A window that is still open when the run ends was cut off by the clock,
    not by the signal - it is not a measurement, so it is left out.
    """
    spans: list[tuple[float, float]] = []
    start: float | None = None
    for index, row in enumerate(rows):
        if row[axis] and start is None:
            start = index * DT
        elif not row[axis] and start is not None:
            spans.append((start, index * DT))
            start = None
    return spans


def _gaps(rows: list[tuple[bool, bool]]) -> list[tuple[float, float]]:
    """The spans during which NEITHER axis is green (open spans excluded)."""
    spans: list[tuple[float, float]] = []
    start: float | None = None
    for index, row in enumerate(rows):
        neither = not row[0] and not row[1]
        if neither and start is None:
            start = index * DT
        elif not neither and start is not None:
            spans.append((start, index * DT))
            start = None
    return spans


def test_each_axis_is_served_for_a_full_phase() -> None:
    """Every green window is a full 30 s phase - never a slice."""
    rows = _record(150.0)
    greens = _windows(rows, 0) + _windows(rows, 1)
    assert len(greens) >= 4
    for start, end in greens:
        assert abs((end - start) - EXPECTED_GREEN_SECS) <= TOLERANCE_SECS, (
            f"a green window lasted {end - start:.2f} s, expected " f"{EXPECTED_GREEN_SECS} s"
        )


def test_the_clearance_between_the_two_greens_is_six_seconds() -> None:
    """The inter-green clearance is ``CLEARANCE_SECS`` - and it is symmetric.

    Symmetric means the clearance comes before **every** green, not only
    before the second axis' one: a timeline with a clearance in front of
    one green only is a different shape, and the browser's used to be.
    """
    rows = _record(150.0)
    gaps = _gaps(rows)
    assert len(gaps) >= 4
    lengths = [end - start for start, end in gaps]
    for length in lengths:
        assert abs(length - EXPECTED_CLEARANCE_SECS) <= TOLERANCE_SECS, (
            f"a clearance lasted {length:.2f} s, expected " f"{EXPECTED_CLEARANCE_SECS} s"
        )
    # Every clearance is the same length - the shape is symmetric.
    assert len({round(length, 2) for length in lengths}) == 1


def test_the_clearance_is_the_constant_the_contract_compares() -> None:
    """The clearance is a named constant, not a literal in the test."""
    assert CLEARANCE_SECS == EXPECTED_CLEARANCE_SECS


def test_the_pattern_repeats_every_72_seconds() -> None:
    """The repeat period is 72 s: 30 green + 6 clearance + 30 green + 6."""
    rows = _record(150.0)
    ns_starts = [start for start, _ in _windows(rows, 0)]
    assert len(ns_starts) >= 2
    for previous, current in zip(ns_starts, ns_starts[1:], strict=False):
        period = current - previous
        assert abs(period - EXPECTED_PERIOD_SECS) <= TOLERANCE_SECS, (
            f"the pattern repeated every {period:.2f} s, expected " f"{EXPECTED_PERIOD_SECS} s"
        )

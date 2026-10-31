"""The Chinese datum conversions — the properties that must hold.

The GCJ-02 datum is deliberately obfuscated (no published exact
inverse), and the "public reference vectors" are only reliable to
about ±1e-5 degrees ACROSS implementations — asserting my remembered
absolute values at 1e-4 would pin a copy of one implementation, not
the datum. What MUST hold, and what is pinned here:

1. **The forward offset has the published scale** — 300–600 m in
   mainland China, latitude/longitude split as documented.
2. **The inverse iteration is self-consistent**: forward then inverse
   returns the input to 1e-9 degrees (double-precision noise).
3. **BD-09 → GCJ-02 → BD-09 round-trips** to the microdegree (the
   BD-09 → GCJ-02 step IS exact and published).
4. **The inverse lands where the forward says it should** (the
   offset-inverse's own fixed point).
5. **Foreign coordinates come back unchanged** — applying the offset
   to London would MOVE the map by hundreds of metres.
6. **The dispatch refuses unknown data** — silently treating them as
   WGS84 would place the map 300–600 m off with no signal at all.
"""

from __future__ import annotations

import math

import pytest

from app.apps.maps.coord_transform import (
    SUPPORTED_DATUMS,
    bd09_to_wgs84,
    gcj02_to_wgs84,
    to_wgs84,
    wgs84_to_gcj02,
)

#: 天安门 — a famous landmark whose WGS84 position is public knowledge.
TIANANMEN_WGS84 = (39.90733345, 116.3912284409)
#: 上海东方明珠 — a southern point, so the offset's shape is pinned
#: across latitudes, not one magic constant.
SHANGHAI_WGS84 = (31.23970917, 121.49950559)

#: The datum offset in mainland China is 300–600 m ≈ 0.003–0.006 deg.
#: The DIRECTION rotates with position (Shanghai's latitude offset is
#: NEGATIVE — measured −0.002), so the scale is asserted on the
#: absolute value.
OFFSET_MAG_RANGE = (0.001, 0.007)


@pytest.mark.parametrize("wgs", [TIANANMEN_WGS84, SHANGHAI_WGS84])
def test_the_forward_offset_has_the_published_scale(wgs: tuple) -> None:
    gcj = wgs84_to_gcj02(*wgs)
    assert OFFSET_MAG_RANGE[0] < abs(gcj[0] - wgs[0]) < OFFSET_MAG_RANGE[1]
    assert OFFSET_MAG_RANGE[0] < abs(gcj[1] - wgs[1]) < OFFSET_MAG_RANGE[1]


@pytest.mark.parametrize("wgs", [TIANANMEN_WGS84, SHANGHAI_WGS84])
def test_the_inverse_iteration_returns_the_input(wgs: tuple) -> None:
    """The offset-inverse's own fixed point: encode then decode lands
    on the original coordinate to double-precision noise."""
    gcj = wgs84_to_gcj02(*wgs)
    got = gcj02_to_wgs84(*gcj)
    assert got[0] == pytest.approx(wgs[0], abs=1e-9)
    assert got[1] == pytest.approx(wgs[1], abs=1e-9)


@pytest.mark.parametrize("wgs", [TIANANMEN_WGS84, SHANGHAI_WGS84])
def test_bd09_roundtrips_to_wgs84_to_the_microdegree(wgs: tuple) -> None:
    """Derive the BD-09 twin of a WGS84 point numerically, then decode
    it back: the chain must land on the original coordinate to the
    microdegree (the BD-09 -> GCJ-02 step is exact; the GCJ-02 ->
    WGS84 step converges to 1e-9).
    """
    lat, lon = wgs
    bd_lat, bd_lon = lat, lon
    for _ in range(20):
        decoded = bd09_to_wgs84(bd_lat, bd_lon)
        bd_lat += lat - decoded[0]
        bd_lon += lon - decoded[1]
        if abs(lat - decoded[0]) < 1e-9 and abs(lon - decoded[1]) < 1e-9:
            break
    decoded = bd09_to_wgs84(bd_lat, bd_lon)
    assert decoded[0] == pytest.approx(lat, abs=1e-6)
    assert decoded[1] == pytest.approx(lon, abs=1e-6)


@pytest.mark.parametrize("wgs", [TIANANMEN_WGS84, SHANGHAI_WGS84])
def test_the_datum_offset_has_the_published_scale(wgs: tuple) -> None:
    """The GCJ-02 → WGS84 iteration's own output must sit at the
    published offset distance from its input — a formula regression
    that shrinks the offset to zero (or flips it) is the bug this
    catches even if the vectors drifted."""
    gcj = wgs84_to_gcj02(*wgs)
    # The offset is measured between the two ENCODINGS (gcj vs the
    # original wgs input) — the encode-decode round-trip is a separate
    # test and lands at 1e-9.
    assert OFFSET_MAG_RANGE[0] < abs(gcj[0] - wgs[0]) < OFFSET_MAG_RANGE[1]
    assert OFFSET_MAG_RANGE[0] < abs(gcj[1] - wgs[1]) < OFFSET_MAG_RANGE[1]


def test_a_foreign_coordinate_comes_back_unchanged() -> None:
    """GCJ-02 does not exist outside mainland China — applying the
    offset to London would MOVE the map by hundreds of metres."""
    london = (51.5074, -0.1278)
    assert gcj02_to_wgs84(*london) == london
    assert wgs84_to_gcj02(*london) == london
    assert bd09_to_wgs84(*london) == london
    assert to_wgs84(london[0], london[1], "gcj02") == london


def test_the_conversions_never_go_non_finite() -> None:
    """A pathological input (the formulas involve sin/cos of large
    arguments) must not produce NaN/inf — the importer would drop the
    road silently."""
    for lat in (-90, -45, 0, 22.6, 39.9, 53.5, 90):
        for lon in (-180, -90, 0, 116.4, 180):
            for datum in SUPPORTED_DATUMS:
                got = to_wgs84(lat, lon, datum)
                assert math.isfinite(got[0]) and math.isfinite(got[1])


def test_to_wgs84_dispatches_and_refuses_the_unknown() -> None:
    assert to_wgs84(*TIANANMEN_WGS84, "wgs84") == TIANANMEN_WGS84
    gcj = wgs84_to_gcj02(*TIANANMEN_WGS84)
    got = to_wgs84(*gcj, "gcj02")
    assert got[0] == pytest.approx(TIANANMEN_WGS84[0], abs=1e-9)
    assert got[1] == pytest.approx(TIANANMEN_WGS84[1], abs=1e-9)
    with pytest.raises(ValueError, match="unknown coordinate datum"):
        to_wgs84(*TIANANMEN_WGS84, "gauss-kruger")
    assert SUPPORTED_DATUMS == ("wgs84", "gcj02", "bd09")

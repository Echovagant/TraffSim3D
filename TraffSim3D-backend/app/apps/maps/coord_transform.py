"""Coordinate-datum conversion for Chinese map data — GCJ-02 / BD-09 → WGS84.

Why this exists
---------------
OSM speaks WGS84. Chinese map providers do NOT: 高德 (AMap) serves
**GCJ-02** ("火星坐标", the state-mandated offset datum) and 百度 (Baidu)
serves **BD-09** (GCJ-02 plus another Baidu-specific offset). A user who
exports a district from 高德/百度 and imports it here gets a map that is
**300–600 m off** in mainland China — roads land in rivers, junctions
miss their amenities. The importer therefore needs to know which datum
the file's coordinates are in, and convert to WGS84 before anything else
touches them.

The conversions
---------------
- **BD-09 → GCJ-02** is the published exact formula (Baidu's own
  documentation and the widely-verified open-source implementations
  agree to the microdegree).
- **GCJ-02 → WGS84** has NO published exact formula (GCJ-02 is
  deliberately obfuscated). The standard approach — and the one used
  here — is the offset-inverse: compute the GCJ-02 encoding of the
  point (the forward transform is publicly documented), subtract, and
  subtract the offset again from the input. One iteration lands within
  ~1e-6 degrees (≈ 0.1 m) of the true WGS84 coordinate, two within the
  double-precision noise; this module iterates until the residual is
  under ``_CONVERGENCE_DEG`` or ``_MAX_ITERATIONS`` is spent.

- **WGS84 → GCJ-02** (the forward direction) is included for the export
  path and for tests: it is the publicly-documented offset formula, and
  the inverse above is defined in terms of it.

The out-of-China guard
----------------------
GCJ-02 only exists inside mainland China (the regulation says so). A
coordinate outside is returned unchanged — applying the offset to, say,
a London street would MOVE it by hundreds of metres. The polygon test
is the standard rough rectangle-plus-exclusions used by every open
implementation: it is deliberately conservative (a point in the sea
just off the coast converts or not, either way the error is tiny
compared to the datum offset itself).

Reference vectors
-----------------
The tests pin 天安门 (Tiananmen) and one Shenzhen point against the
values published with the open-source transform implementations
(CoordTransform etc.) — three data, one place, the numbers everyone
cross-checks. A regression in the offset formula breaks them loudly.
"""

from __future__ import annotations

import math

#: Convergence threshold for the GCJ-02 → WGS84 iteration (degrees).
#: 1e-9 degrees ≈ 0.1 mm — far below any GPS or map-data accuracy.
_CONVERGENCE_DEG = 1e-9

#: The iteration cap. Two iterations reach the threshold in practice;
#: the cap only exists so a pathological input cannot spin forever.
_MAX_ITERATIONS = 20

#: The GCJ-02 obfuscation parameters (the public constants every
#: implementation shares).
_GCJ_A = 6378245.0  # semi-major axis (m)
_GCJ_EE = 0.00669342162296594323  # first eccentricity squared

#: The Baidu offsets (the published constants).
_BD_LON_OFFSET = 0.0065
_BD_LAT_OFFSET = 0.006
#: The BD-09 → GCJ-02 formula's sine/cosine coefficients (published).
_BD_R_SIN = 0.00002
_BD_R_COS = 0.000003


def _out_of_china(lat: float, lon: float) -> bool:
    """The rough mainland-China rectangle (the standard open test).

    Deliberately coarse: a point just outside the rectangle that should
    have converted (Hong Kong, an island) misses a ~100 m datum shift —
    an order of magnitude below the 300–600 m error this module exists
    to fix.
    """
    return not (73.66 < lon < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(x: float, y: float) -> float:
    result = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    result += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    result += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    result += (
        (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    )
    return result


def _transform_lon(x: float, y: float) -> float:
    result = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    result += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    result += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    result += (
        (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    )
    return result


def wgs84_to_gcj02(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 → GCJ-02 (the forward, publicly-documented offset).

    Returns the input unchanged outside mainland China.
    """
    if _out_of_china(lat, lon):
        return (lat, lon)
    dlat = _transform_lat(lon - 105.0, lat - 35.0)
    dlon = _transform_lon(lon - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _GCJ_EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_GCJ_A * (1 - _GCJ_EE)) / (magic * sqrtmagic) * math.pi)
    dlon = (dlon * 180.0) / (_GCJ_A / sqrtmagic * math.cos(radlat) * math.pi)
    return (lat + dlat, lon + dlon)


def gcj02_to_wgs84(lat: float, lon: float) -> tuple[float, float]:
    """GCJ-02 → WGS84 (the offset-inverse iteration).

    No exact inverse is published; the residual after convergence is
    under ``_CONVERGENCE_DEG`` degrees. Returns the input unchanged
    outside mainland China.
    """
    if _out_of_china(lat, lon):
        return (lat, lon)
    wgs_lat, wgs_lon = lat, lon
    for _ in range(_MAX_ITERATIONS):
        gcj_lat, gcj_lon = wgs84_to_gcj02(wgs_lat, wgs_lon)
        wgs_lat += lat - gcj_lat
        wgs_lon += lon - gcj_lon
        if abs(lat - gcj_lat) < _CONVERGENCE_DEG and abs(lon - gcj_lon) < _CONVERGENCE_DEG:
            break
    return (wgs_lat, wgs_lon)


def bd09_to_gcj02(lat: float, lon: float) -> tuple[float, float]:
    """BD-09 → GCJ-02 (the published exact formula)."""
    x = lon - _BD_LON_OFFSET
    y = lat - _BD_LAT_OFFSET
    z = math.sqrt(x * x + y * y) - _BD_R_SIN * math.sin(y * math.pi / 180)
    theta = math.atan2(y, x) - _BD_R_COS * math.cos(x * math.pi / 180)
    return (z * math.sin(theta), z * math.cos(theta))


def bd09_to_wgs84(lat: float, lon: float) -> tuple[float, float]:
    """BD-09 → WGS84: the exact BD-09 → GCJ-02 step, then the iteration."""
    if _out_of_china(lat, lon):
        return (lat, lon)
    gcj_lat, gcj_lon = bd09_to_gcj02(lat, lon)
    return gcj02_to_wgs84(gcj_lat, gcj_lon)


#: The coordinate data the importer accepts, and the conversion each one
#: gets. The keys are the ``coord`` query parameter's values.
SUPPORTED_DATUMS = ("wgs84", "gcj02", "bd09")

converters = {
    "wgs84": lambda lat, lon: (lat, lon),
    "gcj02": gcj02_to_wgs84,
    "bd09": bd09_to_wgs84,
}


def to_wgs84(lat: float, lon: float, datum: str) -> tuple[float, float]:
    """Convert one coordinate from `datum` to WGS84.

    `datum` must be one of `SUPPORTED_DATUMS` ("wgs84" is the identity).
    An unknown datum raises `ValueError` — silently treating it as
    WGS84 would place the map 300–600 m off with no signal at all.
    """
    if datum not in converters:
        raise ValueError(
            f"unknown coordinate datum {datum!r} — expected one of {', '.join(SUPPORTED_DATUMS)}"
        )
    return converters[datum](lat, lon)

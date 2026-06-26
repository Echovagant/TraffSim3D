"""Plan 041 + 046: OSM parser HTTP endpoints (XML + PBF)."""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.apps.maps.osm_parser import parse_osm_xml, parse_osmpbf

router = APIRouter()


@router.post("/maps/parse-osm", tags=["maps"])
async def parse_osm(file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008 (FastAPI requires File in default)
    """Parse an uploaded .osm file into a RoadNetwork dict."""
    raw = await file.read()
    try:
        return parse_osm_xml(raw)
    except ET.ParseError as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid OSM XML: {e}"
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"OSM parse failed: {e}"
        ) from e


@router.post("/maps/parse-pbf", tags=["maps"])
async def parse_pbf(file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008
    """Parse an uploaded .osm.pbf file into a RoadNetwork dict.

    Same return shape as /maps/parse-osm. Uses libosmium (osmium Python
    bindings) to stream the binary PBF. Real-world city files (Shenzhen
    ~20MB, Guangdong ~200MB) use this format.
    """
    raw = await file.read()
    try:
        return parse_osmpbf(raw)
    except ValueError as e:
        # parse_osmpbf wraps libosmium errors as ValueError.
        raise HTTPException(
            status_code=400, detail=f"Invalid OSM PBF: {e}"
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"PBF parse failed: {e}"
        ) from e
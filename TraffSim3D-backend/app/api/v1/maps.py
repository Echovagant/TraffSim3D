"""Plan 041: OSM parser HTTP endpoint."""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.apps.maps.osm_parser import parse_osm_xml

router = APIRouter()


@router.post("/maps/parse-osm", tags=["maps"])
async def parse_osm(file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008 (FastAPI requires File in default)
    """Parse an uploaded .osm file into a RoadNetwork dict.

    Returns a SerializedScene-shaped dict (schemaVersion 6) ready for
    the frontend `world.loadNetwork(network)` call.
    """
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
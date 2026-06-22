"""Versioned API surface."""
from fastapi import APIRouter

from app.api.v1 import ping

api_v1 = APIRouter()
api_v1.include_router(ping.router, prefix="", tags=["meta"])

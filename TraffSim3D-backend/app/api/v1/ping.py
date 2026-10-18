"""Smoke-test endpoint for end-to-end frontend/backend wiring checks."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/ping")
def ping() -> dict[str, bool]:
    return {"pong": True}

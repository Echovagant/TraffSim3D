"""Plan 050: cross-language contract test (Python sim ↔ TS sim).

Generates a Python-side state trajectory by running `sim_core.SimCore`
with a fixed action sequence (from `test_vector.json`). The result is
written to `snapshots/python_<name>.json` so the TS-side snapshot
(from Playwright e2e) can be compared.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from app.apps.rl.sim_core import SimCore

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"
SNAPSHOTS_DIR = CONTRACT_DIR / "snapshots"


def _drive(core: SimCore, ego_id: str, actions: list[list[float]], sample_every: int) -> list[dict]:
    """Run `SimCore` for the action sequence, sampling ego state every
    `sample_every` steps. Returns a list of {step, x, y, z, heading, speed}.
    """
    samples: list[dict] = []
    samples.append(_snapshot(0, ego_id, core))
    for i, action in enumerate(actions, start=1):
        core.step(np.asarray(action, dtype=np.float32))
        if i % sample_every == 0 or i == len(actions):
            samples.append(_snapshot(i, ego_id, core))
    return samples


def _snapshot(step: int, ego_id: str, core: SimCore) -> dict:
    return {
        "step": step,
        "ego_id": ego_id,
        "x": float(core.ego.x),
        "z": float(core.ego.z),
        "heading": float(core.ego.heading),
        "speed": float(core.ego.speed),
    }


def test_python_snapshots_match_test_vector() -> None:
    """Generate Python-side snapshots from test_vector.json. Runs every
    CI to refresh snapshots on demand; consumers (the consistency test)
    load the JSON files directly.
    """
    vec = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    tolerance = vec["tolerance"]
    sample_every = vec.get("sample_every", 5)
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    for v in vec["vectors"]:
        core = SimCore(scene_kind=v["scene_kind"])
        core.reset()
        samples = _drive(core, v["ego_id"], v["actions"], sample_every)
        out_path = SNAPSHOTS_DIR / f"python_{v['name']}.json"
        out_path.write_text(
            json.dumps({
                "name": v["name"],
                "scene_kind": v["scene_kind"],
                "ego_id": v["ego_id"],
                "tolerance": tolerance,
                "samples": samples,
            }, indent=2),
            encoding="utf-8",
        )
        # Sanity: at least one sample was captured
        assert len(samples) >= 1
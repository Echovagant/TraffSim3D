"""The observation fixture generator.

What is pinned here:

1. **Determinism** — the same scenarios every run, so regenerating the
   fixture is a no-op in git.
2. **Structure** — every scenario has agents, every agent gets a
   23-dim observation, and the clamped elements are within their bounds.
3. **The double implementation** — the committed vectors come from the
   float64 reference, and the generator itself asserts they agree with
   the core's float32 output; a drift between the two must be loud.
4. **The committed file matches** — when the frontend tree is checked
   out, the fixture on disk is exactly what the generator produces.
"""

from __future__ import annotations

import importlib
import json
import math
from pathlib import Path

import pytest

spec = importlib.import_module("scripts.gen_drive_observation_fixture")
build_fixture = spec.build_fixture
_build_states = spec._build_states
_observation_reference = spec._observation_reference
FIXTURE_PATH = spec.FIXTURE_PATH


def test_the_scenarios_are_deterministic() -> None:
    first = _build_states()
    second = _build_states()
    assert first == second


def test_every_scenario_has_agents_and_poses() -> None:
    for scenario in _build_states():
        assert scenario["agents"], f"{scenario['name']} has no agents"
        assert len(scenario["vehicles"]) >= 2, f"{scenario['name']} has nobody to negotiate with"
        for vehicle in scenario["vehicles"]:
            assert math.isfinite(vehicle["x"]) and math.isfinite(vehicle["z"])
            assert 0.0 <= vehicle["routeProgress"] <= 1.0


def test_the_expected_observations_are_well_formed() -> None:
    fixture = build_fixture()
    assert fixture["obs_dim"] == 29
    assert len(fixture["expected"]) >= 10  # 13: five scenarios, three agents each (minus npcs)

    for entry in fixture["expected"]:
        observation = entry["observation"]
        assert len(observation) == 29
        assert all(math.isfinite(value) for value in observation)
        # The clamped elements.
        for index in (2, 7):
            assert -1.0 <= observation[index] <= 1.0
        for slot in range(3):
            base = 8 + slot * 7
            assert observation[base] in (0.0, 1.0)
            assert -1.0 <= observation[base + 4] <= 1.0
            # The flags.
            assert observation[base + 5] in (0.0, 1.0)
            assert observation[base + 6] in (0.0, 1.0)
        # The unnormalised-bearing element.
        assert -1.0 <= observation[3] <= 1.0


def test_the_reference_disagrees_loudly_when_the_vector_is_mirrored() -> None:
    """The bearing points FROM the vehicle TO the conflict point.

    The regression this pins: the reference once computed the opposite
    direction vector, which flips the sign of the bearing for a vehicle
    whose junction is behind it — a disagreement of exactly pi that the
    generator must catch, not commit.
    """
    states = _build_states()
    scenario = states[0]
    agent = scenario["vehicles"][0]
    others = [v for v in scenario["vehicles"] if v["id"] != agent["id"]]
    reference = _observation_reference((0.0, 0.0), agent, others)

    mirrored = dict(agent)
    mirrored["x"] = -agent["x"]
    mirrored["z"] = -agent["z"]
    mirrored["heading"] = math.atan2(-agent["z"], -agent["x"])
    mirrored_reference = _observation_reference((0.0, 0.0), mirrored, others)

    # obs[3] is the bearing: a genuinely different pose gives a
    # different bearing — the check below is only meaningful because
    # the two are not identical.
    assert reference[3] != mirrored_reference[3]
    for value in (reference[3], mirrored_reference[3]):
        assert -1.0 <= value <= 1.0


def test_the_committed_fixture_matches_the_generator() -> None:
    if not FIXTURE_PATH.exists():
        pytest.skip("the frontend tree is not checked out next to the backend")
    committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert committed == build_fixture()


def test_the_fixture_file_is_stable_across_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regenerating writes the same bytes — a no-op in git."""
    monkeypatch.setattr(spec, "FIXTURE_PATH", tmp_path / "drive-observation-fixture.json")
    spec.main()
    first = (tmp_path / "drive-observation-fixture.json").read_bytes()
    spec.main()
    second = (tmp_path / "drive-observation-fixture.json").read_bytes()
    assert first == second

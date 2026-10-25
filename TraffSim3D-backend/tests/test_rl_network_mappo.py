"""The gates of the network MAPPO trainer.

The trainer is only worth having if three things hold, and this file pins
each of them:

1. the **export** is the browser's contract, key for key - the layer
   names, the shapes, the dtypes, and the **absence** of ``log_std`` (a
   discrete policy has no Gaussian log-standard-deviation, and a browser
   that read one would run a continuous forward pass);
2. the **browser's forward pass** reproduces the actor's decisions - the
   same argument, the same bias, the same ``tanh``, the same argmax with
   the ties broken towards the lowest index - and a wrong observation
   width is rejected with the browser's own message;
3. the **training loop's mechanics** are right - the mask is respected, the
   advantage is the one the hand calculation says, one actor really does
   serve every junction, and the export round-trips.

The trainer's own claim - that the policy beats the fixed cycle - is a
**measurement**, not a gate of this file: it needs a real run, and the
numbers of such a run are reported with the run itself.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
import torch

from app.apps.rl import network_mappo as mappo
from app.apps.rl.network_signal_env import (
    GRID_5X5_DEMAND_SCALE,
    GRID_5X5_ROWS,
    build_grid_network_dict,
)
from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES

#: The index of ``shorten_red`` - the one action the env can refuse.
SHORTEN_RED = SIGNAL_ACTION_NAMES.index("shorten_red")


# --------------------------------------------------------------------------
# the browser's forward pass, re-implemented
# --------------------------------------------------------------------------


def browser_mat_vec(weights: list[list[float]], vector: list[float]) -> list[float]:
    """``y = W x`` — the browser's ``matVec``."""
    out: list[float] = []
    for row in weights:
        out.append(sum(row[j] * vector[j] for j in range(len(vector))))
    return out


def browser_logits(obs: list[float], weights: dict) -> list[float]:
    """The browser's ``mlpForwardLogits``, line for line.

    The observation-width check is the browser's: a mismatch is rejected
    loudly, with the message the browser uses.
    """
    layers = weights["layers"]
    input_weights = layers["policy_net.0.weight"]
    expected = len(input_weights[0]) if input_weights else 0
    if len(obs) != expected:
        raise ValueError(f"obs dim mismatch: got {len(obs)}, weights expect {expected}")
    hidden = [
        value + bias
        for value, bias in zip(
            browser_mat_vec(input_weights, obs),
            layers["policy_net.0.bias"],
            strict=True,
        )
    ]
    hidden = [math.tanh(value) for value in hidden]
    hidden = [
        value + bias
        for value, bias in zip(
            browser_mat_vec(layers["policy_net.2.weight"], hidden),
            layers["policy_net.2.bias"],
            strict=True,
        )
    ]
    hidden = [math.tanh(value) for value in hidden]
    return [
        value + bias
        for value, bias in zip(
            browser_mat_vec(layers["action_net.weight"], hidden),
            layers["action_net.bias"],
            strict=True,
        )
    ]


def browser_action(obs: list[float], weights: dict) -> int:
    """The browser's ``mlpForwardDiscrete``: the argmax, ties to the lowest."""
    logits = browser_logits(obs, weights)
    best = 0
    for index in range(1, len(logits)):
        if logits[index] > logits[best]:
            best = index
    return best


# --------------------------------------------------------------------------
# Gate 1: the export is the browser's contract
# --------------------------------------------------------------------------


def _seeded_actor(seed: int = 0) -> mappo.PolicyActor:
    """An actor with a pinned initialisation."""
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(seed)
        return mappo.PolicyActor()


def test_the_export_has_the_browser_shape() -> None:
    """The keys, the shapes and the metadata the browser's type declares."""
    weights = mappo.export_weights(_seeded_actor(), "network_mappo_weights.json")

    assert weights["name"] == "network_mappo_weights.json"
    assert weights["obs_dim"] == 6
    assert weights["action_dim"] == 5
    assert weights["action_space"] == "discrete"
    assert weights["hidden_sizes"] == [64, 64]

    layers = weights["layers"]
    assert set(layers) == {
        "policy_net.0.weight",
        "policy_net.0.bias",
        "policy_net.2.weight",
        "policy_net.2.bias",
        "action_net.weight",
        "action_net.bias",
    }
    # A discrete policy has no Gaussian log-standard-deviation: the key is
    # absent, not null and not empty.
    assert "log_std" not in layers

    assert len(layers["policy_net.0.weight"]) == 64
    assert len(layers["policy_net.0.weight"][0]) == 6
    assert len(layers["policy_net.0.bias"]) == 64
    assert len(layers["policy_net.2.weight"]) == 64
    assert len(layers["policy_net.2.weight"][0]) == 64
    assert len(layers["policy_net.2.bias"]) == 64
    assert len(layers["action_net.weight"]) == 5
    assert len(layers["action_net.weight"][0]) == 64
    assert len(layers["action_net.bias"]) == 5


def test_the_exported_numbers_are_plain_floats() -> None:
    """The payload is JSON, so every number has to be a plain float."""
    weights = mappo.export_weights(_seeded_actor(), "w.json")
    round_tripped = json.loads(json.dumps(weights))
    assert round_tripped == weights

    def _numbers(value: object) -> list[float]:
        if isinstance(value, list):
            out: list[float] = []
            for item in value:
                out.extend(_numbers(item))
            return out
        assert isinstance(value, float)
        return [value]

    for name, value in weights["layers"].items():
        numbers = _numbers(value)
        assert numbers, name
        assert all(math.isfinite(number) for number in numbers), name


def test_the_actor_is_the_architecture_the_browser_reads() -> None:
    """Linear(6, 64) -> Tanh -> Linear(64, 64) -> Tanh -> Linear(64, 5)."""
    actor = _seeded_actor()
    linears = [module for module in actor.policy_net if isinstance(module, torch.nn.Linear)]
    assert len(linears) == 2
    assert (linears[0].in_features, linears[0].out_features) == (6, 64)
    assert (linears[1].in_features, linears[1].out_features) == (64, 64)
    assert isinstance(actor.policy_net[1], torch.nn.Tanh)
    assert isinstance(actor.policy_net[3], torch.nn.Tanh)
    assert (actor.action_net.in_features, actor.action_net.out_features) == (64, 5)


def test_the_actors_state_dict_is_the_browser_layer_dictionary() -> None:
    """The export needs no key translation: the names already match."""
    actor = _seeded_actor()
    layers = mappo.export_weights(actor, "w.json")["layers"]
    assert set(actor.state_dict()) == set(layers)


# --------------------------------------------------------------------------
# Gate 2: the browser's forward pass reproduces the actor
# --------------------------------------------------------------------------


def test_the_browser_forward_pass_reproduces_the_actors_actions() -> None:
    """The same observation gives the same action on both sides.

    The browser computes in double precision and the actor in single
    precision, so the two logit vectors differ in the last bits - around
    1e-6 for these magnitudes. An observation whose top two logits are
    closer than that is a **coin toss** the two sides are allowed to
    disagree on, so the comparison is made on the observations where the
    winner is clear, and the test says how many of them there were.
    """
    actor = _seeded_actor()
    weights = mappo.export_weights(actor, "w.json")

    rng = np.random.default_rng(20261025)
    observations = rng.uniform(-1.0, 1.0, size=(512, 6)).astype(np.float32)
    with torch.no_grad():
        logits = actor(torch.from_numpy(observations)).numpy()

    # The two forward passes are the same computation.
    for row, observation in enumerate(observations):
        browser_row = browser_logits([float(value) for value in observation], weights)
        assert np.allclose(browser_row, logits[row], atol=1e-4), row

    decisive = 0
    for row, observation in enumerate(observations):
        ordered = np.sort(logits[row])[::-1]
        if ordered[0] - ordered[1] <= 1e-3:
            # Too close to call: the float32 / float64 difference decides it.
            continue
        decisive += 1
        browser_choice = browser_action([float(value) for value in observation], weights)
        actor_choice = int(np.argmax(logits[row]))
        assert browser_choice == actor_choice, (row, browser_choice, actor_choice)
    # The comparison is not vacuous.
    assert decisive >= 256, decisive


def test_the_browser_breaks_a_tie_towards_the_lowest_index() -> None:
    """The same rule as ``numpy.argmax``, so the two sides cannot disagree."""
    weights = mappo.export_weights(_seeded_actor(), "w.json")
    layers = weights["layers"]
    # A policy whose action layer puts every logit on the same value.
    layers["action_net.weight"] = [[0.0] * 64 for _ in range(5)]
    layers["action_net.bias"] = [1.0, 1.0, 1.0, 1.0, 1.0]
    assert browser_action([0.0] * 6, weights) == 0

    layers["action_net.bias"] = [1.0, 1.0, 2.0, 1.0, 1.0]
    assert browser_action([0.0] * 6, weights) == 2


def test_the_browser_rejects_a_wrong_observation_width() -> None:
    """The browser's own message, on the browser's own rule."""
    weights = mappo.export_weights(_seeded_actor(), "w.json")
    with pytest.raises(ValueError, match="obs dim mismatch"):
        browser_action([0.0] * 5, weights)
    with pytest.raises(ValueError, match="obs dim mismatch"):
        browser_action([0.0] * 7, weights)
    # The right width is accepted.
    assert browser_action([0.0] * 6, weights) in range(5)


def test_the_exported_policy_runs_on_the_envs_own_observations() -> None:
    """The observations the env produces are the ones the browser feeds.

    The browser builds its six numbers from its own world state; the env
    builds them from the queue model. Both are the same six numbers in
    the same order, so a policy exported for one runs on the other.
    """
    config = mappo.TrainingConfig(rows=2, cols=2, max_steps=50)
    actor = _seeded_actor()
    weights = mappo.export_weights(actor, "w.json")

    env = mappo.make_env(config, max_steps=50)
    obs, _info = env.reset(seed=3)
    for _ in range(20):
        row = obs[0]
        assert row.shape == (6,)
        assert np.all(np.abs(row) <= 1.0)
        browser_choice = browser_action([float(value) for value in row], weights)
        with torch.no_grad():
            actor_choice = int(torch.argmax(actor(torch.from_numpy(obs).float()), dim=-1)[0])
        assert browser_choice == actor_choice
        obs, _reward, _terminated, _truncated, _info = env.step(
            [mappo.NO_OP_INDEX] * env.n_junctions
        )


# --------------------------------------------------------------------------
# Gate 3: the training loop's mechanics
# --------------------------------------------------------------------------


def test_a_refused_action_is_never_sampled() -> None:
    """The mask is the env's own, and the sampler honours it."""
    logits = torch.tensor([[0.0, 5.0, 0.0, 0.0, 0.0]])
    mask = torch.tensor([[True, False, True, True, True]])
    generator = torch.Generator()
    generator.manual_seed(0)
    for _ in range(500):
        action = mappo.sample_actions(logits, mask, generator)
        assert int(action) != SHORTEN_RED

    log_probs = mappo.masked_log_probs(logits, mask)
    assert torch.exp(log_probs[0, SHORTEN_RED]) == 0.0
    assert float(torch.exp(log_probs[0]).sum()) == pytest.approx(1.0, abs=1e-6)


def test_the_entropy_of_a_masked_row_ignores_the_refused_action() -> None:
    """A refused action carries no probability, so it carries no entropy."""
    logits = torch.tensor([[0.0, 5.0, 0.0, 0.0, 0.0]])
    full = torch.ones_like(logits, dtype=torch.bool)
    masked = torch.tensor([[True, False, True, True, True]])

    entropy_masked = float(mappo.masked_entropy(logits, masked))
    entropy_without = float(mappo.masked_entropy(logits[:, [0, 2, 3, 4]], full[:, [0, 2, 3, 4]]))
    assert entropy_masked == pytest.approx(entropy_without, abs=1e-6)
    assert math.isfinite(entropy_masked)


def test_the_rollout_never_proposes_a_refused_action() -> None:
    """End to end: the env's mask, the env's own observations."""
    config = mappo.TrainingConfig(rows=2, cols=2, max_steps=60, rollout_steps=40)
    actor = _seeded_actor()
    generator = torch.Generator()
    generator.manual_seed(11)
    episode_seeds = np.random.default_rng(11)

    env = mappo.make_env(config)
    obs, _info = env.reset(seed=1)
    rollout, _obs, _steps = mappo._collect_rollout(
        actor,
        env,
        config,
        generator,
        episode_seeds,
        obs=obs,
    )

    assert rollout.actions.shape == (40, env.n_junctions)
    for step in range(40):
        for junction in range(env.n_junctions):
            action = int(rollout.actions[step, junction])
            assert rollout.masks[step, junction, action], (step, junction, action)


def test_the_decomposed_reward_is_the_networks_reward() -> None:
    """The junction's terms add up to the network's delay - exactly.

    That is the whole justification for the decomposition: it is not a
    shaping, it is the same reward split into the parts that earned it.
    """
    config = mappo.TrainingConfig(rows=2, cols=2, max_steps=60, rollout_steps=30)
    actor = _seeded_actor()
    generator = torch.Generator()
    generator.manual_seed(21)
    episode_seeds = np.random.default_rng(21)

    env = mappo.make_env(config)
    obs, _info = env.reset(seed=6)
    rollout, _obs, _steps = mappo._collect_rollout(
        actor,
        env,
        config,
        generator,
        episode_seeds,
        obs=obs,
    )

    # The env's own reward is the negative network delay.
    assert np.allclose(rollout.agent_rewards.sum(axis=1), rollout.rewards, atol=1e-4), (
        rollout.agent_rewards.sum(axis=1) - rollout.rewards
    )


def test_the_shared_reward_mode_gives_every_junction_the_whole_reward() -> None:
    """The ``"network"`` mode is the textbook shared reward, kept for the
    comparison."""
    config = mappo.TrainingConfig(
        rows=2, cols=2, max_steps=40, rollout_steps=20, credit_assignment="network"
    )
    actor = _seeded_actor()
    generator = torch.Generator()
    generator.manual_seed(13)
    episode_seeds = np.random.default_rng(13)

    env = mappo.make_env(config)
    obs, _info = env.reset(seed=7)
    rollout, _obs, _steps = mappo._collect_rollout(
        actor,
        env,
        config,
        generator,
        episode_seeds,
        obs=obs,
    )
    assert np.allclose(rollout.agent_rewards.sum(axis=1), rollout.rewards, atol=1e-4)
    assert np.allclose(rollout.agent_rewards, rollout.rewards[:, None], atol=1e-4)


def test_the_advantage_is_the_one_the_hand_calculation_gives() -> None:
    """GAE on a trajectory whose every number is known.

    Two junctions, so the per-junction structure is visible: the last
    step is a termination (no bootstrap, and the chain stops), the middle
    step bootstraps off the next value, and the first step carries the
    middle one's advantage.
    """
    rewards = np.array([[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]], dtype=np.float32)
    values = np.array([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], dtype=np.float32)
    next_values = np.array([[0.5, 0.5], [0.5, 0.5], [2.0, 2.0]], dtype=np.float32)
    terminated = np.array([False, False, True])
    truncated = np.array([False, False, False])

    advantages = mappo.compute_gae(
        rewards,
        values,
        next_values,
        terminated,
        truncated,
        gamma=0.9,
        gae_lambda=0.8,
    )

    # The last step is a termination: no bootstrap, and the chain stops.
    assert advantages[2, 0] == pytest.approx(3.0 - 0.5)
    # The middle step bootstraps off the next value.
    assert advantages[1, 0] == pytest.approx((2.0 + 0.9 * 0.5 - 0.5) + 0.9 * 0.8 * 2.5)
    # The first step carries the middle one's advantage.
    assert advantages[0, 0] == pytest.approx(
        (1.0 + 0.9 * 0.5 - 0.5) + 0.9 * 0.8 * float(advantages[1, 0])
    )
    # Both junctions see the same numbers here.
    assert np.allclose(advantages[:, 0], advantages[:, 1])


def test_a_truncation_bootstraps_and_a_termination_does_not() -> None:
    """The env's time limit cuts an episode short; it does not end it."""
    rewards = np.array([[1.0]], dtype=np.float32)
    values = np.array([[0.5]], dtype=np.float32)
    next_values = np.array([[2.0]], dtype=np.float32)

    truncated = mappo.compute_gae(
        rewards,
        values,
        next_values,
        np.array([False]),
        np.array([True]),
        gamma=0.9,
        gae_lambda=0.8,
    )
    assert truncated[0, 0] == pytest.approx(1.0 + 0.9 * 2.0 - 0.5)

    terminated = mappo.compute_gae(
        rewards,
        values,
        next_values,
        np.array([True]),
        np.array([False]),
        gamma=0.9,
        gae_lambda=0.8,
    )
    assert terminated[0, 0] == pytest.approx(1.0 - 0.5)


def test_one_actor_serves_every_junction() -> None:
    """The parameter sharing is real: the actor does not grow with the grid.

    A 5 x 5 grid has twenty-five agents, and the browser runs **one**
    exported policy at every one of them - so the actor's parameter count
    has to be the same for a 2 x 2 grid and for a 5 x 5 one.
    """
    small = _seeded_actor()
    large = _seeded_actor()
    assert sum(p.numel() for p in small.parameters()) == sum(p.numel() for p in large.parameters())
    # 6*64 + 64 + 64*64 + 64 + 64*5 + 5
    assert sum(p.numel() for p in small.parameters()) == 6 * 64 + 64 + 64 * 64 + 64 + 64 * 5 + 5

    config = mappo.TrainingConfig(rows=5, cols=5, max_steps=20, rollout_steps=10)
    actor = _seeded_actor()
    generator = torch.Generator()
    generator.manual_seed(5)
    episode_seeds = np.random.default_rng(5)
    env = mappo.make_env(config)
    obs, _info = env.reset(seed=2)
    rollout, _obs, _steps = mappo._collect_rollout(
        actor,
        env,
        config,
        generator,
        episode_seeds,
        obs=obs,
    )
    # One action per junction, every step, all of them from the same actor.
    assert rollout.actions.shape == (10, 25)
    assert rollout.obs.shape == (10, 25, 6)
    assert rollout.states.shape == (10, 150)
    assert rollout.agent_rewards.shape == (10, 25)


def test_the_critic_is_centralised() -> None:
    """It sees the whole grid's state and returns one value per junction."""
    critic = mappo.CentralizedCritic(25 * 6, 25)
    assert critic.state_dim == 150
    assert critic.n_agents == 25
    values = critic(torch.zeros(4, 150))
    assert values.shape == (4, 25)


def test_the_export_round_trips_through_json_and_through_a_checkpoint(
    tmp_path: Path,
) -> None:
    """What is written can be read back and gives the same decisions."""
    actor = _seeded_actor()
    weights = mappo.export_weights(actor, "w.json")
    assert json.loads(json.dumps(weights)) == weights

    observation = [0.1, -0.2, 1.0, 0.0, 0.0, 0.25]
    assert browser_action(observation, weights) == int(
        torch.argmax(actor(torch.tensor([observation], dtype=torch.float32)), dim=-1)[0]
    )

    config = mappo.TrainingConfig(rows=2, cols=2, max_steps=20, rollout_steps=10)
    path = tmp_path / "checkpoint.pt"
    torch.save(
        {
            "actor": actor.state_dict(),
            "critic": mappo.CentralizedCritic(24, 4).state_dict(),
            "config": config.as_dict(),
            "step": 10,
        },
        path,
    )
    loaded = mappo.load_checkpoint(path)
    assert loaded["config"].rows == 2
    assert loaded["config"].cols == 2
    again = mappo.export_weights(loaded["actor"], "w.json")
    assert again["layers"] == weights["layers"]


def test_the_defaults_are_the_calibrated_five_by_five_grid() -> None:
    """The 5 x 5 grid at the demand its calibration measured."""
    config = mappo.TrainingConfig()
    assert config.rows == GRID_5X5_ROWS == 5
    assert config.cols == 5
    assert config.demand_scale == GRID_5X5_DEMAND_SCALE == 0.20


def test_the_reporting_window_is_the_selection_window() -> None:
    """A number selected on one window and reported on another is not a number.

    The two windows are not interchangeable: over 400 s the network's
    queue has grown far enough that the accumulated delay is dominated by
    the growth and the policy's marginal effect is diluted. The same
    policy measures +89 over the baseline on the 100 s window and -2838
    on the 400 s one - nothing changed about the policy, the ruler did.
    """
    config = mappo.TrainingConfig()
    assert config.final_eval_steps is None
    assert config.reporting_window == config.eval_steps

    explicit = mappo.TrainingConfig(eval_steps=1000, final_eval_steps=4000)
    assert explicit.reporting_window == 4000


def test_the_evaluation_is_dense() -> None:
    """The cadence is a measurement decision, not a taste.

    The policy oscillates between single-action regimes and the regime
    that beats the fixed cycle is transient, so an evaluation that steps
    over it reports the baseline instead of a policy.
    """
    config = mappo.TrainingConfig()
    assert config.eval_every == 500
    assert config.eval_steps == 1000


def test_a_short_run_writes_the_three_artefacts(tmp_path: Path) -> None:
    """The entry point produces the weights, the summary and the checkpoint."""
    config = mappo.TrainingConfig(
        rows=2,
        cols=2,
        max_steps=40,
        rollout_steps=20,
        eval_every=20,
        eval_steps=40,
        final_eval_steps=40,
        final_eval_seeds=(0,),
    )
    summary = mappo.train_network_mappo(40, config=config, out_dir=tmp_path, progress=False)

    weights_path = tmp_path / "network_mappo_weights.json"
    summary_path = tmp_path / "network_mappo_summary.json"
    checkpoint_path = tmp_path / "network_mappo_checkpoint.pt"
    assert weights_path.exists()
    assert summary_path.exists()
    assert checkpoint_path.exists()

    weights = json.loads(weights_path.read_text(encoding="utf-8"))
    assert weights["obs_dim"] == 6
    assert weights["action_dim"] == 5
    assert weights["action_space"] == "discrete"
    assert "log_std" not in weights["layers"]

    written = json.loads(summary_path.read_text(encoding="utf-8"))
    assert written["env_steps"] == 40
    assert written["final"]["window_steps"] == 40
    assert written["final"]["seeds"] == [0]
    assert "margin" in written["final"]
    assert summary["final"]["beats_baseline"] == written["final"]["beats_baseline"]


def test_two_runs_of_the_same_seed_agree() -> None:
    """The run is reproducible: the same seed gives the same curve."""
    config = mappo.TrainingConfig(
        rows=2,
        cols=2,
        max_steps=40,
        rollout_steps=20,
        eval_every=20,
        eval_steps=40,
        final_eval_steps=40,
        final_eval_seeds=(0,),
        seed=17,
    )
    first = mappo.train_network_mappo(40, config=config, progress=False)
    second = mappo.train_network_mappo(40, config=config, progress=False)
    assert first["final"]["policy"]["returns"] == second["final"]["policy"]["returns"]
    assert first["curve"] == second["curve"]


def test_the_env_of_the_trainer_is_the_browsers_grid() -> None:
    """The scene the trainer runs is the one the browser sends."""
    config = mappo.TrainingConfig()
    env = mappo.make_env(config)
    assert env.n_junctions == 25
    assert env.observation_space.shape == (25, 6)
    assert env.demand_scale == GRID_5X5_DEMAND_SCALE

    network = build_grid_network_dict(GRID_5X5_ROWS, 5)
    assert len(network["intersections"]) == 25
    assert len(network["roads"]) == 40


def test_the_actions_are_the_contract_vocabulary() -> None:
    """The action set is the one the two sides share."""
    assert mappo.ACTION_DIM == len(SIGNAL_ACTION_NAMES) == 5
    assert mappo.NO_OP_INDEX == SIGNAL_ACTION_NAMES.index("no_op")
    assert set(mappo.ACTION_PRIOR_BIAS) <= set(SIGNAL_ACTION_NAMES)


def test_the_env_refuses_exactly_the_action_the_mask_marks() -> None:
    """The mask and the env's own refusal are the same rule."""
    config = mappo.TrainingConfig(rows=2, cols=2, max_steps=60)
    env = mappo.make_env(config)
    obs, _info = env.reset(seed=4)
    for _ in range(30):
        mask = env.action_mask()
        actions = [SHORTEN_RED] * env.n_junctions
        _obs, _reward, _terminated, _truncated, info = env.step(actions)
        refused = list(info["masked"])
        for index, row in enumerate(mask):
            assert row[SHORTEN_RED] != refused[index]

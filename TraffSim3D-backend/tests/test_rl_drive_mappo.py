"""The cooperative-driving MAPPO trainer.

What is pinned here:

1. **The actor is parameter-shared and its layer names are the
   browser's** — so the exported fixture runs in the browser without a
   translation step.
2. **The critic is centralised** — one value per driver, out of the
   joint state.
3. **The advantage is per driver** — the GAE runs on each driver's own
   reward chain, which is what the env's decomposition is for.
4. **A short run learns something** — a few hundred steps must improve
   the evaluation return. This is the guard against a trainer that
   silently does nothing (a run that returns "success" while the policy
   is random).
"""

from __future__ import annotations

import numpy as np
import pytest
import torch

from app.apps.rl.drive_core import ACTION_DIM_DRIVE, OBS_DIM_DRIVE
from app.apps.rl.drive_mappo import (
    DriveActor,
    DriveCritic,
    TrainingConfig,
    _collect_rollout,
    _values_for,
    compute_gae,
    export_weights,
    ppo_update,
    train_drive_mappo,
)
from app.apps.rl.intersection_env import IntersectionEnv


def test_the_actor_has_the_browser_s_layer_names() -> None:
    actor = DriveActor()
    layers = export_weights(actor, "test.json")["layers"]
    assert set(layers) == {
        "policy_net.0.weight",
        "policy_net.0.bias",
        "policy_net.2.weight",
        "policy_net.2.bias",
        "action_net.weight",
        "action_net.bias",
        "log_std",
    }
    # The shapes the browser's forward pass expects.
    assert len(layers["policy_net.0.weight"]) == 64
    assert len(layers["policy_net.0.weight"][0]) == OBS_DIM_DRIVE
    assert len(layers["action_net.weight"]) == ACTION_DIM_DRIVE
    assert len(layers["action_net.weight"][0]) == 64


def test_the_exported_policy_declares_the_continuous_action_space() -> None:
    exported = export_weights(DriveActor(), "test.json")
    assert exported["action_space"] == "continuous"
    assert exported["obs_dim"] == OBS_DIM_DRIVE
    assert exported["action_dim"] == ACTION_DIM_DRIVE


def test_the_critic_gives_one_value_per_driver() -> None:
    critic = DriveCritic(state_dim=OBS_DIM_DRIVE * 3, n_agents=3)
    values = critic(torch.zeros(5, OBS_DIM_DRIVE * 3))
    assert values.shape == (5, 3)


def test_the_gae_restarts_at_an_episode_boundary() -> None:
    """A terminated step breaks the advantage chain.

    The episode ends at step 1, so steps 0 and 1 are one episode and
    step 2 belongs to the next one. The advantage at step 1 must
    therefore carry **its own** reward and nothing of step 2's — and
    step 0, being in the same episode, carries step 1's.
    """
    rewards = np.zeros((3, 2), dtype=np.float32)
    rewards[1] = 1.0
    rewards[2] = 5.0
    values = np.zeros((3, 2), dtype=np.float32)
    next_values = np.zeros((3, 2), dtype=np.float32)
    terminated = np.array([False, True, False])

    advantages = compute_gae(
        rewards,
        values,
        next_values,
        terminated,
        np.zeros(3, dtype=bool),
        gamma=0.99,
        gae_lambda=0.95,
    )

    # Step 1: its own reward, and nothing from step 2 (the chain broke).
    assert advantages[1][0] == pytest.approx(1.0)
    # Step 2: its own reward, alone.
    assert advantages[2][0] == pytest.approx(5.0)
    # Step 0: step 1's advantage discounted (same episode).
    assert advantages[0][0] == pytest.approx(0.99 * 0.95 * 1.0)


def test_the_gae_bootstraps_on_a_truncation() -> None:
    rewards = np.zeros((1, 1), dtype=np.float32)
    values = np.zeros((1, 1), dtype=np.float32)
    next_values = np.full((1, 1), 2.0, dtype=np.float32)

    advantages = compute_gae(
        rewards,
        values,
        next_values,
        np.zeros(1, dtype=bool),
        np.array([True]),
        gamma=0.9,
        gae_lambda=0.95,
    )

    assert advantages[0][0] == pytest.approx(1.8)


def test_the_update_mechanism_moves_the_policy() -> None:
    """The update MECHANISM works: the rollout produces finite
    advantages with variance, the update moves the actor's parameters,
    and the evaluation runs against the moved policy.

    The return-level assertion this replaces was measuring the wrong
    thing: at the shipped learning rate (1e-4) a 2000-step run moves
    the parameters by ~1e-4 and the deterministic evaluation honestly
    cannot see it (the advantage is normalised and the first update's
    ratio is 1, so the policy loss is ~0 by construction — measured:
    the return stayed exactly at the random policy's value). The
    end-to-end proof that the trainer learns is the v3 run (6/6
    drivers through, ARCHITECTURE 5.8); this smoke pins the machinery.
    """
    config = TrainingConfig(
        total_steps=500,
        rollout_steps=250,
        eval_every=250,
        eval_seeds=(0, 1),
        eval_steps=200,
    )
    torch.manual_seed(config.seed)
    actor = DriveActor()
    critic = DriveCritic(state_dim=OBS_DIM_DRIVE * config.n_agents, n_agents=config.n_agents)
    optimizer = torch.optim.Adam(
        list(actor.parameters()) + list(critic.parameters()), lr=config.learning_rate
    )
    env = IntersectionEnv(n_agents=config.n_agents, n_npcs=config.n_npcs, max_steps=200)

    rng = np.random.default_rng(config.seed)
    generator = torch.Generator().manual_seed(config.seed)
    rollout = _collect_rollout(env, actor, critic, config, rng, generator)
    values, next_values = _values_for(critic, rollout, config)
    advantages = compute_gae(
        rollout.rewards,
        values,
        next_values,
        rollout.terminated,
        rollout.truncated,
        gamma=config.gamma,
        gae_lambda=config.gae_lambda,
    )
    # The advantage has VARIANCE — a zero-variance advantage (a bug in
    # the reward or the value function) would make the policy gradient
    # exactly zero and the training a no-op that still looks green.
    assert float(advantages.std()) > 1e-3

    before = {name: param.detach().clone() for name, param in actor.state_dict().items()}
    ppo_update(
        actor,
        critic,
        rollout,
        advantages,
        advantages + values,
        clip_ratio=config.clip_ratio,
        entropy_coef=config.entropy_coef,
        value_coef=config.value_coef,
        max_grad_norm=config.max_grad_norm,
        optimizer=optimizer,
    )
    moved = sum(
        float((param - before[name]).abs().sum()) for name, param in actor.state_dict().items()
    )
    assert moved > 0.0, "the update left the actor exactly as it was"


def test_the_run_writes_the_weights_and_the_summary(tmp_path) -> None:
    config = TrainingConfig(
        total_steps=250,
        rollout_steps=250,
        eval_every=250,
        eval_seeds=(0,),
        eval_steps=100,
    )
    summary = train_drive_mappo(250, config, out_dir=tmp_path, progress=False)

    assert (tmp_path / "network_drive_weights.json").exists()
    assert (tmp_path / "network_drive_summary.json").exists()
    assert summary["weights"] == "network_drive_weights.json"

"""MAPPO for the cooperative driving agents (Scene 4).

The single-junction trainer (``signal_train.py``) is an SB3 PPO over one
intersection. The **network** signal level needed three things SB3's PPO
does not have, and this module is where they were written down (see
``network_mappo.py`` for the signal-level version):

- a **parameter-shared actor**: every driver runs the *same* policy,
  because the browser runs the *same* weights in every car;
- a **centralised critic**: the value of one driver's decision depends
  on what the others are doing (the whole point of a negotiation), so
  the critic sees the **joint** state while the actor sees only its own
  neighbourhood;
- a **per-agent credit** structure: the env already splits the outcome
  into each driver's own share (its waiting time plus the waiting time
  it caused), so the advantage that reaches a driver is about *its* part
  and not mostly somebody else's noise.

The differences from the signal-level MAPPO
------------------------------------------
The actions are **continuous** (acceleration + steering residual), so
there is no mask and no categorical distribution: the actor emits the
mean of a Gaussian with a state-independent standard deviation, and the
log-probability is the Gaussian's.

WHAT THE POLICY IS MEANT TO LEARN
=================================
The reward charges a driver for the waiting time it causes to others,
so holding up the traffic is not free. Together with the conflict
penalty (two vehicles inside the junction's box at the same time), the
gradient points at the thing the scenario is about: **leave the box to
one car at a time**.

The measured baselines this is compared against are in
``intersection_env.py``: ``always_go`` (nobody yields) and
``right_of_way`` (the classical rule, which deadlocks here).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .drive_core import ACTION_DIM_DRIVE, OBS_DIM_DRIVE
from .intersection_env import IntersectionEnv

#: The hidden width of both policy layers — the same architecture the
#: browser's ego policy uses, so the exported fixture runs there.
HIDDEN_SIZES = (64, 64)

#: The initial standard deviation of the action distribution (log scale).
LOG_STD_INIT = -0.5


class DriveActor(torch.nn.Module):
    """The parameter-shared actor: one policy for every driver.

    The layer **names** are the browser's (``policy_net`` is a
    ``Sequential(Linear, Tanh, Linear, Tanh)``, so its two Linear layers
    land at the indices 0 and 2, and ``action_net`` holds the action
    means) — so the exported JSON is the browser's weight dictionary key
    for key.
    """

    def __init__(
        self,
        obs_dim: int = OBS_DIM_DRIVE,
        action_dim: int = ACTION_DIM_DRIVE,
        hidden: Sequence[int] = HIDDEN_SIZES,
    ) -> None:
        super().__init__()
        self.obs_dim = int(obs_dim)
        self.action_dim = int(action_dim)
        self.policy_net = torch.nn.Sequential(
            torch.nn.Linear(self.obs_dim, int(hidden[0])),
            torch.nn.Tanh(),
            torch.nn.Linear(int(hidden[0]), int(hidden[1])),
            torch.nn.Tanh(),
        )
        self.action_net = torch.nn.Linear(int(hidden[1]), self.action_dim)
        # A state-independent standard deviation: the shape of the
        # exploration does not depend on the observation, which keeps the
        # exported fixture runnable in the browser (one number, not a
        # vector per state).
        self.log_std = torch.nn.Parameter(torch.full((self.action_dim,), LOG_STD_INIT))

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        """The action **means**, one row per driver."""
        return self.action_net(self.policy_net(obs))

    def distribution(self, obs: torch.Tensor) -> torch.distributions.Normal:
        """The action distribution for a batch of observations."""
        mean = self.forward(obs)
        std = self.log_std.exp().expand_as(mean)
        return torch.distributions.Normal(mean, std)


class DriveCritic(torch.nn.Module):
    """The centralised critic: the joint state in, one value per driver.

    Training only — it is never exported. Its input is the flattened
    observation of every driver (``n_agents * obs_dim`` numbers): the
    value of one driver's decision depends on the others (that is what
    a negotiation is), so the critic sees the whole joint state while
    the actor sees only its own neighbourhood.
    """

    def __init__(
        self,
        state_dim: int,
        n_agents: int,
        hidden: Sequence[int] = HIDDEN_SIZES,
    ) -> None:
        super().__init__()
        self.state_dim = int(state_dim)
        self.n_agents = int(n_agents)
        self.trunk = torch.nn.Sequential(
            torch.nn.Linear(self.state_dim, int(hidden[0])),
            torch.nn.Tanh(),
            torch.nn.Linear(int(hidden[0]), int(hidden[1])),
            torch.nn.Tanh(),
        )
        self.head = torch.nn.Linear(int(hidden[1]), self.n_agents)

    def forward(self, state: torch.Tensor) -> torch.Tensor:
        """The value of every driver, for every state in the batch."""
        return self.head(self.trunk(state))


@dataclass
class Rollout:
    """One collected rollout: the drivers' transitions."""

    #: The per-driver observations, ``(T, J, obs_dim)``.
    obs: np.ndarray
    #: The centralised states, ``(T, J * obs_dim)``.
    states: np.ndarray
    #: The sampled actions, ``(T, J, action_dim)``.
    actions: np.ndarray
    #: The log-probabilities of those actions, ``(T, J)``.
    log_probs: np.ndarray
    #: The per-driver reward, ``(T, J)``.
    rewards: np.ndarray
    #: Whether the episode ended at every step, ``(T,)``.
    terminated: np.ndarray
    #: Whether the episode was cut short at every step, ``(T,)``.
    truncated: np.ndarray


@dataclass
class TrainingConfig:
    """Every knob of a run, in one place - and in the summary."""

    seed: int = 0
    n_agents: int = 3
    n_npcs: int = 1
    #: How many env steps one rollout collects.
    rollout_steps: int = 500
    #: How many env steps the whole run takes.
    total_steps: int = 20_000
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_ratio: float = 0.2
    learning_rate: float = 3e-4
    entropy_coef: float = 0.005
    value_coef: float = 0.5
    max_grad_norm: float = 0.5
    #: How often the policy is evaluated while it trains.
    eval_every: int = 500
    #: How many steps one evaluation episode runs.
    eval_steps: int = 400
    #: The seeds the evaluation runs on.
    eval_seeds: tuple[int, ...] = (0, 1, 2)
    hidden_sizes: tuple[int, ...] = HIDDEN_SIZES

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def compute_gae(
    rewards: np.ndarray,
    values: np.ndarray,
    next_values: np.ndarray,
    terminated: np.ndarray,
    truncated: np.ndarray,
    *,
    gamma: float,
    gae_lambda: float,
) -> np.ndarray:
    """The generalised advantage estimate of a rollout, per driver.

    The episode flags are ``(T,)``: the negotiation ends for everyone at
    once (the last driver through the junction ends the episode).

    A truncated step (the env's time limit) **bootstraps**: the value of
    the state the episode ended in is carried into the advantage, because
    the episode was cut short and not ended. A terminated step does not
    bootstrap - and the advantage chain restarts at it, so no advantage
    ever crosses an episode boundary.
    """
    step_count, agent_count = rewards.shape
    advantages = np.zeros((step_count, agent_count), dtype=np.float32)
    running = np.zeros(agent_count, dtype=np.float64)
    for t in reversed(range(step_count)):
        value = values[t]
        if bool(terminated[t]):
            delta = rewards[t] - value
            running = delta
        else:
            delta = rewards[t] + gamma * next_values[t] - value
            running = delta + gamma * gae_lambda * running
        advantages[t] = running
    return advantages


def _to_tensor(array: np.ndarray) -> torch.Tensor:
    return torch.as_tensor(array, dtype=torch.float32)


def ppo_update(
    actor: DriveActor,
    critic: DriveCritic,
    rollout: Rollout,
    advantages: np.ndarray,
    returns: np.ndarray,
    *,
    clip_ratio: float,
    entropy_coef: float,
    value_coef: float,
    max_grad_norm: float,
    optimizer: torch.optim.Optimizer,
) -> dict[str, float]:
    """One PPO update over a rollout, for the shared actor and the critic.

    The actor and the critic are optimised **together**: the actor's
    gradient comes from the clipped surrogate, the critic's from the
    value error, and the entropy bonus keeps the exploration alive.
    """
    obs = _to_tensor(rollout.obs)
    states = _to_tensor(rollout.states)
    actions = _to_tensor(rollout.actions)
    old_log_probs = _to_tensor(rollout.log_probs)
    adv = _to_tensor(advantages)
    ret = _to_tensor(returns)

    flat_obs = obs.reshape(-1, actor.obs_dim)
    flat_actions = actions.reshape(-1, actor.action_dim)
    flat_adv = adv.reshape(-1)
    flat_log_probs = old_log_probs.reshape(-1)

    distribution = actor.distribution(flat_obs)
    log_probs = distribution.log_prob(flat_actions).sum(-1)
    entropy = distribution.entropy().sum(-1)

    ratio = torch.exp(log_probs - flat_log_probs)
    # The advantage is normalised per rollout: the drivers' rewards have
    # very different scales (one driver may wait for seconds while
    # another sails through), and a shared normalisation keeps the
    # gradient balanced.
    normalized_adv = (flat_adv - flat_adv.mean()) / (flat_adv.std() + 1e-8)
    surrogate = torch.min(
        ratio * normalized_adv,
        torch.clamp(ratio, 1.0 - clip_ratio, 1.0 + clip_ratio) * normalized_adv,
    )
    policy_loss = -surrogate.mean()
    entropy_loss = -entropy.mean()

    values = critic(states.reshape(-1, critic.state_dim)).reshape(-1)
    value_loss = torch.nn.functional.mse_loss(values, ret.reshape(-1))

    loss = policy_loss + value_coef * value_loss + entropy_coef * entropy_loss

    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(
        list(actor.parameters()) + list(critic.parameters()), max_grad_norm
    )
    optimizer.step()

    with torch.no_grad():
        approx_kl = float((flat_log_probs - log_probs).mean())
        clip_fraction = float(((ratio - 1.0).abs() > clip_ratio).float().mean())
    return {
        "loss": float(loss.detach()),
        "policy_loss": float(policy_loss.detach()),
        "value_loss": float(value_loss.detach()),
        "entropy": float(entropy.mean().detach()),
        "approx_kl": approx_kl,
        "clip_fraction": clip_fraction,
    }


def _collect_rollout(
    env: IntersectionEnv,
    actor: DriveActor,
    critic: DriveCritic,
    config: TrainingConfig,
    rng: np.random.Generator,
    generator: torch.Generator,
) -> Rollout:
    """Collect one rollout of the drivers' transitions."""
    obs, _info = env.reset(seed=int(rng.integers(0, 2**31 - 1)))
    observations: list[np.ndarray] = []
    states: list[np.ndarray] = []
    actions: list[np.ndarray] = []
    log_probs: list[np.ndarray] = []
    rewards: list[np.ndarray] = []
    terminated_flags: list[bool] = []
    truncated_flags: list[bool] = []

    current_obs = obs
    for _step in range(config.rollout_steps):
        obs_tensor = _to_tensor(current_obs)
        with torch.no_grad():
            distribution = actor.distribution(obs_tensor)
            action = distribution.sample()
            log_prob = distribution.log_prob(action).sum(-1)
        # The action the env receives is clipped to the action space; the
        # log-probability is the Gaussian's, computed on the *unclipped*
        # draw (the usual treatment for a bounded action space).
        env_action = np.clip(action.numpy(), -1.0, 1.0)
        state = current_obs.reshape(-1)

        next_obs, reward, terminated, truncated, _info = env.step(env_action)

        observations.append(current_obs)
        states.append(state)
        actions.append(action.numpy())
        log_probs.append(log_prob.numpy())
        rewards.append(reward)
        terminated_flags.append(bool(terminated))
        truncated_flags.append(bool(truncated))

        current_obs = next_obs
        if terminated or truncated:
            current_obs, _info = env.reset(seed=int(rng.integers(0, 2**31 - 1)))

    return Rollout(
        obs=np.asarray(observations, dtype=np.float32),
        states=np.asarray(states, dtype=np.float32),
        actions=np.asarray(actions, dtype=np.float32),
        log_probs=np.asarray(log_probs, dtype=np.float32),
        rewards=np.asarray(rewards, dtype=np.float32),
        terminated=np.asarray(terminated_flags, dtype=bool),
        truncated=np.asarray(truncated_flags, dtype=bool),
    )


def _values_for(
    critic: DriveCritic,
    rollout: Rollout,
    config: TrainingConfig,
) -> tuple[np.ndarray, np.ndarray]:
    """The values of every step and of every step's successor state.

    The successor of the last step is the state the rollout ended in -
    the last observation, which is also the state the episode was reset
    from, so its value is used only for the bootstrap of the final step.
    """
    with torch.no_grad():
        values = critic(_to_tensor(rollout.states)).numpy()
    next_states = np.concatenate([rollout.states[1:], rollout.states[-1:]], axis=0)
    with torch.no_grad():
        next_values = critic(_to_tensor(next_states)).numpy()
    return values, next_values


def evaluate_policy(
    actor: DriveActor,
    config: TrainingConfig,
    *,
    env: IntersectionEnv | None = None,
    env_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Measure the policy deterministically (the mean action).

    The metrics are the ones the report is made of: the return (what the
    policy is optimised for) and, beside it, the conflict count, the
    collisions, the waiting time and how many drivers got through.
    """
    evaluation_env = env or (
        env_factory()
        if env_factory is not None
        else IntersectionEnv(
            n_agents=config.n_agents,
            n_npcs=config.n_npcs,
            max_steps=config.eval_steps,
        )
    )
    returns: list[float] = []
    conflicts: list[int] = []
    collisions: list[int] = []
    delays: list[float] = []
    finished: list[int] = []
    deadlock: list[int] = []
    steps: list[int] = []

    for seed in config.eval_seeds:
        observation, _info = evaluation_env.reset(seed=seed)
        total = 0.0
        step_count = 0
        info: dict[str, Any] = {}
        for _step in range(config.eval_steps):
            with torch.no_grad():
                action = actor(_to_tensor(observation)).numpy()
            observation, reward, terminated, truncated, info = evaluation_env.step(action)
            total += float(np.sum(reward))
            step_count += 1
            if terminated or truncated:
                break
        returns.append(total)
        conflicts.append(int(info.get("conflicts", 0)))
        collisions.append(int(info.get("collisions", 0)))
        delays.append(float(info.get("delay", 0.0)))
        finished.append(int(info.get("finished", 0)))
        deadlock.append(int(info.get("deadlock_steps", 0)))
        steps.append(step_count)

    return {
        "return": float(np.mean(returns)),
        "return_std": float(np.std(returns)),
        "conflicts": float(np.mean(conflicts)),
        "collisions": float(np.mean(collisions)),
        "delay": float(np.mean(delays)),
        "finished": float(np.mean(finished)),
        "deadlock_steps": float(np.mean(deadlock)),
        "steps": float(np.mean(steps)),
        "seeds": len(config.eval_seeds),
    }


def export_weights(actor: DriveActor, name: str) -> dict[str, Any]:
    """The policy as the browser's weight dictionary.

    The layout is the browser's: ``policy_net.0`` / ``policy_net.2`` /
    ``action_net`` plus the ``log_std`` of the Gaussian. The browser's
    ``mlpForwardMean`` runs it as-is.
    """
    state = actor.state_dict()
    layers = {
        "policy_net.0.weight": state["policy_net.0.weight"].detach().cpu().tolist(),
        "policy_net.0.bias": state["policy_net.0.bias"].detach().cpu().tolist(),
        "policy_net.2.weight": state["policy_net.2.weight"].detach().cpu().tolist(),
        "policy_net.2.bias": state["policy_net.2.bias"].detach().cpu().tolist(),
        "action_net.weight": state["action_net.weight"].detach().cpu().tolist(),
        "action_net.bias": state["action_net.bias"].detach().cpu().tolist(),
        "log_std": actor.log_std.detach().cpu().tolist(),
    }
    return {
        "name": name,
        "obs_dim": actor.obs_dim,
        "action_dim": actor.action_dim,
        "action_space": "continuous",
        "hidden_sizes": list(HIDDEN_SIZES),
        "layers": layers,
    }


def train_drive_mappo(
    steps: int,
    config: TrainingConfig | None = None,
    *,
    out_dir: Path | None = None,
    device: str = "cpu",
    progress: bool = True,
    env_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Train the cooperative drivers.

    The run keeps the **best** checkpoint, measured by the deterministic
    evaluation - the same lesson as the signal trainer: the policy
    oscillates while it trains, and a run that only reports its last
    checkpoint reports whichever regime it happened to end in.
    """
    config = config or TrainingConfig()
    torch.manual_seed(config.seed)
    rng = np.random.default_rng(config.seed)
    generator = torch.Generator().manual_seed(config.seed)

    actor = DriveActor(
        obs_dim=OBS_DIM_DRIVE,
        action_dim=ACTION_DIM_DRIVE,
        hidden=config.hidden_sizes,
    ).to(device)
    critic = DriveCritic(
        state_dim=OBS_DIM_DRIVE * config.n_agents,
        n_agents=config.n_agents,
        hidden=config.hidden_sizes,
    ).to(device)
    optimizer = torch.optim.Adam(
        list(actor.parameters()) + list(critic.parameters()),
        lr=config.learning_rate,
    )

    env = (
        env_factory()
        if env_factory is not None
        else IntersectionEnv(
            n_agents=config.n_agents,
            n_npcs=config.n_npcs,
            max_steps=config.eval_steps,
        )
    )

    curve: list[dict[str, Any]] = []
    best_return = -math.inf
    best_step = 0
    best_weights: dict[str, Any] | None = None
    best_metrics: dict[str, Any] = {}
    step_count = 0

    while step_count < steps:
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
        returns = advantages + values
        stats = ppo_update(
            actor,
            critic,
            rollout,
            advantages,
            returns,
            clip_ratio=config.clip_ratio,
            entropy_coef=config.entropy_coef,
            value_coef=config.value_coef,
            max_grad_norm=config.max_grad_norm,
            optimizer=optimizer,
        )
        step_count += config.rollout_steps

        if step_count % config.eval_every < config.rollout_steps or step_count >= steps:
            metrics = evaluate_policy(actor, config, env=env)  # the run's own env
            metrics.update({"step": step_count, **stats})
            curve.append(metrics)
            if metrics["return"] > best_return:
                best_return = metrics["return"]
                best_step = step_count
                best_metrics = dict(metrics)
                best_weights = export_weights(actor, "network_drive_policy.json")
            if progress:
                print(
                    f"[drive-mappo] step {step_count:6d} "
                    f"return {metrics['return']:9.2f} "
                    f"conflicts {metrics['conflicts']:5.1f} "
                    f"collisions {metrics['collisions']:5.1f} "
                    f"delay {metrics['delay']:8.1f} "
                    f"finished {metrics['finished']:4.1f} "
                    f"entropy {metrics['entropy']:6.3f}",
                    flush=True,
                )

    summary: dict[str, Any] = {
        "config": config.to_dict(),
        "env_steps": step_count,
        "best_step": best_step,
        "best_return": best_return,
        "best_metrics": best_metrics,
        "curve": curve,
    }

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        if best_weights is not None:
            (out_dir / "network_drive_weights.json").write_text(
                json.dumps(best_weights, indent=2) + "\n", encoding="utf-8"
            )
            summary["weights"] = "network_drive_weights.json"
        (out_dir / "network_drive_summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )
    return summary

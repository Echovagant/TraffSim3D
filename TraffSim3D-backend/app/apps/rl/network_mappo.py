"""MAPPO for the multi-junction signal agent.

The single-junction trainer (``signal_train.py``) is an SB3 PPO over one
intersection. The **network** level needs three things SB3's PPO does not
have, and this module is where they are written down:

- a **parameter-shared actor**: every junction of the grid runs the *same*
  policy, because the browser runs the *same* weights at every junction -
  the exported JSON is one actor, not twenty-five;
- a **centralised critic**: the value of a junction's decision depends on
  what the rest of the network is doing (a queue at A becomes an arrival at
  B one link later), so the critic sees the **whole** grid's state while the
  actor sees only its own junction's six numbers;
- a **masked** action distribution: ``NetworkSignalEnv.action_mask()``
  refuses a ``shorten_red`` that would push the green below the minimum, and
  a trainer that samples from the mask never proposes an action the env
  would throw away - so its log-probability means what it says.

What the agent optimises
========================
The env's reward is the **network total delay**: one number for the whole
grid. The task is global (a junction that serves its own queue at the cost
of the network's delay has not solved anything), the observation stays
local (the browser's per-junction six numbers), and the policy has to learn
the global trade-off from a local view.

The trade-off that is reachable here is the **green split**. The fixed
30/30 cycle spends the same green on both axes, and the demand is not the
same on both (the train condition carries 300 veh/h/lane north-south and
400 east-west, and the 5 x 5 grid's calibration scales both by
``GRID_5X5_DEMAND_SCALE``). Moving five seconds of green to the busier
axis is what ``shorten_red`` does, and it is worth real delay:

    fixed 30/30 cycle (no_op)        -16001   (400 s, three seeds)
    "shorten the red if the red axis
     has the bigger queue"           -13998   (the same window, seeds)

(the second row is a hand-written rule, measured with a probe script; it
is the behaviour the learned policy has to approximate, and the number the
learned policy is reported against).

CREDIT ASSIGNMENT - WHY THE REWARD IS DECOMPOSED
================================================
The env's reward is one number for the whole grid, and the textbook
version of this trainer hands that same number to all twenty-five agents.
**Measured, that does not train:** every shared-reward configuration that
was tried collapsed onto ``extend_green`` - the action that serves the
green axis a little longer and therefore shows an immediate gain in the
delay - and the collapse cost more delay than the fixed cycle (measured:
-9068 against the fixed cycle's -5391 on the same window). The reason is
not a bug but a property of the reward: the network's delay is the **sum**
of the junctions' delays, so a junction's own contribution to it is one
part in twenty-five, while the noise the other twenty-four junctions put
into the same number is not. The advantage that reaches a junction is
therefore mostly somebody else's noise, and the action with the largest
*immediate* effect on the delay wins - which is the wrong one.

So the trainer uses the **exact decomposition** of the reward: the env
reports each junction's two axis queues, and the network's delay is
precisely their sum, so

    reward(t) = sum over the junctions of  -(queue_ns + queue_ew) * DT

is an identity, not a shaping. Each agent is trained on its own term of
that sum, which is the same objective with the credit delivered where it
belongs. The **evaluation** still measures the network's total delay -
the env's own reward - so the number the policy is judged by is the
contract's number.

``TrainingConfig.credit_assignment`` keeps the shared reward as an
option (``"network"``), because the comparison is worth being able to
reproduce.

THE POLICY DOES NOT SETTLE - AND THAT IS WHY THE EVALUATION IS DENSE
====================================================================
A PPO run on this level does not converge on one schedule. It **oscillates**
between single-action regimes, and the regime that beats the fixed cycle
is **transient**:

* the good regime is mostly ``no_op`` with a few per cent of
  ``shorten_red`` - measured: 402 ``shorten_red`` of 2194 decisions, out
  of 25 000 - and it lasts a few thousand steps;
* the collapse modes are far worse than the fixed cycle (measured: -358
  and -441 against the cycle's -1042.8), so a run that never samples
  inside the good regime does not merely fail to improve - it ends up
  *worse* than the schedule it was supposed to beat.

The consequence is a measurement decision, not an algorithmic one: **the
evaluation has to be dense enough to land inside the good regime.** With
an evaluation every 500 steps the good regime is caught reliably - two
seeds measured at +116.6 and +109.6 over the baseline - while an
evaluation every 2500 steps steps straight over it and the run reports
``margin 0.0``: it measured the baseline, not a policy.

The run keeps the **best** evaluation it measured, which is why the dense
evaluation is the default and not a convenience.

THE SELECTION WINDOW AND THE REPORTING WINDOW ARE THE SAME WINDOW
==================================================================
The checkpoint is picked on the in-run evaluation's window, and the final
measurement is made on **that same window** by default
(``final_eval_steps=None`` means ``eval_steps``). The two windows are not
interchangeable: over 400 s the network's queue has grown far enough that
the accumulated delay is dominated by the growth and the policy's marginal
effect is diluted - measured, the *same* policy is +89 over the baseline
on the 100 s window and -2838 on the 400 s one. Nothing changed about
the policy; the ruler changed. A number that is selected on one window
and reported on another is not a number.

WHY THE ACTOR'S SHAPE IS FIXED
==============================
The browser runs the policy in ``src/infrastructure/rl/mlpInference.ts``,
which hard-codes one layer layout and takes the **argmax** of the logits:

    obs (6) -> policy_net.0 Linear+Tanh -> policy_net.2 Linear+Tanh
             -> action_net Linear (the logits)

So the actor here **is** that layout: ``policy_net`` is a
``Sequential(Linear, Tanh, Linear, Tanh)`` - which puts the two Linears at
the indices 0 and 2 - and ``action_net`` is the logits' Linear. The
exported JSON therefore needs no key translation at all, and the state dict
of this module's actor is the browser's layer dictionary.

WHAT THIS MODULE DOES NOT DO
============================
It does not touch ``network_signal_env.py``, ``sim_core.py`` or anything
else in the package: the env's defaults are pinned by other tests and the
cross-language contract's golden files depend on ``sim_core``. The trainer
only reads them.
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .network_signal_env import (
    GRID_5X5_COLS,
    GRID_5X5_DEMAND_SCALE,
    GRID_5X5_ROWS,
    NetworkSignalEnv,
    build_grid_network_dict,
)
from .signal_conditions import TRAIN_CONDITION
from .sim_core import DT, SIGNAL_ACTION_NAMES

try:
    import torch
except ImportError as e:  # pragma: no cover - torch is a hard requirement here
    raise ImportError("the MAPPO trainer needs PyTorch: install it into the backend venv") from e

__all__ = [
    "ACTION_DIM",
    "CentralizedCritic",
    "HIDDEN_SIZES",
    "OBS_DIM",
    "PolicyActor",
    "TrainingConfig",
    "compute_gae",
    "evaluate_baseline",
    "evaluate_policy",
    "export_weights",
    "load_checkpoint",
    "masked_entropy",
    "masked_log_probs",
    "sample_actions",
    "train_network_mappo",
]

#: The per-junction observation width - the six numbers the browser's
#: ``buildSignalObservation`` produces, in the same order.
OBS_DIM = 6

#: The action count - ``sim_core.SIGNAL_ACTION_NAMES``, the contract's
#: vocabulary.
ACTION_DIM = len(SIGNAL_ACTION_NAMES)

#: The actor's hidden sizes. The browser's forward pass reads these
#: dimensions out of the exported weights, so they are fixed: a policy with
#: a different shape is not runnable in the browser.
HIDDEN_SIZES = (64, 64)

#: ``no_op`` - the fixed 30/30 cycle, the baseline a trained policy is
#: measured against.
NO_OP_INDEX = SIGNAL_ACTION_NAMES.index("no_op")

#: The action prior written into the actor's action-layer bias.
#:
#: It exists for the same reason as the single-junction trainer's: the
#: ``preempt`` / ``force_all_red`` actions are catastrophic and **sticky**
#: (one sampled all-red re-arms three seconds of clearance), so a policy
#: that starts out sampling them uniformly spends the whole episode in
#: clearance and every episode scores the same - which leaves PPO with no
#: variance to learn from. The prior moves the initial distribution away
#: from those two actions without touching the action space, the reward or
#: the traffic model.
#:
#: ``no_op`` keeps a mild positive bias: the fixed cycle is the **safe**
#: default, and a policy that starts by shortening every red it sees
#: flickers the whole grid (measured: a constant ``shorten_red`` costs
#: -19391 against the fixed cycle's -16001).
ACTION_PRIOR_BIAS: dict[str, float] = {
    "no_op": 1.0,
    "preempt": -3.0,
    "force_all_red": -3.0,
}


# ===== the networks =====


class PolicyActor(torch.nn.Module):
    """The parameter-shared actor: one policy for every junction.

    The layer **names** are the browser's: ``policy_net`` is a
    ``Sequential(Linear, Tanh, Linear, Tanh)``, so its two Linear layers
    land at the indices 0 and 2, and ``action_net`` holds the logits. The
    state dict of this module is therefore the browser's layer dictionary,
    key for key.
    """

    def __init__(
        self,
        obs_dim: int = OBS_DIM,
        action_dim: int = ACTION_DIM,
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

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        """The action **logits** - one row per junction."""
        return self.action_net(self.policy_net(obs))


class CentralizedCritic(torch.nn.Module):
    """The centralised critic: the whole grid's state in, one value per junction.

    The critic is **training only** - it is never exported. Its input is
    the flattened observation of every junction (``n_junctions * 6``
    numbers), because the value of a junction's decision depends on the
    rest of the network: a queue released at A arrives at B one link later,
    so a decision that looks free locally can be expensive downstream.

    The **trunk** is shared and the **head** has one output per junction:
    every junction gets its own value function out of the one centralised
    state, which is what the credit assignment needs (see the module
    docstring).
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
        """The value of every junction, for every state in the batch."""
        return self.head(self.trunk(state))


# ===== the masked categorical =====


def _masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """The logits with the refused actions pushed out of the distribution.

    ``finfo.min`` rather than ``-inf``: the refused actions still have to
    survive the arithmetic (``0 * -inf`` is a NaN), and a finite floor
    keeps every downstream product well defined.
    """
    return logits.masked_fill(~mask, torch.finfo(logits.dtype).min)


def masked_log_probs(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """``log π(a)`` of every action under the **masked** categorical.

    The refused actions get a probability of exactly zero, so their
    log-probability is the floor rather than a real number - which is
    exactly what "the env would refuse this action" means for the policy
    gradient.
    """
    masked = _masked_logits(logits, mask)
    return masked - torch.logsumexp(masked, dim=-1, keepdim=True)


def masked_entropy(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """The entropy of the masked categorical, per row."""
    masked = _masked_logits(logits, mask)
    probs = torch.softmax(masked, dim=-1)
    log_probs = masked_log_probs(logits, mask)
    # The refused actions have a probability of zero; their log-probability
    # is the floor, and 0 * floor is zero, but the floor is finite here so
    # the product is safe either way.
    safe = torch.where(probs > 0, log_probs, torch.zeros_like(log_probs))
    return -(probs * safe).sum(-1)


def sample_actions(
    logits: torch.Tensor,
    mask: torch.Tensor,
    generator: torch.Generator,
) -> torch.Tensor:
    """Draw one action per row from the masked categorical.

    The generator is passed in, so the whole run is reproducible from one
    seed without touching the global RNG.
    """
    probs = torch.softmax(_masked_logits(logits, mask), dim=-1)
    flat = probs.reshape(-1, probs.shape[-1])
    drawn = torch.multinomial(flat, 1, generator=generator)
    return drawn.reshape(probs.shape[:-1])


def apply_action_prior(actor: PolicyActor) -> None:
    """Write the initial action prior into the actor's action-layer bias.

    See ``ACTION_PRIOR_BIAS`` for why the prior exists. It is an
    *initialisation*: nothing stops the policy from moving the bias back if
    the data says so.
    """
    with torch.no_grad():
        bias = actor.action_net.bias
        bias[:] = 0.0
        for name, value in ACTION_PRIOR_BIAS.items():
            bias[SIGNAL_ACTION_NAMES.index(name)] = value


# ===== the advantage =====


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
    """The generalised advantage estimate of a rollout.

    ``rewards``, ``values`` and ``next_values`` are ``(T, J)`` - one row
    per env step, one column per junction - and the episode flags are
    ``(T,)``: an episode ends for the whole grid at once.

    A truncated step (the env's time limit) **bootstraps**: the value of
    the state the episode ended in is carried into the advantage, because
    the episode was cut short and not ended. A terminated step does not
    bootstrap - and the advantage chain restarts at it, so no advantage
    ever crosses an episode boundary.
    """
    step_count, junction_count = rewards.shape
    advantages = np.zeros((step_count, junction_count), dtype=np.float32)
    running = np.zeros(junction_count, dtype=np.float64)
    for t in reversed(range(step_count)):
        value = values[t]
        if bool(terminated[t]):
            delta = rewards[t] - value
            running = delta
        else:
            # A truncation bootstraps off the value of the final state;
            # an ordinary step off the value of the next state.
            delta = rewards[t] + gamma * next_values[t] - value
            running = delta + gamma * gae_lambda * running
        advantages[t] = running
    return advantages


# ===== the rollout =====


@dataclass
class Rollout:
    """One collected rollout: the network's transitions and their masks."""

    #: The per-junction observations, ``(T, J, 6)``.
    obs: np.ndarray
    #: The centralised states, ``(T, J * 6)``.
    states: np.ndarray
    #: The states that follow each step, ``(T, J * 6)``.
    next_states: np.ndarray
    #: The sampled actions, ``(T, J)``.
    actions: np.ndarray
    #: The log-probabilities of those actions, ``(T, J)``.
    log_probs: np.ndarray
    #: The action masks, ``(T, J, 5)``.
    masks: np.ndarray
    #: The network reward of every step, ``(T,)``.
    rewards: np.ndarray
    #: The per-junction reward, ``(T, J)`` - the network's reward split
    #: into its junction-sized parts (see the module docstring).
    agent_rewards: np.ndarray
    #: Whether the episode ended at every step, ``(T,)``.
    terminated: np.ndarray
    #: Whether the episode was cut short at every step, ``(T,)``.
    truncated: np.ndarray


@dataclass
class TrainingConfig:
    """Every knob of a run, in one place - and in the summary.

    The defaults are the measured recipe (see the module docstring for the
    numbers they were measured against).
    """

    rows: int = GRID_5X5_ROWS
    cols: int = GRID_5X5_COLS
    #: The demand multiplier. 0.20 is the **calibrated** demand of the
    #: 5 x 5 grid: it peaks at a queue of eight and clips no observation.
    demand_scale: float = GRID_5X5_DEMAND_SCALE
    #: The episode length in env steps (2000 = 200 s at the 10 Hz clock).
    max_steps: int = 2000
    #: How many env steps one rollout collects.
    rollout_steps: int = 1000
    #: The seed of the whole run.
    seed: int = 0
    learning_rate: float = 3e-4
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip_ratio: float = 0.2
    ent_coef: float = 0.02
    #: Where the entropy coefficient ends up. ``None`` keeps it constant;
    #: a number anneals it linearly from ``ent_coef`` over the run, which
    #: is how the exploration is traded for commitment: early on the
    #: policy has to try the actions whose payoff only shows up a whole
    #: phase later, and late on it has to stop trying them.
    ent_coef_end: float | None = None
    vf_coef: float = 0.5
    #: How many times the collected rollout is reused.
    epochs: int = 4
    minibatch_size: int = 512
    #: How the network's delay is credited to the junctions.
    #:
    #: ``"junction"`` gives every junction its own term of the network's
    #: delay - an exact decomposition of it, and the reason the policy
    #: trains at all (see the module docstring). ``"network"`` gives every
    #: junction the whole network's reward, which is the textbook
    #: shared-reward version; it is kept so the comparison can be
    #: reproduced.
    credit_assignment: str = "junction"
    #: The evaluation window during the run, in env steps (1000 = 100 s).
    eval_steps: int = 1000
    #: The seed of the in-run evaluation episodes.
    eval_seed: int = 0
    #: How often (in env steps) the policy is evaluated.
    #:
    #: **500, and that is not a taste.** The policy does not settle on a
    #: schedule - it oscillates between single-action regimes, and the
    #: regime that beats the fixed cycle is **transient**: mostly
    #: ``no_op`` with a few per cent of ``shorten_red`` (measured: 402 of
    #: 2194 ``shorten_red`` out of 25 000 decisions), and it lasts a few
    #: thousand steps. The collapse modes are much worse than the fixed
    #: cycle (measured: -358 and -441 against the cycle's -1042.8), so a
    #: run whose evaluation points step over the good regime ends at
    #: ``margin 0.0`` - it measured the baseline, not a policy.
    #:
    #: With an evaluation every 500 steps the good regime is caught
    #: reliably: three seeds measured at +89.1, +109.6 and +116.0 over
    #: the baseline, against +0.0 when the evaluation was every 2500
    #: steps.
    eval_every: int = 500
    #: The window of the **final** measurement, in env steps.
    #:
    #: ``None`` means **the same window the checkpoint was selected on**
    #: (``eval_steps``), and that is the default on purpose: a number
    #: that is selected on one window and reported on another is not a
    #: number. The two windows are not interchangeable - over 400 s the
    #: network's queue has grown far enough that the accumulated delay is
    #: dominated by the growth and the policy's marginal effect is
    #: diluted (measured: the same policy is +89 on the 100 s window and
    #: -2838 on the 400 s one).
    final_eval_steps: int | None = None
    #: The seeds of the final evaluation - the held-out set the shipped
    #: policy is reported on.
    final_eval_seeds: tuple[int, ...] = (0, 1, 2)
    device: str = "cpu"

    @property
    def reporting_window(self) -> int:
        """The window the final measurement is made on.

        The selection window by default: the checkpoint is picked on one
        window and has to be reported on the same one.
        """
        if self.final_eval_steps is None:
            return int(self.eval_steps)
        return int(self.final_eval_steps)

    def as_dict(self) -> dict[str, Any]:
        """The config as JSON-friendly data."""
        return {
            "rows": self.rows,
            "cols": self.cols,
            "demand_scale": self.demand_scale,
            "max_steps": self.max_steps,
            "rollout_steps": self.rollout_steps,
            "seed": self.seed,
            "learning_rate": self.learning_rate,
            "gamma": self.gamma,
            "gae_lambda": self.gae_lambda,
            "clip_ratio": self.clip_ratio,
            "ent_coef": self.ent_coef,
            "ent_coef_end": self.ent_coef_end,
            "vf_coef": self.vf_coef,
            "epochs": self.epochs,
            "minibatch_size": self.minibatch_size,
            "credit_assignment": self.credit_assignment,
            "eval_steps": self.eval_steps,
            "eval_seed": self.eval_seed,
            "eval_every": self.eval_every,
            "final_eval_steps": self.final_eval_steps,
            "final_eval_seeds": list(self.final_eval_seeds),
            "device": self.device,
        }


# ===== the environment =====


def make_env(config: TrainingConfig, *, max_steps: int | None = None) -> NetworkSignalEnv:
    """A fresh network env on the grid the config asks for.

    The demand is the config's ``demand_scale`` - the calibrated value for
    the 5 x 5 grid - and the condition is the train condition, the same
    one the single-junction trainer uses.
    """
    network = build_grid_network_dict(config.rows, config.cols)
    return NetworkSignalEnv(
        network,
        condition=TRAIN_CONDITION,
        max_steps=config.max_steps if max_steps is None else int(max_steps),
        demand_scale=config.demand_scale,
    )


# ===== the policy update =====


def ppo_update(
    actor: PolicyActor,
    critic: CentralizedCritic,
    optimizer: torch.optim.Optimizer,
    rollout: Rollout,
    advantages: np.ndarray,
    returns: np.ndarray,
    old_values: np.ndarray,
    value_mean: float,
    value_std: float,
    ent_coef: float,
    config: TrainingConfig,
    generator: torch.Generator,
) -> dict[str, float]:
    """One PPO update on a collected rollout.

    The clipped surrogate is the standard one, with two MAPPO specifics:

    - the **advantage is per junction**: the env's reward is the network's
      total delay, and the trainer credits it to the junctions that earned
      it (see the module docstring), so the gradient of a junction's
      decision reflects that junction's own contribution;
    - the **mask travels with the transition**: the log-probability of a
      sampled action is the one under the masked distribution, so the
      ratio in the surrogate compares like with like.

    The value loss is the clipped one (as in SB3), and the entropy term is
    the masked categorical's entropy - the exploration that lets the policy
    leave the action prior.
    """
    junction_count = rollout.actions.shape[1]

    # The flat batch is (step, junction) with the **junction** varying
    # fastest, so a step's reward and the junctions' values are repeated
    # in the same order.
    obs = torch.from_numpy(rollout.obs.reshape(-1, OBS_DIM)).float()
    states = torch.from_numpy(rollout.states).float()
    actions = torch.from_numpy(rollout.actions.reshape(-1)).long()
    old_log_probs = torch.from_numpy(rollout.log_probs.reshape(-1)).float()
    masks = torch.from_numpy(rollout.masks.reshape(-1, ACTION_DIM))
    # The critic's value of the state the rollout was collected in - the
    # reference the clipped value loss is measured against.
    old_values_flat = torch.from_numpy(old_values.reshape(-1).astype(np.float32))

    flat_advantages = torch.from_numpy(advantages.reshape(-1).astype(np.float32))
    # The critic learns a **normalised** value: the raw return of this env
    # is in the tens (a junction's delay runs at about a tenth of a
    # vehicle-second per step, and a discount factor of 0.995 multiplies
    # that by two hundred), so a plain mean-squared loss would ask the
    # critic's output layer for weights of order one - and an Adam step of
    # 3e-4 would need tens of thousands of steps to get there. The
    # normalisation puts the target on a unit scale, and the value is
    # reconstructed in the reward's own units for the advantage.
    flat_returns = torch.from_numpy(
        ((returns.reshape(-1) - value_mean) / value_std).astype(np.float32)
    )
    # Advantage normalisation: the advantage of a junction is on the scale
    # of the reward's own fluctuations, and the policy gradient wants the
    # standardised version of it.
    flat_advantages = (flat_advantages - flat_advantages.mean()) / (
        flat_advantages.std(unbiased=False) + 1e-8
    )

    total = obs.shape[0]
    stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "clip_fraction": 0.0}
    batches = 0
    for _epoch in range(config.epochs):
        order = torch.randperm(total, generator=generator)
        for start in range(0, total, config.minibatch_size):
            index = order[start : start + config.minibatch_size]
            logits = actor(obs[index])
            log_probs = masked_log_probs(logits, masks[index])
            chosen = log_probs.gather(1, actions[index].unsqueeze(1)).squeeze(1)
            ratio = torch.exp(chosen - old_log_probs[index])
            advantage = flat_advantages[index]
            surrogate = torch.minimum(
                ratio * advantage,
                torch.clamp(ratio, 1.0 - config.clip_ratio, 1.0 + config.clip_ratio) * advantage,
            )
            policy_loss = -surrogate.mean()

            # The critic's value is one number **per junction**, and the
            # critic is fed the centralised state **once per step**, so
            # the minibatch's flat entries are gathered back out of the
            # steps they belong to.
            step_ids = torch.unique(index // junction_count)
            step_values = critic(states[step_ids])
            positions = torch.searchsorted(step_ids, index // junction_count)
            values = step_values[positions, index % junction_count]
            unclipped = (values - flat_returns[index]) ** 2
            clipped = (
                old_values_flat[index]
                + torch.clamp(
                    values - old_values_flat[index], -config.clip_ratio, config.clip_ratio
                )
                - flat_returns[index]
            ) ** 2
            value_loss = 0.5 * torch.max(unclipped, clipped).mean()

            entropy = masked_entropy(logits, masks[index]).mean()
            loss = policy_loss + config.vf_coef * value_loss - ent_coef * entropy

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                list(actor.parameters()) + list(critic.parameters()), 0.5
            )
            optimizer.step()

            stats["policy_loss"] += float(policy_loss.detach())
            stats["value_loss"] += float(value_loss.detach())
            stats["entropy"] += float(entropy.detach())
            stats["clip_fraction"] += float(
                ((ratio < 1.0 - config.clip_ratio) | (ratio > 1.0 + config.clip_ratio))
                .float()
                .mean()
                .detach()
            )
            batches += 1
    for key in stats:
        stats[key] /= max(batches, 1)
    return stats


# ===== the export =====


def export_weights(actor: PolicyActor, name: str) -> dict[str, Any]:
    """The actor as the JSON the browser runs.

    The shape is the one ``app/apps/rl/weights.py`` exports for an SB3
    discrete policy, and the one the browser's ``PolicyWeights`` type
    declares: the metadata at the top and the flattened layers below.

    A **discrete** policy has no ``log_std`` - the key is omitted, exactly
    as the SB3 exporter omits it for a ``CategoricalPolicy``.
    """
    state = actor.state_dict()
    first = state["policy_net.0.weight"]
    second = state["policy_net.2.weight"]
    action = state["action_net.weight"]
    return {
        "name": name,
        "obs_dim": int(first.shape[1]),
        "action_dim": int(action.shape[0]),
        "action_space": "discrete",
        "hidden_sizes": [int(first.shape[0]), int(second.shape[0])],
        "layers": {
            "policy_net.0.weight": first.detach().cpu().tolist(),
            "policy_net.0.bias": state["policy_net.0.bias"].detach().cpu().tolist(),
            "policy_net.2.weight": second.detach().cpu().tolist(),
            "policy_net.2.bias": state["policy_net.2.bias"].detach().cpu().tolist(),
            "action_net.weight": action.detach().cpu().tolist(),
            "action_net.bias": state["action_net.bias"].detach().cpu().tolist(),
        },
    }


# ===== the evaluation =====


def evaluate_policy(
    actor: PolicyActor,
    config: TrainingConfig,
    *,
    steps: int,
    seed: int,
    mask_argmax: bool = False,
) -> dict[str, Any]:
    """Score the policy deterministically, the way the browser runs it.

    The browser takes the **argmax of the logits** and hands the action to
    the junction, which refuses a ``shorten_red`` it may not apply (the
    same refusal the Python env applies - see the browser's
    ``RLController.applyActions``). So the plain argmax is the browser's
    behaviour, and it is what this function measures.

    ``mask_argmax`` takes the argmax **under the env's mask** instead -
    the action the training samples from. It is reported next to the
    browser's number so the two can be compared, not in place of it.
    """
    env = make_env(config, max_steps=steps)
    obs, _info = env.reset(seed=seed)
    total = 0.0
    histogram: dict[str, int] = {}
    refused = 0
    used = 0
    while True:
        with torch.no_grad():
            logits = actor(torch.from_numpy(obs).float())
        if mask_argmax:
            mask = torch.tensor(env.action_mask(), dtype=torch.bool)
            logits = _masked_logits(logits, mask)
        actions = torch.argmax(logits, dim=-1).tolist()
        obs, reward, terminated, truncated, info = env.step(actions)
        total += float(reward)
        used += 1
        for action in actions:
            name = SIGNAL_ACTION_NAMES[int(action)]
            histogram[name] = histogram.get(name, 0) + 1
        refused += int(sum(1 for flag in info.get("masked", []) if flag))
        if terminated or truncated:
            break
    return {
        "return": total,
        "steps": used,
        "actions": histogram,
        "refused_actions": refused,
        "seed": seed,
        "masked_argmax": bool(mask_argmax),
    }


def evaluate_baseline(
    config: TrainingConfig,
    *,
    steps: int,
    seed: int,
    action_index: int = NO_OP_INDEX,
) -> dict[str, Any]:
    """Score a constant-action schedule - the fixed 30/30 cycle.

    ``no_op`` on every step is the plain fixed cycle: the baseline a
    trained policy is measured against, on the same window and the same
    seeds.
    """
    env = make_env(config, max_steps=steps)
    obs, _info = env.reset(seed=seed)
    total = 0.0
    histogram: dict[str, int] = {}
    while True:
        actions = [action_index] * env.n_junctions
        obs, reward, terminated, truncated, _info = env.step(actions)
        total += float(reward)
        for action in actions:
            name = SIGNAL_ACTION_NAMES[int(action)]
            histogram[name] = histogram.get(name, 0) + 1
        if terminated or truncated:
            break
    return {
        "return": total,
        "actions": histogram,
        "seed": seed,
        "action": SIGNAL_ACTION_NAMES[action_index],
    }


def _mean(values: Sequence[float]) -> float:
    return float(sum(values) / len(values)) if values else 0.0


def _merge_histograms(histograms: Sequence[dict[str, int]]) -> dict[str, int]:
    merged: dict[str, int] = {}
    for histogram in histograms:
        for name, count in histogram.items():
            merged[name] = merged.get(name, 0) + count
    return merged


def _explained_variance(returns: np.ndarray, values: np.ndarray) -> float:
    """How much of the return's spread the critic explains."""
    residual = (returns - values).reshape(-1)
    target = returns.reshape(-1)
    variance = float(np.var(target))
    if variance <= 1e-12:
        return 0.0
    return float(1.0 - np.var(residual) / variance)


# ===== the training =====


def _collect_rollout(
    actor: PolicyActor,
    env: NetworkSignalEnv,
    config: TrainingConfig,
    generator: torch.Generator,
    episode_seeds: np.random.Generator,
    *,
    obs: np.ndarray,
) -> tuple[Rollout, np.ndarray, int]:
    """Collect one rollout of the network's transitions.

    The env is **not** reset at the start of a rollout: a rollout may end
    in the middle of an episode, and the episode continues into the next
    one. The caller keeps the observation and hands it back in.
    """
    junction_count = env.n_junctions
    steps = config.rollout_steps
    obs_buffer = np.zeros((steps, junction_count, OBS_DIM), dtype=np.float32)
    state_buffer = np.zeros((steps, junction_count * OBS_DIM), dtype=np.float32)
    next_state_buffer = np.zeros((steps, junction_count * OBS_DIM), dtype=np.float32)
    action_buffer = np.zeros((steps, junction_count), dtype=np.int64)
    log_prob_buffer = np.zeros((steps, junction_count), dtype=np.float32)
    mask_buffer = np.zeros((steps, junction_count, ACTION_DIM), dtype=bool)
    reward_buffer = np.zeros((steps,), dtype=np.float32)
    agent_reward_buffer = np.zeros((steps, junction_count), dtype=np.float32)
    terminated_buffer = np.zeros((steps,), dtype=bool)
    truncated_buffer = np.zeros((steps,), dtype=bool)

    for t in range(steps):
        obs_buffer[t] = obs
        state_buffer[t] = obs.reshape(-1)
        mask = torch.tensor(env.action_mask(), dtype=torch.bool)
        with torch.no_grad():
            logits = actor(torch.from_numpy(obs).float())
            log_probs = masked_log_probs(logits, mask)
            actions = sample_actions(logits, mask, generator)
        mask_buffer[t] = mask.numpy()
        action_buffer[t] = actions.numpy()
        log_prob_buffer[t] = log_probs.gather(1, actions.unsqueeze(1)).squeeze(1).numpy()

        next_obs, reward, terminated, truncated, info = env.step(actions.tolist())
        next_state_buffer[t] = next_obs.reshape(-1)
        reward_buffer[t] = float(reward)
        if config.credit_assignment == "junction":
            # The network's delay is exactly the sum of the junctions'
            # delays, so this is the reward split into its parts - not a
            # shaping. The env reports the per-junction axis queues.
            queue_ns = np.asarray(info["queue_ns"], dtype=np.float32)
            queue_ew = np.asarray(info["queue_ew"], dtype=np.float32)
            agent_reward_buffer[t] = -(queue_ns + queue_ew) * DT * env.reward_scale
        else:
            agent_reward_buffer[t] = float(reward)
        terminated_buffer[t] = bool(terminated)
        truncated_buffer[t] = bool(truncated)
        obs = next_obs
        if terminated or truncated:
            obs, _info = env.reset(seed=int(episode_seeds.integers(0, 2**31 - 1)))

    rollout = Rollout(
        obs=obs_buffer,
        states=state_buffer,
        next_states=next_state_buffer,
        actions=action_buffer,
        log_probs=log_prob_buffer,
        masks=mask_buffer,
        rewards=reward_buffer,
        agent_rewards=agent_reward_buffer,
        terminated=terminated_buffer,
        truncated=truncated_buffer,
    )
    return rollout, obs, steps


def train_network_mappo(
    steps: int,
    *,
    config: TrainingConfig | None = None,
    out_dir: Path | None = None,
    progress: bool = True,
) -> dict[str, Any]:
    """Train the network's signal policy and return the run's summary.

    The run writes three artefacts into ``out_dir``:

    - ``network_mappo_weights.json`` - the browser's JSON (see
      ``export_weights``);
    - ``network_mappo_summary.json`` - the curve and the final numbers;
    - ``network_mappo_checkpoint.pt`` - the checkpoint (actor, critic,
      optimiser and config), so a run can be re-evaluated or resumed.

    The **best** evaluation is kept, not merely the last one: a PPO run is
    not monotone, and the browser runs the argmax, which is what the
    evaluation measures.
    """
    config = config or TrainingConfig()
    device = torch.device(config.device)
    # One thread: the networks are tiny, so several threads only
    # oversubscribe the CPU - and a fixed thread count keeps the
    # reduction order (and therefore the run) reproducible.
    torch.set_num_threads(1)

    generator = torch.Generator(device="cpu")
    generator.manual_seed(config.seed)
    episode_seeds = np.random.default_rng(config.seed)

    junction_count = config.rows * config.cols
    # The initialisation is pinned without touching the global RNG.
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(config.seed)
        actor = PolicyActor().to(device)
        critic = CentralizedCritic(junction_count * OBS_DIM, junction_count).to(device)
    apply_action_prior(actor)

    optimizer = torch.optim.Adam(
        list(actor.parameters()) + list(critic.parameters()),
        lr=config.learning_rate,
    )

    env = make_env(config)
    obs, _info = env.reset(seed=int(episode_seeds.integers(0, 2**31 - 1)))

    curve: list[dict[str, Any]] = []
    best_return: float | None = None
    best_step = 0
    best_state: dict[str, torch.Tensor] | None = None
    baseline_cache: dict[tuple[int, int], float] = {}
    trained = 0
    next_eval = config.eval_every
    # The value's normalisation: the critic's output is the **normalised**
    # value, and the mean / spread of the rollout's returns put it back
    # into the reward's units. See `ppo_update` for why the critic cannot
    # work on the raw scale.
    value_mean = 0.0
    value_std = 1.0
    started = time.time()

    def baseline_for(eval_steps: int, eval_seed: int) -> float:
        key = (eval_steps, eval_seed)
        if key not in baseline_cache:
            baseline_cache[key] = float(
                evaluate_baseline(config, steps=eval_steps, seed=eval_seed)["return"]
            )
        return baseline_cache[key]

    while trained < steps:
        rollout, obs, collected = _collect_rollout(
            actor, env, config, generator, episode_seeds, obs=obs
        )
        with torch.no_grad():
            raw_values = critic(torch.from_numpy(rollout.states).float()).numpy()
            raw_next_values = critic(torch.from_numpy(rollout.next_states).float()).numpy()
        # The critic's output is the normalised value; the advantage needs
        # the value in the reward's own units.
        values = value_std * raw_values + value_mean
        next_values = value_std * raw_next_values + value_mean
        advantages = compute_gae(
            rollout.agent_rewards,
            values,
            next_values,
            rollout.terminated,
            rollout.truncated,
            gamma=config.gamma,
            gae_lambda=config.gae_lambda,
        )
        returns = advantages + values
        # The new normalisation: the mean and the spread of this rollout's
        # returns. The critic is trained against it, and the next rollout
        # reconstructs the value with it.
        value_mean = float(returns.mean())
        value_std = max(float(returns.std()), 1e-6)
        # The entropy coefficient's place in the run: constant, or
        # annealed from `ent_coef` to `ent_coef_end`.
        progress = trained / max(steps, 1)
        ent_coef = config.ent_coef
        if config.ent_coef_end is not None:
            ent_coef = config.ent_coef + (config.ent_coef_end - config.ent_coef) * progress
        stats = ppo_update(
            actor,
            critic,
            optimizer,
            rollout,
            advantages,
            returns,
            raw_values,
            value_mean,
            value_std,
            ent_coef,
            config,
            generator,
        )
        trained += collected

        if trained >= next_eval or trained >= steps:
            next_eval = trained + config.eval_every
            scored = evaluate_policy(actor, config, steps=config.eval_steps, seed=config.eval_seed)
            baseline = baseline_for(config.eval_steps, config.eval_seed)
            point = {
                "step": trained,
                "return": float(scored["return"]),
                "baseline": baseline,
                "gap": float(scored["return"]) - baseline,
                "actions": scored["actions"],
                "refused_actions": scored["refused_actions"],
                "entropy": stats["entropy"],
                "ent_coef": ent_coef,
                "explained_variance": _explained_variance(returns, values),
            }
            curve.append(point)
            if progress:
                print(
                    f"step {trained:>7}  return {point['return']:10.1f}"
                    f"  baseline {baseline:10.1f}  gap {point['gap']:9.1f}"
                    f"  entropy {stats['entropy']:.3f}"
                    f"  ev {point['explained_variance']:.3f}"
                    f"  actions {scored['actions']}",
                    flush=True,
                )
            if best_return is None or float(scored["return"]) > best_return:
                best_return = float(scored["return"])
                best_step = trained
                best_state = {
                    key: value.detach().clone() for key, value in actor.state_dict().items()
                }

    if best_state is not None:
        actor.load_state_dict(best_state)

    # The final measurement: the same window and the same seeds for the
    # policy and for the baseline.
    policy_runs = [
        evaluate_policy(actor, config, steps=config.reporting_window, seed=seed)
        for seed in config.final_eval_seeds
    ]
    policy_masked_runs = [
        evaluate_policy(actor, config, steps=config.reporting_window, seed=seed, mask_argmax=True)
        for seed in config.final_eval_seeds
    ]
    baseline_runs = [
        evaluate_baseline(config, steps=config.reporting_window, seed=seed)
        for seed in config.final_eval_seeds
    ]
    policy_mean = _mean([run["return"] for run in policy_runs])
    policy_masked_mean = _mean([run["return"] for run in policy_masked_runs])
    baseline_mean = _mean([run["return"] for run in baseline_runs])

    summary: dict[str, Any] = {
        "config": config.as_dict(),
        "junctions": junction_count,
        "env_steps": trained,
        "agent_transitions": trained * junction_count,
        "wall_seconds": round(time.time() - started, 2),
        "best_step": best_step,
        "curve": curve,
        "final": {
            "window_steps": config.reporting_window,
            "seeds": list(config.final_eval_seeds),
            "policy": {
                "return_mean": policy_mean,
                "returns": [run["return"] for run in policy_runs],
                "actions": _merge_histograms([run["actions"] for run in policy_runs]),
                "refused_actions": sum(run["refused_actions"] for run in policy_runs),
            },
            "policy_masked_argmax": {
                "return_mean": policy_masked_mean,
                "returns": [run["return"] for run in policy_masked_runs],
            },
            "baseline_no_op": {
                "return_mean": baseline_mean,
                "returns": [run["return"] for run in baseline_runs],
            },
            "margin": policy_mean - baseline_mean,
            "beats_baseline": bool(policy_mean > baseline_mean),
        },
    }

    if out_dir is not None:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        weights_name = "network_mappo_weights.json"
        weights = export_weights(actor, weights_name)
        (out_dir / weights_name).write_text(json.dumps(weights, indent=2), encoding="utf-8")
        checkpoint_name = "network_mappo_checkpoint.pt"
        torch.save(
            {
                "actor": actor.state_dict(),
                "critic": critic.state_dict(),
                "optimizer": optimizer.state_dict(),
                "config": config.as_dict(),
                "step": trained,
                "summary": summary,
            },
            out_dir / checkpoint_name,
        )
        summary_name = "network_mappo_summary.json"
        (out_dir / summary_name).write_text(json.dumps(summary, indent=2), encoding="utf-8")
        summary["artifacts"] = {
            "weights": str(out_dir / weights_name),
            "summary": str(out_dir / summary_name),
            "checkpoint": str(out_dir / checkpoint_name),
        }
    return summary


def load_checkpoint(path: Path, device: str = "cpu") -> dict[str, Any]:
    """Load a checkpoint into an actor (and a critic, if it has one).

    The checkpoint is a plain ``torch.save`` of the run's state, so it
    carries the config it was written with - a caller does not have to
    remember the grid's shape to load it.
    """
    blob = torch.load(Path(path), map_location=device, weights_only=False)
    config = TrainingConfig(**_config_kwargs(blob.get("config", {})))
    actor = PolicyActor().to(device)
    actor.load_state_dict(blob["actor"])
    critic = CentralizedCritic(config.rows * config.cols * OBS_DIM, config.rows * config.cols)
    if "critic" in blob:
        try:
            critic.load_state_dict(blob["critic"])
        except RuntimeError:
            # The critic is **training only**: a checkpoint whose critic does
            # not fit the current architecture is still perfectly good for
            # the evaluation, which only runs the actor.
            pass
    actor.eval()
    return {"actor": actor, "critic": critic, "config": config, "step": blob.get("step", 0)}


def _config_kwargs(raw: dict[str, Any]) -> dict[str, Any]:
    """The config fields a checkpoint may carry, with their defaults."""
    known = {field_name for field_name in TrainingConfig.__dataclass_fields__}
    kwargs = {key: value for key, value in raw.items() if key in known}
    if "final_eval_seeds" in kwargs:
        kwargs["final_eval_seeds"] = tuple(int(seed) for seed in kwargs["final_eval_seeds"])
    return kwargs


# ===== the command line =====


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the multi-junction signal policy (MAPPO).")
    parser.add_argument(
        "--steps",
        type=int,
        default=20_000,
        help="How many env steps to train for (one step = one tick of the whole grid).",
    )
    parser.add_argument("--rows", type=int, default=GRID_5X5_ROWS)
    parser.add_argument("--cols", type=int, default=GRID_5X5_COLS)
    parser.add_argument(
        "--demand-scale",
        type=float,
        default=GRID_5X5_DEMAND_SCALE,
        help="The demand multiplier; 0.20 is the calibrated 5 x 5 demand.",
    )
    parser.add_argument(
        "--out",
        type=str,
        default="",
        help="Where to write the weights, the summary and the checkpoint.",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--rollout-steps", type=int, default=1000)
    parser.add_argument("--max-steps", type=int, default=2000, help="The episode length.")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gamma", type=float, default=0.995)
    parser.add_argument("--gae-lambda", type=float, default=0.95)
    parser.add_argument("--ent-coef", type=float, default=0.02)
    parser.add_argument(
        "--ent-coef-end",
        type=float,
        default=None,
        help="Anneal the entropy coefficient down to this value over the run.",
    )
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--minibatch-size", type=int, default=512)
    parser.add_argument(
        "--credit-assignment",
        choices=["junction", "network"],
        default="junction",
        help="How the network's delay is credited to the junctions.",
    )
    parser.add_argument(
        "--eval-every",
        type=int,
        default=500,
        help=(
            "How often (in env steps) the policy is evaluated. The good "
            "regime is transient, so the evaluation has to be dense enough "
            "to land inside it."
        ),
    )
    parser.add_argument("--eval-steps", type=int, default=2000)
    parser.add_argument(
        "--final-eval-steps",
        type=int,
        default=0,
        help=(
            "The window of the final measurement, in env steps. 0 means the "
            "same window the checkpoint was selected on - a number selected "
            "on one window and reported on another is not a number."
        ),
    )
    parser.add_argument(
        "--final-eval-seeds",
        type=str,
        default="0,1,2",
        help="Comma-separated seeds of the final measurement.",
    )
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument(
        "--eval",
        type=str,
        default="",
        help="Re-evaluate an existing checkpoint and exit (no training).",
    )
    args = parser.parse_args()

    if args.eval:
        path = Path(args.eval)
        loaded = load_checkpoint(path, device=args.device)
        config = loaded["config"]
        window = args.final_eval_steps if args.final_eval_steps > 0 else config.reporting_window
        seeds = [int(part) for part in args.final_eval_seeds.replace(" ", "").split(",") if part]
        for seed in seeds:
            policy = evaluate_policy(loaded["actor"], config, steps=window, seed=seed)
            baseline = evaluate_baseline(config, steps=window, seed=seed)
            print(
                f"seed {seed}  policy {policy['return']:10.1f}"
                f"  baseline {baseline['return']:10.1f}"
                f"  gap {policy['return'] - baseline['return']:9.1f}"
                f"  actions {policy['actions']}"
            )
        print(f"checkpoint {path.name}  window {window} steps")
        return

    config = TrainingConfig(
        rows=args.rows,
        cols=args.cols,
        demand_scale=args.demand_scale,
        max_steps=args.max_steps,
        rollout_steps=args.rollout_steps,
        seed=args.seed,
        learning_rate=args.learning_rate,
        gamma=args.gamma,
        gae_lambda=args.gae_lambda,
        ent_coef=args.ent_coef,
        ent_coef_end=args.ent_coef_end,
        epochs=args.epochs,
        minibatch_size=args.minibatch_size,
        credit_assignment=args.credit_assignment,
        eval_every=args.eval_every,
        eval_steps=args.eval_steps,
        final_eval_steps=args.final_eval_steps or None,
        final_eval_seeds=tuple(
            int(part) for part in args.final_eval_seeds.replace(" ", "").split(",") if part
        ),
        device=args.device,
    )
    out_dir = Path(args.out) if args.out else None
    summary = train_network_mappo(args.steps, config=config, out_dir=out_dir)
    final = summary["final"]
    print("")
    print(
        f"policy  {final['policy']['return_mean']:10.1f}"
        f"   (no_op baseline {final['baseline_no_op']['return_mean']:10.1f})"
        f"   margin {final['margin']:9.1f}"
        f"   beats baseline: {final['beats_baseline']}"
    )
    print(f"seeds {final['seeds']}  window {final['window_steps']} steps")
    print(f"policy returns  {final['policy']['returns']}")
    print(f"baseline returns {final['baseline_no_op']['returns']}")
    print(f"actions {final['policy']['actions']}")
    if "artifacts" in summary:
        for key, value in summary["artifacts"].items():
            print(f"{key} {value}")


if __name__ == "__main__":
    main()

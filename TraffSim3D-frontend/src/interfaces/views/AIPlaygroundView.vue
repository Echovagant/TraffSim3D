<template>
  <main class="ai-playground">
    <router-link to="/" class="back-link">← 返回首页</router-link>

    <header class="header">
      <span class="badge">PPO</span>
      <h1>AI Proving Ground</h1>
      <p class="sub">Gymnasium + PPO 训练单智能体通过 4-way 路口</p>
    </header>

    <section class="card">
      <h2>训练控制</h2>
      <div class="control-row">
        <label class="ctrl">
          步数
          <input
            v-model.number="steps"
            type="number"
            min="100"
            max="100000"
            step="100"
            data-testid="train-steps-input"
          />
        </label>
        <label class="ctrl">
          设备
          <select v-model="device" data-testid="device-select">
            <option value="auto">自动 (推荐)</option>
            <option value="gpu" :disabled="!gpuAvailable">
              GPU ({{ gpuDeviceName || '不可用' }})
            </option>
            <option value="cpu">CPU</option>
          </select>
        </label>
        <label class="ctrl">
          Agent 数
          <input
            v-model.number="nAgents"
            type="number"
            min="1"
            max="8"
            step="1"
            data-testid="n-agents-input"
          />
        </label>
        <label class="ctrl">
          场景
          <select v-model="sceneKind" data-testid="scene-kind-select">
            <option value="cross">单路口</option>
            <option value="corridor">走廊 (2 路口)</option>
            <option value="t_junction">T 型路口</option>
            <option value="roundabout">环形路口</option>
          </select>
        </label>
        <label class="ctrl">
          <input
            v-model="independentAgents"
            type="checkbox"
            data-testid="independent-agents-checkbox"
          />
          独立训练 (per-agent PPO)
        </label>
        <label class="ctrl">
          <input v-model="curriculumMode" type="checkbox" data-testid="curriculum-checkbox" />
          课程学习 (cross → T → 环形 → 走廊)
        </label>
        <label class="ctrl">
          <input v-model="dryRun" type="checkbox" data-testid="dry-run-checkbox" />
          Dry-run 演示 (不执行 PPO, 曲线为合成数据)
        </label>
        <button
          class="primary"
          :disabled="running"
          data-testid="start-train-button"
          @click="onStart"
        >
          {{ running ? '训练中…' : '开始训练' }}
        </button>
        <button
          class="ghost"
          :disabled="running"
          data-testid="refresh-status-button"
          @click="refreshStatus"
        >
          刷新
        </button>
        <button class="ghost" data-testid="list-checkpoints-button" @click="listCheckpoints">
          列出 checkpoints
        </button>
        <button
          class="ghost"
          :disabled="checkpoints.length === 0"
          data-testid="prune-checkpoints-button"
          @click="pruneCheckpoints"
        >
          清理旧 checkpoints
        </button>
      </div>
      <p v-if="capabilitiesNote" class="cap-note" data-testid="cap-note">
        {{ capabilitiesNote }}
      </p>
      <p v-if="error" class="err" data-testid="train-error">{{ error }}</p>
    </section>

    <section class="card">
      <h2>训练指标</h2>
      <div class="metrics">
        <div class="metric">
          <span>总步数</span><strong data-testid="metric-step">{{ status.step }}</strong>
        </div>
        <div class="metric">
          <span>Episode</span
          ><strong data-testid="metric-episode">{{ status.episode_count }}</strong>
        </div>
        <div class="metric">
          <span>Agent 数</span
          ><strong data-testid="metric-n-agents">{{ status.n_agents ?? '—' }}</strong>
        </div>
        <div class="metric">
          <span>设备</span><strong data-testid="metric-device">{{ status.device || '—' }}</strong>
        </div>
        <div class="metric">
          <span>场景</span><strong data-testid="metric-scene">{{ sceneLabel }}</strong>
        </div>
        <div class="metric">
          <span>最近 reward</span
          ><strong data-testid="metric-last-reward">{{
            formatNumber(status.last_reward, 2)
          }}</strong>
        </div>
        <div class="metric metric-wide">
          <span>最新 checkpoint</span>
          <strong data-testid="metric-checkpoint" :title="status.latest_checkpoint || ''">
            {{ status.latest_checkpoint || '—' }}
          </strong>
          <span
            v-if="isDryRun && status.latest_checkpoint"
            class="dry-badge"
            data-testid="checkpoint-dry-run-badge"
            >dry-run 合成文件名</span
          >
        </div>
        <div class="metric metric-wide">
          <span>结束原因 (reason)</span>
          <strong class="reason-text" data-testid="metric-reason">{{
            status.reason || '—'
          }}</strong>
        </div>
        <div class="metric metric-wide">
          <span>状态</span>
          <strong data-testid="metric-running">{{ status.running ? '运行中' : '已结束' }}</strong>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>
        Reward 曲线
        <span class="muted small">{{
          isDryRun ? '（dry-run 合成数据 · 非真实回报）' : '（逐 episode 采样回报 · 含噪声）'
        }}</span>
      </h2>
      <p v-if="runProvenance" class="prov" :class="runProvenance.tone" data-testid="run-provenance">
        {{ runProvenance.text }}
      </p>
      <div v-if="status.reward_history.length === 0" class="muted">
        暂无数据 — 点击"开始训练"以生成样本。
      </div>
      <svg
        v-else
        :viewBox="`0 0 ${chartW} ${chartH}`"
        :width="chartW"
        :height="chartH"
        class="chart"
        data-testid="reward-chart"
        preserveAspectRatio="none"
      >
        <!-- When independent_agents, draw one polyline per agent -->
        <template v-if="hasAgentRewards">
          <polyline
            v-for="(color, agentId) in agentColors"
            :key="`agent-${agentId}`"
            :points="pointsForAgent(agentId)"
            fill="none"
            :stroke="color"
            stroke-width="2"
            :data-testid="`reward-line-agent-${agentId}`"
          />
        </template>
        <polyline
          v-else
          :points="rewardPoints"
          fill="none"
          stroke="#34d399"
          stroke-width="2"
          data-testid="reward-line"
        />
        <line
          :x1="0"
          :y1="chartH - 1"
          :x2="chartW"
          :y2="chartH - 1"
          stroke="#475569"
          stroke-width="0.5"
        />
      </svg>
      <p v-if="status.reward_history.length > 0" class="muted small">
        {{ status.reward_history.length }} 个 episode · max {{ formatNumber(maxReward, 2) }} · min
        {{ formatNumber(minReward, 2) }}
      </p>
      <p
        v-if="status.reward_history.length > 0"
        class="muted small"
        data-testid="reward-curve-note"
      >
        <template v-if="isDryRun">
          这是 dry-run <strong>合成</strong>的曲线 —— 按构造生成，与策略学习无关，不能读作学习效果。
        </template>
        <template v-else>
          这是训练时随机策略<strong>采样</strong>得到的逐 episode
          回报，噪声大、口径与下面的评估曲线不同 —— 它不能与固定周期基线比较，也不能与评估回报比较。
        </template>
      </p>
    </section>

    <!-- The comparison curve — the policy's deterministic
         evaluation return against the training step, next to the
         fixed-cycle baseline it has to beat. -->
    <section v-if="evalSeries.length > 0" class="card">
      <h2>评估回报 vs 固定周期基线</h2>
      <p class="muted small" data-testid="eval-curve-condition">
        条件: <strong>{{ evalConditionLabel }}</strong> · 确定性评估 (argmax) 的回报 · 基线 =
        该条件下实测的固定 30/30 周期 {{ formatNumber(evalBaseline, 1) }} · 横轴 = 训练步数, 纵轴 =
        回报 (越大越好)
      </p>
      <svg
        :viewBox="`0 0 ${EVAL_CHART.width} ${EVAL_CHART.height}`"
        :width="EVAL_CHART.width"
        :height="EVAL_CHART.height"
        class="chart"
        data-testid="eval-curve-chart"
        preserveAspectRatio="none"
      >
        <!-- the bar the policy has to clear -->
        <line
          :x1="EVAL_CHART.padLeft"
          :y1="evalGeometry.baselineY"
          :x2="EVAL_CHART.width - EVAL_CHART.padRight"
          :y2="evalGeometry.baselineY"
          stroke="#fb7185"
          stroke-width="1.5"
          stroke-dasharray="6 4"
          data-testid="eval-baseline-line"
        />
        <!-- the policy's evaluation return -->
        <polyline
          :points="evalGeometry.line"
          fill="none"
          stroke="#60a5fa"
          stroke-width="2"
          data-testid="eval-curve-line"
        />
        <!-- the part above the baseline: "the policy beat it", marked -->
        <g data-testid="eval-curve-above">
          <polyline
            v-for="(segment, index) in evalGeometry.above"
            :key="index"
            :points="segment"
            fill="none"
            stroke="#34d399"
            stroke-width="3"
            :data-testid="`eval-curve-above-segment-${index}`"
          />
        </g>
        <!-- axis labels -->
        <text
          :x="EVAL_CHART.padLeft"
          :y="EVAL_CHART.height - 8"
          fill="#94a3b8"
          font-size="10"
          data-testid="eval-axis-step-min"
        >
          {{ evalStepMin }}
        </text>
        <text
          :x="EVAL_CHART.width - EVAL_CHART.padRight"
          :y="EVAL_CHART.height - 8"
          fill="#94a3b8"
          font-size="10"
          text-anchor="end"
          data-testid="eval-axis-step-max"
        >
          {{ evalStepMax }}
        </text>
        <text
          :x="4"
          :y="EVAL_CHART.padTop + 4"
          fill="#94a3b8"
          font-size="10"
          data-testid="eval-axis-return-max"
        >
          {{ formatNumber(evalGeometry.domain.hi, 0) }}
        </text>
        <text
          :x="4"
          :y="EVAL_CHART.height - EVAL_CHART.padBottom"
          fill="#94a3b8"
          font-size="10"
          data-testid="eval-axis-return-min"
        >
          {{ formatNumber(evalGeometry.domain.lo, 0) }}
        </text>
        <text
          :x="EVAL_CHART.padLeft + 4"
          :y="evalGeometry.baselineY - 4"
          fill="#fb7185"
          font-size="10"
          data-testid="eval-baseline-label"
        >
          基线 {{ formatNumber(evalBaseline, 1) }}
        </text>
      </svg>
      <p v-if="evalGeometry.above.length > 0" class="muted small" data-testid="eval-curve-verdict">
        ✓ 评估回报曾高于基线 {{ formatNumber(evalAboveMargin, 1) }} 分 — 绿色区段就是基线以上的部分
      </p>
      <p v-else class="muted small" data-testid="eval-curve-verdict">
        ✗ 评估回报从未高于基线 — 该策略没有打败固定 30/30 周期
      </p>
    </section>

    <!-- The multi-seed table. Every seed is on the table — the
         ones that collapsed back onto `no_op` included, because the ~50 %
         success rate is only honest if the failures are visible. -->
    <section v-if="signalSeedResults.length > 0" class="card">
      <h2>多种子结果 (best-of-N)</h2>
      <p class="muted small" data-testid="seed-summary">
        {{ seedBeatenCount }}/{{ signalSeedResults.length }} 个种子在训练条件上打败了固定周期基线
        (成功率 {{ formatNumber(seedSuccessRate, 0) }}%) · 固定周期基线: 训练
        {{ trainBaseline === null ? '—' : formatNumber(trainBaseline, 1) }} · 留出评估
        {{ evalConditionBaseline === null ? '—' : formatNumber(evalConditionBaseline, 1) }}
      </p>
      <table class="seed-table" data-testid="signal-seed-table">
        <thead>
          <tr>
            <th>种子</th>
            <th>训练条件回报</th>
            <th>留出评估条件回报</th>
            <th>打败基线 (训练)</th>
            <th>打败基线 (评估)</th>
            <th>动作分布 (训练条件)</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="record in signalSeedResults"
            :key="record.seed"
            data-testid="signal-seed-row"
            :data-seed="record.seed"
          >
            <td>
              <span data-testid="seed-value-seed">{{ record.seed }}</span>
              <span
                v-if="isCollapsedSeed(record)"
                class="collapsed-badge"
                data-testid="seed-collapsed-badge"
                >塌缩 no_op</span
              >
            </td>
            <td data-testid="seed-value-train">{{ formatNumber(record.train_return, 1) }}</td>
            <td data-testid="seed-value-eval">{{ formatNumber(record.eval_return, 1) }}</td>
            <td data-testid="seed-value-beats-train">
              {{ record.beats_train_baseline ? '✅' : '❌' }}
            </td>
            <td data-testid="seed-value-beats-eval">{{ record.beats_baseline ? '✅' : '❌' }}</td>
            <td data-testid="seed-value-actions">{{ formatActionMix(record.train_actions) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="generalisationGap" class="muted small" data-testid="generalisation-gap">
        泛化差距 (种子 {{ bestSeedRecord?.seed }}) — 训练条件:
        {{ marginPhrase(generalisationGap.train) }} · 留出评估条件:
        {{ marginPhrase(generalisationGap.eval) }} · 在没训过的初始条件上，优势并不等量迁移。
      </p>
      <p
        v-if="status.signal_holdout_return !== undefined"
        class="muted small"
        data-testid="holdout-note"
      >
        最终留出条件 (holdout, 从未用于选优): {{ formatNumber(status.signal_holdout_return, 1) }}
      </p>
    </section>

    <section v-if="checkpoints.length > 0 || checkpointsVisible" class="card">
      <h2>Checkpoints</h2>
      <p v-if="checkpoints.length === 0" class="muted">暂无 checkpoint — 跑一次训练试试。</p>
      <ul v-else class="ckpt-list" data-testid="ckpt-list">
        <li v-for="c in checkpoints" :key="c.name">
          <code data-testid="ckpt-name">{{ c.name }}</code>
          <span class="ckpt-meta"
            >{{ c.process }} · {{ c.size_kb }} KB · {{ formatTime(c.mtime_ms) }}</span
          >
        </li>
      </ul>
    </section>

    <!-- RL replay surface — load a trained PPO checkpoint
         and watch it drive one of the sim vehicles in the editor. -->
    <section class="card">
      <h2>策略部署 (Replay)</h2>
      <div class="control-row">
        <label class="ctrl">
          Checkpoint
          <select v-model="replayCkptName" data-testid="ckpt-replay-select">
            <option value="">— 选择 —</option>
            <option v-for="c in checkpoints" :key="c.name" :value="c.name">
              {{ c.name }} · {{ c.size_kb }}KB
            </option>
          </select>
        </label>
        <button
          class="ghost"
          :disabled="!replayCkptName || policyLoading"
          data-testid="load-policy-button"
          @click="onLoadPolicy"
        >
          {{ policyLoading ? '加载中…' : '加载' }}
        </button>
        <button
          class="ghost"
          :disabled="!world.policy"
          data-testid="clear-policy-button"
          @click="onClearPolicy"
        >
          清除
        </button>
      </div>
      <p class="muted small" data-testid="policy-status">
        <template v-if="world.policy">
          ✓ 已加载 <code>{{ world.policy.name }}</code> ({{ world.policy.obs_dim }} obs /
          {{ world.policy.action_dim }} act)
        </template>
        <template v-else>未加载 — 先跑一次训练,再选 checkpoint 加载。</template>
      </p>

      <div class="control-row">
        <label class="ctrl">
          目标车辆
          <select v-model="replayTarget" data-testid="replay-target-select">
            <option v-for="vid in availableVehicles" :key="vid" :value="vid">
              {{ vid }}
            </option>
          </select>
        </label>
        <button
          class="primary"
          :disabled="!canStartReplay"
          data-testid="start-replay-button"
          @click="onStartReplay"
        >
          ▶ 开始回放
        </button>
        <button
          class="ghost"
          :disabled="!replayActive"
          data-testid="stop-replay-button"
          @click="onStopReplay"
        >
          ⏸ 停止
        </button>
      </div>

      <div class="replay-status" data-testid="replay-status">
        <div class="metric-row">
          <span>状态</span>
          <strong data-testid="replay-state">{{
            replayActive ? '运行中' : world.policy ? '已加载 (待启动)' : '未加载'
          }}</strong>
        </div>
        <div class="metric-row">
          <span>Replayed steps</span>
          <strong data-testid="replay-step">{{ replayStep }}</strong>
        </div>
      </div>

      <details v-if="replayLastObs.length > 0" class="replay-detail">
        <summary>最近 obs / action</summary>
        <p class="muted small">obs (14-dim):</p>
        <code data-testid="replay-obs" class="obs">{{ formatObs(replayLastObs) }}</code>
        <p class="muted small">action (2-dim):</p>
        <code data-testid="replay-action" class="obs">{{ formatAction(replayLastAction) }}</code>
      </details>
      <p v-if="error" class="err" data-testid="replay-error">{{ error }}</p>
    </section>

    <!-- The signal agent — a *discrete* five-action policy
         that commands the traffic light instead of driving a vehicle.
         The readout below is what makes "the AI is commanding" visible
         instead of a claim. -->
    <section class="card">
      <h2>AI 指挥信号灯</h2>
      <div class="control-row">
        <label class="ctrl">
          信号灯 checkpoint
          <select v-model="signalCkptName" data-testid="signal-ckpt-select">
            <option value="">— 选择 —</option>
            <option v-for="c in checkpoints" :key="c.name" :value="c.name">
              {{ c.name }} · {{ c.size_kb }}KB
            </option>
          </select>
        </label>
        <button
          class="ghost"
          :disabled="!signalCkptName || signalPolicyLoading"
          data-testid="load-signal-policy-button"
          @click="onLoadSignalPolicy"
        >
          {{ signalPolicyLoading ? '加载中…' : '加载' }}
        </button>
        <button
          class="ghost"
          :disabled="!world.signalPolicy"
          data-testid="clear-signal-policy-button"
          @click="onClearSignalPolicy"
        >
          清除
        </button>
        <label class="ctrl">
          <input
            v-model="rlControlsSignal"
            type="checkbox"
            data-testid="rl-signal-controller-checkbox"
            @change="onToggleRlSignal"
          />
          用 RL 策略指挥信号灯
        </label>
      </div>
      <p class="muted small" data-testid="signal-policy-status">
        <template v-if="world.signalPolicy">
          ✓ 已加载 <code>{{ world.signalPolicy.name }}</code> ({{ world.signalPolicy.obs_dim }} obs
          / {{ world.signalPolicy.action_dim }} act · 离散)
        </template>
        <template v-else
          >未加载 — 训练一次信号灯 agent (python -m app.apps.rl.signal_train) 再加载。</template
        >
      </p>

      <div class="replay-status" data-testid="signal-policy-readout">
        <div class="metric-row">
          <span>当前动作</span>
          <strong data-testid="signal-policy-action">{{ signalActionLabel }}</strong>
        </div>
        <div class="metric-row">
          <span>NS 队列</span>
          <strong data-testid="signal-policy-queue-ns">{{ signalQueueNs }}</strong>
        </div>
        <div class="metric-row">
          <span>EW 队列</span>
          <strong data-testid="signal-policy-queue-ew">{{ signalQueueEw }}</strong>
        </div>
      </div>
      <p v-if="signalError" class="err" data-testid="signal-policy-error">{{ signalError }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * AI Playground — single-agent training dashboard.
 * Checkpoint management UI.
 * Per-agent reward rendering.
 * Scene-kind selector.
 * RL replay surface — load a PPO checkpoint and drive one
 *   vehicle in the TS sim from the policy's actions.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showFlashMessage } from '@interfaces/composables/useFlashMessage'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { buildEvalCurve, type EvalPoint } from './trainingCurve'

/** One point of the backend's evaluation series. */
type SignalEvalPoint = EvalPoint

/** One seed's measured result (the collapsed ones included). */
interface SignalSeedResult {
  seed: number
  train_return: number
  train_actions: Record<string, number>
  beats_train_baseline: boolean
  eval_return: number
  eval_actions: Record<string, number>
  beats_baseline: boolean
  best_step: number
  checkpoint: string
  eval_series?: SignalEvalPoint[]
}

interface Status {
  running: boolean
  /** Whether the live run is paused (the pause/resume control channel). */
  paused?: boolean
  step: number
  /** The step budget the run was started with. */
  total_steps?: number
  episode_count: number
  last_reward: number
  reward_history: number[]
  started_at_ms: number
  finished_at_ms: number | null
  /** The backend's own verdict on the run — how it ended, and whether it
   *  was a dry run. `dry_run*` reasons mean no PPO ever ran. */
  reason?: string
  device?: string
  device_reason?: string
  n_agents?: number
  independent_agents?: boolean
  scene_kind?: string
  latest_checkpoint?: string
  /** 'signal' when the signal-light agent wrote this status. */
  policy_kind?: string
  /** Per-agent reward history (only when independent_agents=true).
   *  Keys are stringified int agent_ids ("0", "1", ...). */
  agent_rewards?: Record<string, number[]>
  /** The evaluation series — one point per evaluation. */
  signal_eval_series?: SignalEvalPoint[]
  /** The fixed 30/30 cycle per condition (train / eval / holdout). */
  signal_baselines?: Record<string, number>
  /** Every seed's measured result — the collapsed ones included. */
  signal_seed_results?: SignalSeedResult[]
  /** The seed the best-of-N selection picked. */
  best_seed?: number
  /** The winner's return on the final, never-selected condition. */
  signal_holdout_return?: number
  /** The fixed 30/30 cycle on the training condition. */
  baseline_no_op_return?: number
  /** The fixed 30/30 cycle on the held-out evaluation condition. */
  signal_eval_baseline?: number
}

interface Checkpoint {
  name: string
  process: string
  size_kb: number
  mtime_ms: number
}

interface Capabilities {
  torch_version: string
  cuda_available: boolean
  device_count: number
  device_name: string
  vram_gb: number
  sb3_available: boolean
  min_vram_gb: number
  device_fallback_reason: string
}

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000'

const steps = ref(200)
const nAgents = ref(2)
const sceneKind = ref<'cross' | 'corridor' | 't_junction' | 'roundabout'>('cross')
const independentAgents = ref(false)
const curriculumMode = ref(false)
const device = ref<'auto' | 'gpu' | 'cpu'>('auto')
/**
 * The primary action must be a **real** training run.
 *
 * The dry-run path fabricates its reward series (`(0.5 + 0.5i + 0.1·sin i)`
 * by construction), so it may only ever be an explicit opt-in.
 */
const dryRun = ref(false)
const running = ref(false)
const error = ref<string | null>(null)
const status = ref<Status>({
  running: false,
  step: 0,
  episode_count: 0,
  last_reward: 0,
  reward_history: [],
  started_at_ms: 0,
  finished_at_ms: null,
  n_agents: undefined,
  latest_checkpoint: '',
})

const checkpoints = ref<Checkpoint[]>([])
const checkpointsVisible = ref(false)

const caps = ref<Capabilities | null>(null)

interface TrainingConfig {
  algorithms: string[]
  scenes: string[]
  devices: string[]
  hyperparameters: Record<string, { default: number; min: number; max: number; step: number }>
  training: Record<string, { default: number; min: number; max: number; step: number }>
  agents: {
    n_agents: { default: number; min: number; max: number; step: number }
    independent: { default: boolean }
  }
}
const trainingConfig = ref<TrainingConfig | null>(null)

const refreshTrainingConfig = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/training-config`)
    if (!r.ok) return
    trainingConfig.value = (await r.json()) as TrainingConfig
  } catch {
    // Backend unavailable — leave null, UI falls back to hardcoded defaults
  }
}

// RL replay state. The store owns the loaded policy; this
// view just collects the user's intent (which checkpoint, which target)
// and pipes actions to the store.
const world = useWorldStore()
const replayActive = computed(() => world.replayActive)
const replayStep = computed(() => world.replayStep)
const replayLastObs = computed(() => world.replayLastObs)
const replayLastAction = computed(() => world.replayLastAction)

const replayCkptName = ref('')
const replayTarget = ref('v-1')
const policyLoading = ref(false)
const replayError = ref<string | null>(null)

// Read available vehicle IDs from the world store's network (the
// dev hook `window.__world` mirrors it; not used here — Pinia store
// is the source of truth). Refreshed on mount + whenever `tickCount`
// changes (so adding/removing vehicles updates the dropdown).
const availableVehicles = computed<string[]>(() => {
  // Reading tickCount establishes a reactive dep, so this re-evaluates
  // on network mutations.
  void world.tickCount
  return Object.keys(world.network.vehicles).sort()
})

const canStartReplay = computed(
  () => Boolean(world.policy) && Boolean(replayTarget.value) && !replayActive.value,
)

const onLoadPolicy = async (): Promise<void> => {
  replayError.value = null
  if (!replayCkptName.value) return
  policyLoading.value = true
  try {
    const r = await world.loadPolicy(replayCkptName.value)
    if (!r.ok) {
      replayError.value = r.reason
      showFlashMessage(`加载失败: ${r.reason}`, 'error')
      return
    }
    showFlashMessage(`策略已加载: ${replayCkptName.value}`, 'info')
  } finally {
    policyLoading.value = false
  }
}

const onStartReplay = (): void => {
  replayError.value = null
  world.setReplayTarget(replayTarget.value)
  const r = world.startReplay()
  if (!r.ok) {
    replayError.value = r.reason
    showFlashMessage(`回放启动失败: ${r.reason}`, 'error')
    return
  }
  showFlashMessage(`开始回放 — 目标: ${replayTarget.value}`, 'info')
}

const onStopReplay = (): void => {
  world.stopReplay()
  showFlashMessage('回放已停止', 'info')
}

const onClearPolicy = (): void => {
  world.clearPolicy()
  replayCkptName.value = ''
  showFlashMessage('策略已清除', 'info')
}

// ===== the signal agent =====
//
// A second, different policy: the signal agent's (discrete, 5 actions,
// 6 observations) as opposed to the ego agent's (continuous, 2 actions,
// 14 observations). It commands the traffic light; the readout below shows
// what it decided and what it saw.

const signalCkptName = ref('')
const signalPolicyLoading = ref(false)
const signalError = ref<string | null>(null)
const rlControlsSignal = ref(false)

const signalActionLabel = computed(() => world.signalPolicyDecision?.action ?? '—')
const signalQueueNs = computed(() => world.signalPolicyDecision?.queueNs ?? '—')
const signalQueueEw = computed(() => world.signalPolicyDecision?.queueEw ?? '—')

const onLoadSignalPolicy = async (): Promise<void> => {
  signalError.value = null
  if (!signalCkptName.value) return
  signalPolicyLoading.value = true
  try {
    const r = await world.loadSignalPolicy(signalCkptName.value)
    if (!r.ok) {
      signalError.value = r.reason
      showFlashMessage(`信号灯策略加载失败: ${r.reason}`, 'error')
      return
    }
    showFlashMessage(`信号灯策略已加载: ${signalCkptName.value}`, 'info')
  } finally {
    signalPolicyLoading.value = false
  }
}

const onClearSignalPolicy = (): void => {
  world.clearSignalPolicy()
  signalCkptName.value = ''
  rlControlsSignal.value = false
  showFlashMessage('信号灯策略已清除', 'info')
}

const onToggleRlSignal = (): void => {
  world.setControllerKind(rlControlsSignal.value ? 'rl' : 'actuated')
  showFlashMessage(rlControlsSignal.value ? '信号灯由 RL 策略指挥' : '信号灯回到定时控制', 'info')
}

const formatObs = (obs: readonly number[]): string => obs.map((x) => x.toFixed(3)).join(', ')
const formatAction = (a: readonly [number, number]): string =>
  `accel=${a[0].toFixed(3)}, steer=${a[1].toFixed(3)}`
const gpuAvailable = computed(() => caps.value?.cuda_available === true)
const gpuDeviceName = computed(() => caps.value?.device_name ?? '')
const capabilitiesNote = computed(() => {
  const c = caps.value
  if (!c) return '检测后端能力中…'
  if (!c.sb3_available) {
    return '⚠ stable-baselines3 未安装：训练会退化为 dry-run（界面会标注"未执行 PPO"），不会产出真实策略。'
  }
  if (!c.cuda_available) {
    return `ℹ 未检测到 CUDA（torch ${c.torch_version || '未装'}），将使用 CPU。`
  }
  if (c.vram_gb < c.min_vram_gb) {
    return `⚠ GPU 显存仅 ${c.vram_gb.toFixed(1)} GB < ${c.min_vram_gb} GB 阈值，auto 会 fallback CPU。`
  }
  return `✓ GPU 可用: ${c.device_name} (${c.vram_gb.toFixed(1)} GB)`
})

// ===== the run's provenance ================================================
//
// The curve on screen is only meaningful together with **where it came
// from**. The backend says so in two independent places: the resolved
// device is `dry_run` when stable-baselines3 is missing, and the final
// `reason` is `dry_run*` on every synthetic path. The UI must never
// present a synthetic series as a learning curve — so a run counts as a
// dry run if *either* signal says so, and only a run that says neither
// is presented as a real training run.

const SCENE_LABELS: Record<string, string> = {
  cross: '单路口',
  corridor: '走廊 (2 路口)',
  t_junction: 'T 型路口',
  roundabout: '环形路口',
  cross_signalled: '信号灯路口',
}

const sceneLabel = computed(() => {
  const kind = status.value.scene_kind
  if (!kind) return '—'
  return SCENE_LABELS[kind] ?? kind
})

/** True when the run on screen never executed PPO. */
const isDryRun = computed<boolean>(() => {
  const s = status.value
  if (s.device === 'dry_run') return true
  return (s.reason ?? '').startsWith('dry_run')
})

interface Provenance {
  tone: 'warn' | 'ok'
  text: string
}

/**
 * One honest line about where the curve came from.
 *
 * Nothing is claimed beyond what the backend's own status says: a dry run
 * is labelled as synthetic, a real run is labelled with the device and
 * the scene it ran on.
 */
const runProvenance = computed<Provenance | null>(() => {
  const s = status.value
  const hasRun = s.running || s.step > 0 || s.reward_history.length > 0
  if (!hasRun) return null
  if (isDryRun.value) {
    // A fallback reason ("auto_fallback_no_sb3") explains *why* there was
    // no PPO; "dry_run_requested" only repeats what the label says.
    const why =
      s.device_reason && s.device_reason !== 'dry_run_requested' ? `（${s.device_reason}）` : ''
    return {
      tone: 'warn',
      text: `本次为 dry-run 演示（未执行 PPO）${why} —— 下面的 reward 曲线是合成数据，不是学习曲线。`,
    }
  }
  const parts = ['真实 PPO 训练']
  if (s.policy_kind === 'signal') parts.push('信号灯 agent (离散动作)')
  if (s.device) parts.push(`设备 ${s.device}`)
  if (s.scene_kind) parts.push(`场景 ${sceneLabel.value}`)
  return { tone: 'ok', text: parts.join(' · ') }
})

const chartW = 600
const chartH = 120
let pollHandle: number | null = null
let replayMirrorHandle: number | null = null

const maxReward = computed(() =>
  status.value.reward_history.length === 0 ? 0 : Math.max(...status.value.reward_history),
)
const minReward = computed(() =>
  status.value.reward_history.length === 0 ? 0 : Math.min(...status.value.reward_history),
)

const rewardPoints = computed(() => {
  const h = status.value.reward_history
  if (h.length === 0) return ''
  const lo = minReward.value
  const hi = maxReward.value
  const range = Math.max(0.001, hi - lo)
  return h
    .map((r, i) => {
      const x = (i / Math.max(1, h.length - 1)) * chartW
      const y = chartH - ((r - lo) / range) * (chartH - 4) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

// Per-agent reward history rendering.
const AGENT_COLOR_PALETTE = [
  '#34d399',
  '#60a5fa',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb7185',
  '#22d3ee',
  '#facc15',
]
const agentColors = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  if (!status.value.agent_rewards) return out
  Object.keys(status.value.agent_rewards)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((agentId, i) => {
      out[agentId] = AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length]!
    })
  return out
})
const hasAgentRewards = computed(() => Object.keys(status.value.agent_rewards ?? {}).length > 0)
const pointsForAgent = (agentId: string): string => {
  const h = status.value.agent_rewards?.[agentId] ?? []
  if (h.length === 0) return ''
  const lo = minReward.value
  const hi = maxReward.value
  const range = Math.max(0.001, hi - lo)
  return h
    .map((r, i) => {
      const x = (i / Math.max(1, h.length - 1)) * chartW
      const y = chartH - ((r - lo) / range) * (chartH - 4) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

const formatNumber = (n: number, digits = 2): string => {
  if (Number.isNaN(n) || !Number.isFinite(n)) return '0'
  return Number(n).toFixed(digits)
}

// ===== the comparison curve + the multi-seed table =====
//
// The raw reward curve above is a *sampled* per-episode return: noisy, and
// not comparable with anything. The curve below is the policy's
// **deterministic evaluation** return against the training step, drawn next
// to the fixed-cycle baseline it has to beat — and the part of the curve
// that lies above that baseline is marked, so "the policy beat the
// baseline" is visible at a glance instead of something the reader has to
// work out by comparing two numbers.

const EVAL_CHART = {
  width: 600,
  height: 200,
  padLeft: 52,
  padRight: 16,
  padTop: 16,
  padBottom: 26,
}

const CONDITION_LABELS: Record<string, string> = {
  train: '训练条件 (train)',
  eval: '留出评估条件 (eval)',
  holdout: '最终留出条件 (holdout)',
}

/**
 * The series, restricted to the condition of its **newest** point.
 *
 * A point carries the condition it was measured on, and the numbers of two
 * conditions are not comparable (the baselines differ), so one curve shows
 * one condition.
 */
const evalSeries = computed<SignalEvalPoint[]>(() => {
  const series = status.value.signal_eval_series ?? []
  if (series.length === 0) return []
  const condition = series[series.length - 1]!.condition
  return series.filter((point) => point.condition === condition)
})

const evalCondition = computed(() => evalSeries.value[0]?.condition ?? 'train')
const evalConditionLabel = computed(
  () => CONDITION_LABELS[evalCondition.value] ?? evalCondition.value,
)
const evalGeometry = computed(() => buildEvalCurve(evalSeries.value, EVAL_CHART))
const evalBaseline = computed(() => evalSeries.value[evalSeries.value.length - 1]?.baseline ?? 0)
const evalStepMin = computed(() =>
  evalSeries.value.length === 0 ? 0 : Math.min(...evalSeries.value.map((p) => p.step)),
)
const evalStepMax = computed(() =>
  evalSeries.value.length === 0 ? 0 : Math.max(...evalSeries.value.map((p) => p.step)),
)
/** How far the best evaluation was above the baseline. */
const evalAboveMargin = computed(() => {
  if (evalSeries.value.length === 0) return 0
  return Math.max(...evalSeries.value.map((p) => p.return)) - evalBaseline.value
})

// --- the multi-seed table ------------------------------------------------

const signalSeedResults = computed<SignalSeedResult[]>(() => status.value.signal_seed_results ?? [])

/** How many seeds beat the baseline **on the training condition**. */
const seedBeatenCount = computed(
  () => signalSeedResults.value.filter((record) => record.beats_train_baseline).length,
)

const seedSuccessRate = computed(() =>
  signalSeedResults.value.length === 0
    ? 0
    : (seedBeatenCount.value / signalSeedResults.value.length) * 100,
)

const trainBaseline = computed<number | null>(() => {
  const value = status.value.signal_baselines?.train ?? status.value.baseline_no_op_return
  return typeof value === 'number' ? value : null
})

const evalConditionBaseline = computed<number | null>(() => {
  const value = status.value.signal_baselines?.eval ?? status.value.signal_eval_baseline
  return typeof value === 'number' ? value : null
})

/** The seed the best-of-N selection picked (fallback: the best measured). */
const bestSeedRecord = computed<SignalSeedResult | null>(() => {
  const records = signalSeedResults.value
  if (records.length === 0) return null
  const picked = records.find((record) => record.seed === status.value.best_seed)
  if (picked) return picked
  return records.reduce((best, record) => (record.eval_return > best.eval_return ? record : best))
})

interface Margin {
  abs: number
  pct: number
}

const marginOf = (value: number, baseline: number): Margin => {
  const abs = value - baseline
  const pct = baseline === 0 ? 0 : (abs / Math.abs(baseline)) * 100
  return { abs, pct }
}

const marginPhrase = (margin: Margin): string =>
  margin.abs >= 0
    ? `领先 ${margin.abs.toFixed(1)} 分 (${margin.pct.toFixed(1)}%)`
    : `落后 ${Math.abs(margin.abs).toFixed(1)} 分 (${Math.abs(margin.pct).toFixed(1)}%)`

/**
 * The generalisation gap: the margin on the training
 * condition against the margin on the held-out evaluation condition. The
 * advantage measured on the training episodes is an overestimate — this is
 * where that becomes visible.
 */
const generalisationGap = computed<{ train: Margin; eval: Margin } | null>(() => {
  const record = bestSeedRecord.value
  const train = trainBaseline.value
  const heldOut = evalConditionBaseline.value
  if (!record || train === null || heldOut === null) return null
  return {
    train: marginOf(record.train_return, train),
    eval: marginOf(record.eval_return, heldOut),
  }
})

const formatActionMix = (actions: Record<string, number> | undefined): string => {
  const entries = Object.entries(actions ?? {})
  if (entries.length === 0) return '—'
  return entries.map(([name, count]) => `${name} ${count}`).join(' / ')
}

/**
 * A seed whose action mix collapsed onto the pure `no_op` schedule — the
 * failure mode the multi-seed run measured. It is **reported**, never hidden:
 * the success rate is only honest if the failures are on the table.
 */
const isCollapsedSeed = (record: SignalSeedResult): boolean => {
  const names = Object.keys(record.train_actions ?? {})
  return names.length === 1 && names[0] === 'no_op'
}

const refreshStatus = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/status`)
    if (!r.ok) {
      error.value = `status ${r.status}`
      return
    }
    const j = (await r.json()) as Status
    status.value = j
    if (j.running) {
      running.value = true
    } else if (running.value) {
      // Was running, now done.
      running.value = false
      showFlashMessage(
        `训练结束 — ${j.episode_count} episode · last reward ${formatNumber(j.last_reward)}`,
        'info',
      )
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const onStart = async (): Promise<void> => {
  error.value = null
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: steps.value,
        dry_run: dryRun.value,
        device: device.value,
        n_agents: nAgents.value,
        save_every: 5000,
        independent_agents: independentAgents.value,
        scene_kind: sceneKind.value,
        curriculum: curriculumMode.value,
      }),
    })
    if (!r.ok) {
      error.value = `train ${r.status}`
      return
    }
    running.value = true
    showFlashMessage(
      `训练已启动 (${steps.value} 步, ${nAgents.value} agents, ${
        dryRun.value ? 'dry-run 演示 — 不执行 PPO' : '真实 PPO'
      })`,
      'info',
    )
    await refreshStatus()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const listCheckpoints = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/checkpoints`)
    if (!r.ok) {
      error.value = `checkpoints ${r.status}`
      return
    }
    const body = (await r.json()) as { checkpoints: Checkpoint[] }
    checkpoints.value = body.checkpoints
    checkpointsVisible.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const pruneCheckpoints = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/checkpoints`, { method: 'DELETE' })
    if (!r.ok) {
      error.value = `prune ${r.status}`
      return
    }
    const body = (await r.json()) as { deleted: number; remaining: number }
    showFlashMessage(`清理了 ${body.deleted} 个旧 checkpoint (剩 ${body.remaining})`, 'info')
    await listCheckpoints()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const formatTime = (mtime_ms: number): string => {
  if (!mtime_ms) return '—'
  const d = new Date(mtime_ms)
  return d.toLocaleString('zh-CN', { hour12: false })
}

const refreshCapabilities = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/capabilities`)
    if (!r.ok) return
    caps.value = (await r.json()) as Capabilities
  } catch {
    // Backend not reachable — leave caps null; UI shows "检测中..."
  }
}

onMounted(() => {
  refreshCapabilities()
  refreshStatus()
  refreshTrainingConfig()
  pollHandle = window.setInterval(refreshStatus, 2000)
  // Poll `window.__replayLast` (set by tick.ts on each
  // replay inference) and copy into the store so the replay-status
  // panel updates. 4 Hz is plenty for human-readable debug.
  replayMirrorHandle = window.setInterval(() => {
    const w = window as unknown as {
      __replayLast?: { obs: number[]; action: [number, number]; step: number }
    }
    if (w.__replayLast) {
      world.replayLastObs = [...w.__replayLast.obs]
      world.replayLastAction = [...w.__replayLast.action] as [number, number]
      world.replayStep = world.replayStep + 1
    }
  }, 250)
})
onBeforeUnmount(() => {
  if (pollHandle !== null) {
    clearInterval(pollHandle)
  }
  if (replayMirrorHandle !== null) {
    clearInterval(replayMirrorHandle)
  }
})
</script>

<style scoped>
.ai-playground {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e0f0;
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.back-link {
  color: #93c5fd;
  text-decoration: none;
  font-size: 13px;
}
.back-link:hover {
  text-decoration: underline;
}
.header {
  max-width: 880px;
  margin: 0 auto 20px;
}
.header h1 {
  margin: 8px 0 4px;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.sub {
  margin: 0;
  color: #94a3b8;
  font-size: 14px;
}
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(168, 85, 247, 0.18);
  color: #d8b4fe;
  font-weight: 600;
}
.card {
  max-width: 880px;
  margin: 0 auto 20px;
  padding: 24px 28px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 15px;
  color: #cbd5e1;
}
.control-row {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.ctrl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #cbd5e1;
  font-size: 13px;
}
.ctrl input[type='number'] {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 4px 8px;
  width: 100px;
  font-size: 13px;
}
button.primary {
  background: #2563eb;
  color: white;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button.primary:hover:not(:disabled) {
  background: #1d4ed8;
}
button.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button.ghost:hover:not(:disabled) {
  background: rgba(148, 163, 184, 0.08);
}
button.ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.err {
  color: #fca5a5;
  font-size: 13px;
  margin: 8px 0 0;
}
.cap-note {
  color: #cbd5e1;
  font-size: 12px;
  margin: 8px 0 0;
  background: rgba(15, 23, 42, 0.5);
  padding: 6px 10px;
  border-radius: 4px;
}
.ckpt-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ckpt-list li {
  display: flex;
  gap: 12px;
  align-items: baseline;
  font-size: 12px;
  padding: 6px 8px;
  background: #1e293b;
  border-radius: 4px;
}
.ckpt-list code {
  font-size: 12px;
  color: #fbbf24;
}
.ckpt-meta {
  color: #94a3b8;
  font-size: 11px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.metric {
  background: #1e293b;
  padding: 12px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.metric.metric-wide {
  grid-column: span 2;
}
.metric .reason-text {
  font-size: 13px;
  font-weight: 500;
  color: #cbd5e1;
  word-break: break-all;
}
.metric span.dry-badge {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.18);
  color: #fcd34d;
  font-size: 10px;
  text-transform: none;
  letter-spacing: 0;
  white-space: nowrap;
}

/* Where the curve came from — a dry run must never read as a real one. */
.prov {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid transparent;
}
.prov.warn {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.45);
  color: #fcd34d;
}
.prov.ok {
  background: rgba(15, 23, 42, 0.5);
  border-color: rgba(148, 163, 184, 0.25);
  color: #cbd5e1;
}
.metric span {
  font-size: 11px;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.metric strong {
  font-size: 18px;
  color: #f1f5f9;
  font-weight: 600;
}
.chart {
  background: #1e293b;
  border-radius: 6px;
  width: 100%;
  height: auto;
}
.muted {
  color: #94a3b8;
  font-size: 13px;
  margin: 0;
}
.muted.small {
  font-size: 11px;
  margin-top: 6px;
}

/* The multi-seed table. */
.seed-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 12px;
}
.seed-table th {
  text-align: left;
  font-weight: 600;
  color: #94a3b8;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
}
.seed-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  color: #e2e0f0;
}
.collapsed-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  background: rgba(251, 113, 133, 0.18);
  color: #fda4af;
  white-space: nowrap;
}

/* RL replay surface styling. */
.replay-status {
  display: flex;
  gap: 24px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.metric-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: #94a3b8;
}
.metric-row strong {
  font-size: 14px;
  color: #f1f5f9;
  font-weight: 600;
}
.replay-detail {
  margin-top: 10px;
  font-size: 12px;
}
.replay-detail summary {
  cursor: pointer;
  color: #cbd5e1;
}
.replay-detail code.obs {
  display: block;
  padding: 8px 10px;
  background: #1e293b;
  border-radius: 4px;
  color: #fbbf24;
  font-size: 11px;
  word-break: break-all;
  line-height: 1.5;
  margin-top: 4px;
}
</style>

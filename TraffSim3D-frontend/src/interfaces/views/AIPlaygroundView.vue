<template>
  <main class="ai-playground">
    <router-link to="/" class="back-link">← 返回首页</router-link>

    <header class="header">
      <span class="badge">M4 · 044</span>
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
          <select
            v-model="device"
            data-testid="device-select"
          >
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
          <input v-model="dryRun" type="checkbox" data-testid="dry-run-checkbox" />
          Dry-run (跳过 PPO，写假历史)
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
        >刷新</button>
        <button
          class="ghost"
          data-testid="list-checkpoints-button"
          @click="listCheckpoints"
        >列出 checkpoints</button>
        <button
          class="ghost"
          :disabled="checkpoints.length === 0"
          data-testid="prune-checkpoints-button"
          @click="pruneCheckpoints"
        >清理旧 checkpoints</button>
      </div>
      <p v-if="capabilitiesNote" class="cap-note" data-testid="cap-note">
        {{ capabilitiesNote }}
      </p>
      <p v-if="error" class="err" data-testid="train-error">{{ error }}</p>
    </section>

    <section class="card">
      <h2>训练指标</h2>
      <div class="metrics">
        <div class="metric"><span>总步数</span><strong data-testid="metric-step">{{ status.step }}</strong></div>
        <div class="metric"><span>Episode</span><strong data-testid="metric-episode">{{ status.episode_count }}</strong></div>
        <div class="metric"><span>Agent 数</span><strong data-testid="metric-n-agents">{{ status.n_agents ?? '—' }}</strong></div>
        <div class="metric"><span>最近 reward</span><strong data-testid="metric-last-reward">{{ formatNumber(status.last_reward, 2) }}</strong></div>
        <div class="metric" style="grid-column: span 2">
          <span>最新 checkpoint</span>
          <strong data-testid="metric-checkpoint" :title="status.latest_checkpoint || ''">
            {{ status.latest_checkpoint || '—' }}
          </strong>
        </div>
        <div class="metric" style="grid-column: span 2">
          <span>状态</span>
          <strong data-testid="metric-running">{{ status.running ? '运行中' : '已结束' }}</strong>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Reward 曲线</h2>
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
        <!-- Plan 047: when independent_agents, draw one polyline per agent -->
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
          :x1="0" :y1="chartH - 1" :x2="chartW" :y2="chartH - 1"
          stroke="#475569" stroke-width="0.5"
        />
      </svg>
      <p v-if="status.reward_history.length > 0" class="muted small">
        {{ status.reward_history.length }} 个 episode · max {{ formatNumber(maxReward, 2) }} · min {{ formatNumber(minReward, 2) }}
      </p>
    </section>

    <section v-if="checkpoints.length > 0 || checkpointsVisible" class="card">
      <h2>Checkpoints</h2>
      <p v-if="checkpoints.length === 0" class="muted">暂无 checkpoint — 跑一次训练试试。</p>
      <ul v-else class="ckpt-list" data-testid="ckpt-list">
        <li v-for="c in checkpoints" :key="c.name">
          <code data-testid="ckpt-name">{{ c.name }}</code>
          <span class="ckpt-meta">{{ c.process }} · {{ c.size_kb }} KB · {{ formatTime(c.mtime_ms) }}</span>
        </li>
      </ul>
    </section>

    <!-- Plan 049: RL replay surface — load a trained PPO checkpoint
         and watch it drive one of the sim vehicles in the editor. -->
    <section class="card">
      <h2>策略部署 (Replay)</h2>
      <div class="control-row">
        <label class="ctrl">
          Checkpoint
          <select
            v-model="replayCkptName"
            data-testid="ckpt-replay-select"
          >
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
        >{{ policyLoading ? '加载中…' : '加载' }}</button>
        <button
          class="ghost"
          :disabled="!world.policy"
          data-testid="clear-policy-button"
          @click="onClearPolicy"
        >清除</button>
      </div>
      <p class="muted small" data-testid="policy-status">
        <template v-if="world.policy">
          ✓ 已加载 <code>{{ world.policy.name }}</code>
          ({{ world.policy.obs_dim }} obs / {{ world.policy.action_dim }} act)
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
        >▶ 开始回放</button>
        <button
          class="ghost"
          :disabled="!replayActive"
          data-testid="stop-replay-button"
          @click="onStopReplay"
        >⏸ 停止</button>
      </div>

      <div class="replay-status" data-testid="replay-status">
        <div class="metric-row">
          <span>状态</span>
          <strong data-testid="replay-state">{{ replayActive ? '运行中' : (world.policy ? '已加载 (待启动)' : '未加载') }}</strong>
        </div>
        <div class="metric-row">
          <span>Replayed steps</span>
          <strong data-testid="replay-step">{{ replayStep }}</strong>
        </div>
      </div>

      <details v-if="replayLastObs.length > 0" class="replay-detail">
        <summary>最近 obs / action</summary>
        <p class="muted small">obs (13-dim):</p>
        <code data-testid="replay-obs" class="obs">{{ formatObs(replayLastObs) }}</code>
        <p class="muted small">action (2-dim):</p>
        <code data-testid="replay-action" class="obs">{{ formatAction(replayLastAction) }}</code>
      </details>
      <p v-if="error" class="err" data-testid="replay-error">{{ error }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
/**
 * Plan 044: AI Playground — single-agent training dashboard.
 * Plan 045: checkpoint management UI.
 * Plan 047: per-agent reward rendering.
 * Plan 048: scene-kind selector.
 * Plan 049: RL replay surface — load a PPO checkpoint and drive one
 *   vehicle in the TS sim from the policy's actions.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { showFlashMessage } from '@interfaces/composables/useFlashMessage';
import { useWorldStore } from '@interfaces/stores/worldStore';

interface Status {
  running: boolean;
  step: number;
  episode_count: number;
  last_reward: number;
  reward_history: number[];
  started_at_ms: number;
  finished_at_ms: number | null;
  device?: string;
  device_reason?: string;
  n_agents?: number;
  independent_agents?: boolean;
  latest_checkpoint?: string;
  /** Plan 047: per-agent reward history (only when independent_agents=true).
   *  Keys are stringified int agent_ids ("0", "1", ...). */
  agent_rewards?: Record<string, number[]>;
}

interface Checkpoint {
  name: string;
  process: string;
  size_kb: number;
  mtime_ms: number;
}

interface Capabilities {
  torch_version: string;
  cuda_available: boolean;
  device_count: number;
  device_name: string;
  vram_gb: number;
  sb3_available: boolean;
  min_vram_gb: number;
  device_fallback_reason: string;
}

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';

const steps = ref(200);
const nAgents = ref(2);
const sceneKind = ref<'cross' | 'corridor'>('cross');
const independentAgents = ref(false);
const device = ref<'auto' | 'gpu' | 'cpu'>('auto');
const dryRun = ref(true);
const running = ref(false);
const error = ref<string | null>(null);
const status = ref<Status>({
  running: false, step: 0, episode_count: 0, last_reward: 0,
  reward_history: [], started_at_ms: 0, finished_at_ms: null,
  n_agents: undefined,
  latest_checkpoint: '',
});

const checkpoints = ref<Checkpoint[]>([]);
const checkpointsVisible = ref(false);

const caps = ref<Capabilities | null>(null);

// Plan 049: RL replay state. The store owns the loaded policy; this
// view just collects the user's intent (which checkpoint, which target)
// and pipes actions to the store.
const world = useWorldStore();
const replayActive = computed(() => world.replayActive);
const replayStep = computed(() => world.replayStep);
const replayLastObs = computed(() => world.replayLastObs);
const replayLastAction = computed(() => world.replayLastAction);

const replayCkptName = ref('');
const replayTarget = ref('v-1');
const policyLoading = ref(false);
const replayError = ref<string | null>(null);

// Read available vehicle IDs from the world store's network (the
// dev hook `window.__world` mirrors it; not used here — Pinia store
// is the source of truth). Refreshed on mount + whenever `tickCount`
// changes (so adding/removing vehicles updates the dropdown).
const availableVehicles = computed<string[]>(() => {
  // Reading tickCount establishes a reactive dep, so this re-evaluates
  // on network mutations.
  void world.tickCount;
  return Object.keys(world.network.vehicles).sort();
});

const canStartReplay = computed(() => Boolean(world.policy) && Boolean(replayTarget.value) && !replayActive.value);

const onLoadPolicy = async (): Promise<void> => {
  replayError.value = null;
  if (!replayCkptName.value) return;
  policyLoading.value = true;
  try {
    const r = await world.loadPolicy(replayCkptName.value);
    if (!r.ok) {
      replayError.value = r.reason;
      showFlashMessage(`加载失败: ${r.reason}`, 'error');
      return;
    }
    showFlashMessage(`策略已加载: ${replayCkptName.value}`, 'info');
  } finally {
    policyLoading.value = false;
  }
};

const onStartReplay = (): void => {
  replayError.value = null;
  world.setReplayTarget(replayTarget.value);
  const r = world.startReplay();
  if (!r.ok) {
    replayError.value = r.reason;
    showFlashMessage(`回放启动失败: ${r.reason}`, 'error');
    return;
  }
  showFlashMessage(`开始回放 — 目标: ${replayTarget.value}`, 'info');
};

const onStopReplay = (): void => {
  world.stopReplay();
  showFlashMessage('回放已停止', 'info');
};

const onClearPolicy = (): void => {
  world.clearPolicy();
  replayCkptName.value = '';
  showFlashMessage('策略已清除', 'info');
};

const formatObs = (obs: readonly number[]): string =>
  obs.map((x) => x.toFixed(3)).join(', ');
const formatAction = (a: readonly [number, number]): string =>
  `accel=${a[0].toFixed(3)}, steer=${a[1].toFixed(3)}`;
const gpuAvailable = computed(() => caps.value?.cuda_available === true);
const gpuDeviceName = computed(() => caps.value?.device_name ?? '');
const capabilitiesNote = computed(() => {
  const c = caps.value;
  if (!c) return '检测后端能力中…';
  if (!c.sb3_available) {
    return '⚠ stable-baselines3 未安装（未跑 `uv sync --extra rl`），将自动 fallback 到 dry-run。';
  }
  if (!c.cuda_available) {
    return `ℹ 未检测到 CUDA（torch ${c.torch_version || '未装'}），将使用 CPU。`;
  }
  if (c.vram_gb < c.min_vram_gb) {
    return `⚠ GPU 显存仅 ${c.vram_gb.toFixed(1)} GB < ${c.min_vram_gb} GB 阈值，auto 会 fallback CPU。`;
  }
  return `✓ GPU 可用: ${c.device_name} (${c.vram_gb.toFixed(1)} GB)`;
});

const chartW = 600;
const chartH = 120;
let pollHandle: number | null = null;
let replayMirrorHandle: number | null = null;

const maxReward = computed(() => status.value.reward_history.length === 0
  ? 0
  : Math.max(...status.value.reward_history));
const minReward = computed(() => status.value.reward_history.length === 0
  ? 0
  : Math.min(...status.value.reward_history));

const rewardPoints = computed(() => {
  const h = status.value.reward_history;
  if (h.length === 0) return '';
  const lo = minReward.value;
  const hi = maxReward.value;
  const range = Math.max(0.001, hi - lo);
  return h
    .map((r, i) => {
      const x = (i / Math.max(1, h.length - 1)) * chartW;
      const y = chartH - ((r - lo) / range) * (chartH - 4) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

// Plan 047: per-agent reward history rendering.
const AGENT_COLOR_PALETTE = ['#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185', '#22d3ee', '#facc15'];
const agentColors = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  if (!status.value.agent_rewards) return out;
  Object.keys(status.value.agent_rewards)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((agentId, i) => {
      out[agentId] = AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length]!;
    });
  return out;
});
const hasAgentRewards = computed(
  () => Object.keys(status.value.agent_rewards ?? {}).length > 0,
);
const pointsForAgent = (agentId: string): string => {
  const h = status.value.agent_rewards?.[agentId] ?? [];
  if (h.length === 0) return '';
  const lo = minReward.value;
  const hi = maxReward.value;
  const range = Math.max(0.001, hi - lo);
  return h
    .map((r, i) => {
      const x = (i / Math.max(1, h.length - 1)) * chartW;
      const y = chartH - ((r - lo) / range) * (chartH - 4) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
};

const formatNumber = (n: number, digits = 2): string => {
  if (Number.isNaN(n) || !Number.isFinite(n)) return '0';
  return Number(n).toFixed(digits);
};

const refreshStatus = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/status`);
    if (!r.ok) {
      error.value = `status ${r.status}`;
      return;
    }
    const j = (await r.json()) as Status;
    status.value = j;
    if (j.running) {
      running.value = true;
    } else if (running.value) {
      // Was running, now done.
      running.value = false;
      showFlashMessage(
        `训练结束 — ${j.episode_count} episode · last reward ${formatNumber(j.last_reward)}`,
        'info',
      );
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
};

const onStart = async (): Promise<void> => {
  error.value = null;
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: steps.value, dry_run: dryRun.value,
        device: device.value, n_agents: nAgents.value,
        save_every: 5000, independent_agents: independentAgents.value,
        scene_kind: sceneKind.value,
      }),
    });
    if (!r.ok) {
      error.value = `train ${r.status}`;
      return;
    }
    running.value = true;
    showFlashMessage(
      `训练已启动 (${steps.value} 步, ${nAgents.value} agents, dry_run=${dryRun.value})`,
      'info',
    );
    await refreshStatus();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
};

const listCheckpoints = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/checkpoints`);
    if (!r.ok) {
      error.value = `checkpoints ${r.status}`;
      return;
    }
    const body = (await r.json()) as { checkpoints: Checkpoint[] };
    checkpoints.value = body.checkpoints;
    checkpointsVisible.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
};

const pruneCheckpoints = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/checkpoints`, { method: 'DELETE' });
    if (!r.ok) {
      error.value = `prune ${r.status}`;
      return;
    }
    const body = (await r.json()) as { deleted: number; remaining: number };
    showFlashMessage(`清理了 ${body.deleted} 个旧 checkpoint (剩 ${body.remaining})`, 'info');
    await listCheckpoints();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
};

const formatTime = (mtime_ms: number): string => {
  if (!mtime_ms) return '—';
  const d = new Date(mtime_ms);
  return d.toLocaleString('zh-CN', { hour12: false });
};

const refreshCapabilities = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/rl/capabilities`);
    if (!r.ok) return;
    caps.value = (await r.json()) as Capabilities;
  } catch {
    // Backend not reachable — leave caps null; UI shows "检测中..."
  }
};

onMounted(() => {
  refreshCapabilities();
  refreshStatus();
  pollHandle = window.setInterval(refreshStatus, 2000);
  // Plan 049: poll `window.__replayLast` (set by tick.ts on each
  // replay inference) and copy into the store so the replay-status
  // panel updates. 4 Hz is plenty for human-readable debug.
  replayMirrorHandle = window.setInterval(() => {
    const w = window as unknown as {
      __replayLast?: { obs: number[]; action: [number, number]; step: number };
    };
    if (w.__replayLast) {
      world.replayLastObs = [...w.__replayLast.obs];
      world.replayLastAction = [...w.__replayLast.action] as [number, number];
      world.replayStep = world.replayStep + 1;
    }
  }, 250);
});
onBeforeUnmount(() => {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
  }
  if (replayMirrorHandle !== null) {
    clearInterval(replayMirrorHandle);
  }
});
</script>

<style scoped>
.ai-playground {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e0f0;
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.back-link { color: #93c5fd; text-decoration: none; font-size: 13px; }
.back-link:hover { text-decoration: underline; }
.header { max-width: 880px; margin: 0 auto 20px; }
.header h1 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.sub { margin: 0; color: #94a3b8; font-size: 14px; }
.badge { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 999px;
         background: rgba(168, 85, 247, 0.18); color: #d8b4fe; font-weight: 600; }
.card { max-width: 880px; margin: 0 auto 20px; padding: 24px 28px;
        background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(148, 163, 184, 0.15);
        border-radius: 12px; }
.card h2 { margin: 0 0 12px; font-size: 15px; color: #cbd5e1; }
.control-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.ctrl { display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 13px; }
.ctrl input[type=number] { background: #1e293b; color: #f1f5f9; border: 1px solid #334155;
                            border-radius: 4px; padding: 4px 8px; width: 100px; font-size: 13px; }
button.primary { background: #2563eb; color: white; padding: 8px 16px; border: none;
                 border-radius: 6px; cursor: pointer; font-size: 13px; }
button.primary:hover:not(:disabled) { background: #1d4ed8; }
button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
button.ghost { background: transparent; border: 1px solid rgba(148, 163, 184, 0.3);
               color: inherit; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
button.ghost:hover:not(:disabled) { background: rgba(148, 163, 184, 0.08); }
button.ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.err { color: #fca5a5; font-size: 13px; margin: 8px 0 0; }
.cap-note { color: #cbd5e1; font-size: 12px; margin: 8px 0 0;
            background: rgba(15, 23, 42, 0.5); padding: 6px 10px; border-radius: 4px; }
.ckpt-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.ckpt-list li { display: flex; gap: 12px; align-items: baseline;
                 font-size: 12px; padding: 6px 8px; background: #1e293b; border-radius: 4px; }
.ckpt-list code { font-size: 12px; color: #fbbf24; }
.ckpt-meta { color: #94a3b8; font-size: 11px; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.metric { background: #1e293b; padding: 12px; border-radius: 6px; display: flex;
          flex-direction: column; gap: 4px; }
.metric span { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.metric strong { font-size: 18px; color: #f1f5f9; font-weight: 600; }
.chart { background: #1e293b; border-radius: 6px; width: 100%; height: auto; }
.muted { color: #94a3b8; font-size: 13px; margin: 0; }
.muted.small { font-size: 11px; margin-top: 6px; }

/* Plan 049: RL replay surface styling. */
.replay-status { display: flex; gap: 24px; margin-top: 12px; flex-wrap: wrap; }
.metric-row { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #94a3b8; }
.metric-row strong { font-size: 14px; color: #f1f5f9; font-weight: 600; }
.replay-detail { margin-top: 10px; font-size: 12px; }
.replay-detail summary { cursor: pointer; color: #cbd5e1; }
.replay-detail code.obs {
  display: block; padding: 8px 10px; background: #1e293b; border-radius: 4px;
  color: #fbbf24; font-size: 11px; word-break: break-all; line-height: 1.5;
  margin-top: 4px;
}
</style>
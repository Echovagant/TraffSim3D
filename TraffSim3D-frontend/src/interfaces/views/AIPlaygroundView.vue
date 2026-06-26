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
        <div class="metric"><span>最近 reward</span><strong data-testid="metric-last-reward">{{ formatNumber(status.last_reward, 2) }}</strong></div>
        <div class="metric"><span>状态</span><strong data-testid="metric-running">{{ status.running ? '运行中' : '已结束' }}</strong></div>
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
        <polyline
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
  </main>
</template>

<script setup lang="ts">
/**
 * Plan 044: AI Playground — single-agent training dashboard.
 *
 * Polls /api/v1/rl/status every 2s after starting a training run.
 * Renders reward history as a pure SVG polyline (no canvas — easier
 * for Playwright to assert).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { showFlashMessage } from '@interfaces/composables/useFlashMessage';

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
const device = ref<'auto' | 'gpu' | 'cpu'>('auto');
const dryRun = ref(true);
const running = ref(false);
const error = ref<string | null>(null);
const status = ref<Status>({
  running: false, step: 0, episode_count: 0, last_reward: 0,
  reward_history: [], started_at_ms: 0, finished_at_ms: null,
});

const caps = ref<Capabilities | null>(null);
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
      body: JSON.stringify({ steps: steps.value, dry_run: dryRun.value, device: device.value }),
    });
    if (!r.ok) {
      error.value = `train ${r.status}`;
      return;
    }
    running.value = true;
    showFlashMessage(
      `训练已启动 (${steps.value} 步, dry_run=${dryRun.value}, device=${device.value})`,
      'info',
    );
    await refreshStatus();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
});
onBeforeUnmount(() => {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
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
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.metric { background: #1e293b; padding: 12px; border-radius: 6px; display: flex;
          flex-direction: column; gap: 4px; }
.metric span { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.metric strong { font-size: 18px; color: #f1f5f9; font-weight: 600; }
.chart { background: #1e293b; border-radius: 6px; width: 100%; height: auto; }
.muted { color: #94a3b8; font-size: 13px; margin: 0; }
.muted.small { font-size: 11px; margin-top: 6px; }
</style>
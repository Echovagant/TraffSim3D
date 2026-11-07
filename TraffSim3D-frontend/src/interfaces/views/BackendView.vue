<template>
  <main class="backend-view" data-reveal>
    <ShowcaseNav />
    <header class="view-header">
      <h1>Backend Services</h1>
      <p class="view-sub">FastAPI 服务状态 · 从 OpenAPI schema 动态发现端点</p>
    </header>

    <section class="status-panel" :class="`status-${overallState}`" data-reveal>
      <div class="status-headline">
        <span class="status-dot" :class="`dot-${overallState}`"></span>
        <span class="status-text">{{ statusHeadline }}</span>
        <!-- The live pulse: the dot breathes on every poll, so the page
             reads as connected rather than as a form. -->
        <span class="pulse" :key="tick" aria-hidden></span>
      </div>
      <p class="status-detail">{{ statusDetail }}</p>

      <!-- The numbers that prove it is alive: uptime over the polling
           window, the average round trip, and the samples themselves. -->
      <div class="live-strip">
        <div class="live-cell">
          <span class="live-label">在线率</span>
          <b class="live-value" :class="{ warn: liveUptime < 100 }">{{ liveUptime }}%</b>
          <span class="live-note">最近 {{ history.length }} 次探活</span>
        </div>
        <div class="live-cell">
          <span class="live-label">平均时延</span>
          <b class="live-value">{{ avgLatency }}<em>ms</em></b>
          <span class="live-note">每 4 秒探活一次</span>
        </div>
        <div class="live-cell live-spark">
          <span class="live-label">探活记录</span>
          <svg viewBox="0 0 100 26" preserveAspectRatio="none" class="spark" aria-hidden>
            <polyline
              :points="uptimePoints"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <span class="live-note">每一段是一次探测</span>
        </div>
      </div>

      <div class="status-actions">
        <button @click="refresh" :disabled="isRefreshing">
          {{ isRefreshing ? '检查中…' : '🔄 重新检查' }}
        </button>
        <span class="last-checked" v-if="lastCheckedAt">
          上次检查：{{ lastCheckedAtFormatted }}（{{ checkedAgo }}）
        </span>
      </div>
    </section>

    <section class="endpoints">
      <h2>可用端点</h2>
      <ul class="endpoint-list">
        <li
          v-for="ep in endpoints"
          :key="ep.id"
          class="endpoint"
          :class="`endpoint-${epState(ep)}`"
        >
          <div class="endpoint-row">
            <span class="endpoint-method">{{ ep.method }}</span>
            <code class="endpoint-path">{{ ep.path }}</code>
            <span class="endpoint-state">
              <span class="dot" :class="`dot-${epState(ep)}`"></span>
              {{ epStateLabel(ep) }}
              <span v-if="ep.latencyMs !== undefined" class="latency">
                {{ ep.latencyMs }}ms
                <em v-if="(ep.okCount ?? 0) + (ep.failCount ?? 0) > 1">
                  · {{ ep.okCount }}/{{ (ep.okCount ?? 0) + (ep.failCount ?? 0) }}
                </em>
              </span>
            </span>
          </div>
          <p class="endpoint-desc">
            {{ ep.description }}
            <span v-if="epState(ep) === 'skipped'" class="endpoint-note">{{ ep.skipReason }}</span>
          </p>
          <pre v-if="epState(ep) === 'ok' && ep.response" class="endpoint-response">{{
            formatJson(ep.response)
          }}</pre>
          <pre v-else-if="epState(ep) === 'error'" class="endpoint-response error">{{
            ep.error
          }}</pre>
        </li>
      </ul>
    </section>

    <section class="meta">
      <h2>客户端配置</h2>
      <dl class="meta-list">
        <dt>请求前缀</dt>
        <dd>无 — 按 OpenAPI 登记的路径原样请求（<code>/api/v1/…</code> 不会被重复拼接）</dd>
        <dt>请求超时</dt>
        <dd>{{ timeoutMs }} ms（AbortController）</dd>
        <dt>前端代理</dt>
        <dd>
          Vite dev server: <code>/api</code> 与 <code>/health</code> →
          <code>http://localhost:{{ backendPort }}</code>
        </dd>
        <dt>代码位置</dt>
        <dd><code>src/infrastructure/api/</code></dd>
      </dl>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ShowcaseNav } from '@interfaces/components/showcase'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createHttpClient, BackendError } from '@infrastructure/api'

interface EndpointProbe {
  id: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  description: string
  /** 自检是否对该端点发起请求。只有只读端点才为 true。 */
  probe: boolean
  /** probe 为 false 时给访客看的原因。 */
  skipReason?: string
  response?: unknown
  error?: string
  /** The round-trip time of the last probe (ms) — the number that tells
   *  a visitor the service is ALIVE, not merely reachable. */
  latencyMs?: number
  /** How many probes have succeeded / failed since the page opened. */
  okCount?: number
  failCount?: number
}

type ProbeState = 'unknown' | 'ok' | 'error' | 'skipped'

const endpoints = ref<EndpointProbe[]>([])

/**
 * The backend's base URL — the SAME ORIGIN by default, so the vite
 * proxy forwards `/api` and `/openapi.json` to whichever port the
 * backend runs on (the old hard-coded `http://localhost:8000` broke
 * on every other port — measured 2026-11-07).
 */
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? ''
const backendPort = (import.meta.env.VITE_BACKEND_PORT as string | undefined) ?? '8000'

/** 请求超时（AbortController）。 */
const timeoutMs = 3000

/**
 * 探针客户端 —— **不带任何前缀**。
 *
 * OpenAPI 登记的路径已经是最终路径（`/api/v1/rl/status`、`/health`）。
 * 再套一层 `/api/v1` 会变成 `/api/v1/api/v1/...` —— 那正是本页面曾经把
 * 健康后端报成 "Backend offline" 的原因。这里用空前缀客户端按原样请求，
 * 让重复拼接在结构上不可能发生。
 */
const probeHttp = createHttpClient('', { timeoutMs })

interface OpenApiParameter {
  name?: string
  in?: string
  required?: boolean
}

interface OpenApiOperation {
  summary?: string
  description?: string
  parameters?: OpenApiParameter[]
}

/** 写操作不解释，直接说明自检不会执行。 */
const SKIP_WRITE = '写操作 — 自检只发起只读请求，不会执行。'

/** OpenAPI 拿不到时的兜底清单：两条都是安全的只读端点。 */
const FALLBACK_ENDPOINTS: EndpointProbe[] = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    description: 'Liveness probe — 返回 { status: "ok" } 即服务存活。',
    probe: true,
  },
  {
    id: 'ping',
    method: 'GET',
    path: '/api/v1/ping',
    description: '端到端 smoke 测试 — 经过 Vite proxy 与 FastAPI 全链路。',
    probe: true,
  },
]

/** 必填 query 参数 —— 自检不伪造入参，免得打到真实的外部服务上。 */
const requiredQueryParams = (op: OpenApiOperation): string[] =>
  (op.parameters ?? [])
    .filter((p) => p.in === 'query' && p.required === true)
    .map((p) => p.name ?? '?')

const discoverEndpoints = async (): Promise<void> => {
  try {
    const r = await fetch(`${BACKEND_URL}/openapi.json`)
    if (!r.ok) {
      // Fallback to hardcoded list if OpenAPI unavailable
      endpoints.value = FALLBACK_ENDPOINTS.map((e) => ({ ...e }))
      return
    }
    const spec = (await r.json()) as {
      paths: Record<string, Record<string, OpenApiOperation>>
    }
    const discovered: EndpointProbe[] = []
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, detail] of Object.entries(methods)) {
        const upperMethod = method.toUpperCase()
        if (!['GET', 'POST', 'DELETE'].includes(upperMethod)) continue
        // Skip path parameters (e.g. /rl/checkpoints/{name}/weights) — they need runtime values
        if (path.includes('{')) continue

        // 只有只读端点会被真正请求。写操作照旧列出来说明 API 面，
        // 但绝不能在「打开页面」时执行 —— 那会启动训练或删掉 checkpoint。
        let probe = false
        let skipReason: string | undefined
        if (upperMethod !== 'GET') {
          skipReason = SKIP_WRITE
        } else {
          const required = requiredQueryParams(detail)
          if (required.length > 0) {
            skipReason = `需要必填参数 ${required.join(', ')} — 自检不会伪造入参。`
          } else {
            probe = true
          }
        }

        discovered.push({
          id: `${upperMethod}-${path}`.replace(/[^a-zA-Z0-9-]/g, '-'),
          method: upperMethod as 'GET' | 'POST' | 'DELETE',
          path,
          description: detail.summary || detail.description || `${upperMethod} ${path}`,
          probe,
          skipReason,
        })
      }
    }
    // Sort: health first, then by path
    discovered.sort((a, b) => {
      if (a.path === '/health') return -1
      if (b.path === '/health') return 1
      return a.path.localeCompare(b.path)
    })
    endpoints.value = discovered
  } catch {
    // Network error — fallback to hardcoded list
    endpoints.value = FALLBACK_ENDPOINTS.map((e) => ({ ...e }))
  }
}

const lastCheckedAt = ref<number | null>(null)
const isRefreshing = ref(false)

const epState = (ep: EndpointProbe): ProbeState => {
  if (!ep.probe) return 'skipped'
  if (ep.error) return 'error'
  if (ep.response !== undefined) return 'ok'
  return 'unknown'
}
const epStateLabel = (ep: EndpointProbe): string => {
  const s = epState(ep)
  if (s === 'ok') return '✓ ok'
  if (s === 'error') return '✗ error'
  if (s === 'skipped') return '· 未执行'
  return '· 待检查'
}

const formatJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const lastCheckedAtFormatted = computed(() => {
  if (!lastCheckedAt.value) return ''
  return new Date(lastCheckedAt.value).toLocaleTimeString()
})
const checkedAgo = computed(() => {
  if (!lastCheckedAt.value) return ''
  const s = Math.max(0, Math.round((Date.now() - lastCheckedAt.value) / 1000))
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`
})

/** 真正会发起请求的端点（只读探针）。 */
const probed = computed(() => endpoints.value.filter((e) => e.probe))

const overallState = computed<ProbeState>(() => {
  if (probed.value.length === 0) return 'unknown'
  if (probed.value.some((e) => epState(e) === 'unknown')) return 'unknown'
  return probed.value.some((e) => epState(e) === 'error') ? 'error' : 'ok'
})

/**
 * 后端是否可达 —— 以 `/health` 存活探针为准（后端自己把它定义为 liveness）。
 * 没有 /health 时退化为「至少有一个探针拿到了响应」。
 */
const backendReachable = computed(() => {
  const health = probed.value.find((e) => e.path === '/health')
  if (health) return epState(health) === 'ok'
  return probed.value.some((e) => epState(e) === 'ok')
})

const statusHeadline = computed(() => {
  if (endpoints.value.length === 0) return '正在检查…'
  if (probed.value.length === 0) return '无可探测端点'
  if (overallState.value === 'unknown') return '正在检查…'
  // 「offline」只在后端真的连不上时说 —— 某个路由 404 不等于后端挂了。
  if (!backendReachable.value) return 'Backend offline'
  if (overallState.value === 'error') return '部分端点异常'
  return 'Backend online'
})
const statusDetail = computed(() => {
  if (endpoints.value.length === 0) return '正在发起请求…'
  if (probed.value.length === 0) return 'OpenAPI 中没有可安全探测的只读端点。'
  if (overallState.value === 'unknown') return '正在发起请求…'
  const ok = probed.value.filter((e) => epState(e) === 'ok')
  const bad = probed.value.filter((e) => epState(e) === 'error')
  if (!backendReachable.value) {
    return `无法连接后端：${probed.value.length} 个探针全部失败`
  }
  if (bad.length === 0) return `全部 ${ok.length} 个端点响应正常`
  return `${ok.length} 个端点正常，${bad.length} 个异常：${bad.map((e) => e.path).join(', ')}`
})

/**
 * 只读探针：按 OpenAPI 登记的路径原样 GET 一次。
 *
 * 这里没有任何 POST / DELETE —— 「打开页面」绝不能启动训练或删 checkpoint。
 */
const probeOne = async (ep: EndpointProbe): Promise<void> => {
  delete ep.response
  delete ep.error
  const startedAt = performance.now()
  try {
    ep.response = await probeHttp.get(ep.path)
    ep.latencyMs = Math.round(performance.now() - startedAt)
    ep.okCount = (ep.okCount ?? 0) + 1
  } catch (err) {
    ep.latencyMs = Math.round(performance.now() - startedAt)
    ep.failCount = (ep.failCount ?? 0) + 1
    if (err instanceof BackendError) {
      // BackendError 的 message 里带着实际请求的 URL，失败时正好给人看。
      ep.error =
        err.body === null || err.body === undefined
          ? err.message
          : `${err.message}\n${formatJson(err.body)}`
    } else {
      ep.error = err instanceof Error ? err.message : String(err)
    }
  }
}

const refresh = async (): Promise<void> => {
  if (isRefreshing.value) return
  isRefreshing.value = true
  try {
    await Promise.all(probed.value.map((e) => probeOne(e)))
  } finally {
    isRefreshing.value = false
    lastCheckedAt.value = Date.now()
  }
}

// ===== the live layer =====
//
// A backend page that only refreshes when you press the button reads as
// a form, not as a service. The page now polls on its own (every 4 s),
// measures the round trip, and keeps a short history so the uptime
// line is a LINE, not a claim.
const POLL_INTERVAL_MS = 4000
/** How many poll samples the uptime line keeps. */
const HISTORY_LEN = 40

interface PollSample {
  at: number
  ok: number
  fail: number
  avgLatency: number
}

const history = ref<PollSample[]>([])
const liveUptime = ref(100)
let pollTimer: number | null = null

const recordSample = (): void => {
  const latencies = probed.value
    .filter((e) => e.probe && e.latencyMs !== undefined)
    .map((e) => e.latencyMs!)
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0
  const ok = probed.value.filter((e) => e.probe && !e.error).length
  const fail = probed.value.filter((e) => e.probe && e.error).length
  history.value = [...history.value, { at: Date.now(), ok, fail, avgLatency }].slice(-HISTORY_LEN)
  const total = history.value.length
  const good = history.value.reduce((n, s) => n + (s.fail === 0 ? 1 : 0), 0)
  liveUptime.value = total > 0 ? Math.round((good / total) * 100) : 100
}

/** The uptime line: the per-sample ok/fail history as a sparkline. */
const uptimePoints = computed(() => {
  const h = history.value
  if (h.length < 2) return ''
  return h
    .map((s, i) => {
      const x = (i / (h.length - 1)) * 100
      const y = s.fail === 0 ? 4 : 22
      return `${x.toFixed(1)},${y}`
    })
    .join(' ')
})

const avgLatency = computed(() => {
  const l = probed.value
    .filter((e) => e.probe && e.latencyMs !== undefined)
    .map((e) => e.latencyMs!)
  return l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0
})

/** The ticks between polls — the page visibly breathes. */
const tick = ref(0)
onMounted(async () => {
  await discoverEndpoints()
  void refresh()
  pollTimer = window.setInterval(() => {
    tick.value += 1
    void refresh()
    recordSample()
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
})
</script>

<style scoped>
.backend-view {
  min-height: 100vh;
  background: var(--dc-screen);
  color: var(--dc-text);
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}

.view-header {
  max-width: 960px;
  margin: 0 auto 24px;
}
.view-header h1 {
  margin: 8px 0 4px;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.view-header .view-sub {
  margin: 0;
  color: var(--dc-text-dim);
  font-size: 14px;
}
.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #93c5fd;
  text-decoration: none;
}
.back-link:hover {
  text-decoration: underline;
}

/* Status panel */
.status-panel {
  max-width: 960px;
  margin: 0 auto 24px;
  padding: 20px 24px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-text-dim) 22%, transparent);
}
.status-ok {
  border-color: rgba(34, 197, 94, 0.5);
  background: rgba(20, 83, 45, 0.18);
}
.status-error {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(127, 29, 29, 0.18);
}
.status-headline {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
}
.status-detail {
  margin: 6px 0 14px;
  font-size: 13px;
  color: var(--dc-text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.status-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.status-actions button {
  padding: 6px 14px;
  background: var(--dc-panel-2);
  color: var(--dc-text);
  border: 1px solid var(--dc-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.status-actions button:hover:not(:disabled) {
  background: var(--dc-secondary);
}
.status-actions button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.last-checked {
  font-size: 12px;
  color: var(--dc-text-dim);
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  vertical-align: -1px;
  margin-right: 4px;
}
.dot-ok {
  background: var(--dc-ok);
  box-shadow: 0 0 6px var(--dc-ok);
}
.dot-error {
  background: var(--dc-alert);
  box-shadow: 0 0 6px var(--dc-alert);
}
.dot-unknown {
  background: var(--dc-text-faint);
}
/* 写操作 / 需要必填参数的端点 —— 与「待检查」同色，表示「本次没有请求它」。 */
.dot-skipped {
  background: var(--dc-text-faint);
}

/* Endpoints */
.endpoints {
  max-width: 960px;
  margin: 0 auto 24px;
}
.endpoints h2,
.meta h2 {
  font-size: 16px;
  margin: 0 0 12px;
  color: var(--dc-text-dim);
}
.endpoint-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.endpoint {
  padding: 14px 16px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid color-mix(in srgb, var(--dc-text-dim) 18%, transparent);
  border-radius: 10px;
}
.endpoint-ok {
  border-color: rgba(34, 197, 94, 0.4);
}
.endpoint-error {
  border-color: rgba(239, 68, 68, 0.4);
}
.endpoint-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.endpoint-method {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dc-accent) 55%, var(--dc-panel));
  color: #dbeafe;
  font-weight: 700;
}
.endpoint-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  color: var(--dc-text);
}
.endpoint-state {
  margin-left: auto;
  font-size: 12px;
  color: var(--dc-text-dim);
}
.endpoint-desc {
  margin: 4px 0 8px;
  font-size: 13px;
  color: var(--dc-text-dim);
}
.endpoint-note {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--dc-text-dim);
}
.endpoint-response {
  margin: 0;
  padding: 10px 12px;
  background: #020617;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #a7f3d0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.endpoint-response.error {
  color: #fecaca;
}

/* Meta */
.meta {
  max-width: 960px;
  margin: 0 auto;
}
.meta-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 16px;
  margin: 0;
  font-size: 13px;
  color: var(--dc-text-dim);
}
.meta-list dt {
  color: var(--dc-text-dim);
}
.meta-list dd {
  margin: 0;
}
.meta-list code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.8);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--dc-text);
}

@media (max-width: 720px) {
  .backend-view {
    padding: 72px 16px 32px;
  }
  .view-header h1 {
    font-size: 22px;
  }
}

/* ===== the live layer =====
   A backend page that only answers when you press a button reads as a
   form. These bits make the service's state visible WITHOUT a click:
   the breathing dot, the uptime line, the round-trip numbers. */
.pulse {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  margin-left: 2px;
  animation: pulse-out 4s var(--ds-ease-out) infinite;
}
@keyframes pulse-out {
  0% {
    box-shadow: 0 0 0 0 currentColor;
    opacity: 1;
  }
  70%,
  100% {
    box-shadow: 0 0 0 9px transparent;
    opacity: 0.4;
  }
}
.live-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0 4px;
}
.live-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel-2) 60%, transparent);
  min-width: 0;
}
.live-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dc-text-faint);
}
.live-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--dc-text);
  font-variant-numeric: tabular-nums;
}
.live-value.warn {
  color: var(--dc-warning);
}
.live-value em {
  margin-left: 2px;
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  color: var(--dc-text-dim);
}
.live-note {
  font-size: 11px;
  color: var(--dc-text-faint);
}
.live-spark {
  justify-content: space-between;
}
.spark {
  width: 100%;
  height: 26px;
  color: var(--dc-ok);
  overflow: visible;
}
.latency {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
  color: var(--dc-text-faint);
  font-size: 11px;
}
.latency em {
  font-style: normal;
  opacity: 0.75;
}
@media (max-width: 720px) {
  .live-strip {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

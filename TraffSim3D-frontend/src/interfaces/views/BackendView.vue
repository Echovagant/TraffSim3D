<template>
  <main class="backend-view">
    <header class="view-header">
      <router-link to="/" class="back-link">← 返回首页</router-link>
      <h1>Backend Services</h1>
      <p class="view-sub">FastAPI 服务状态 · 从 OpenAPI schema 动态发现端点</p>
    </header>

    <section class="status-panel" :class="`status-${overallState}`">
      <div class="status-headline">
        <span class="status-dot" :class="`dot-${overallState}`"></span>
        <span class="status-text">{{ statusHeadline }}</span>
      </div>
      <p class="status-detail">{{ statusDetail }}</p>
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
import { computed, onMounted, ref } from 'vue'
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
}

type ProbeState = 'unknown' | 'ok' | 'error' | 'skipped'

const endpoints = ref<EndpointProbe[]>([])

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000'
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
  try {
    ep.response = await probeHttp.get(ep.path)
  } catch (err) {
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

onMounted(async () => {
  await discoverEndpoints()
  void refresh()
})
</script>

<style scoped>
.backend-view {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
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
  color: #94a3b8;
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
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(148, 163, 184, 0.2);
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
  color: #cbd5e1;
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
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.status-actions button:hover:not(:disabled) {
  background: #334155;
}
.status-actions button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.last-checked {
  font-size: 12px;
  color: #94a3b8;
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
  background: #22c55e;
  box-shadow: 0 0 6px #22c55e;
}
.dot-error {
  background: #ef4444;
  box-shadow: 0 0 6px #ef4444;
}
.dot-unknown {
  background: #64748b;
}
/* 写操作 / 需要必填参数的端点 —— 与「待检查」同色，表示「本次没有请求它」。 */
.dot-skipped {
  background: #64748b;
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
  color: #cbd5e1;
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
  border: 1px solid rgba(148, 163, 184, 0.15);
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
  background: #1e3a8a;
  color: #dbeafe;
  font-weight: 700;
}
.endpoint-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  color: #f1f5f9;
}
.endpoint-state {
  margin-left: auto;
  font-size: 12px;
  color: #cbd5e1;
}
.endpoint-desc {
  margin: 4px 0 8px;
  font-size: 13px;
  color: #94a3b8;
}
.endpoint-note {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #94a3b8;
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
  color: #cbd5e1;
}
.meta-list dt {
  color: #94a3b8;
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
  color: #f1f5f9;
}

@media (max-width: 720px) {
  .backend-view {
    padding: 72px 16px 32px;
  }
  .view-header h1 {
    font-size: 22px;
  }
}
</style>

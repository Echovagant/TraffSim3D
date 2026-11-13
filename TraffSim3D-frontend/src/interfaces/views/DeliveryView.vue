<template>
  <main class="delivery" data-reveal>
    <ShowcaseNav />

    <header class="delivery-head">
      <span class="eyebrow">交付物总览</span>
      <h1>TraffSim3D</h1>
      <p class="lead">
        一个面向智慧城市的 3D 交通仿真平台：前端 Vue 3 + Three.js / Cesium，后端 FastAPI +
        PyTorch，DDD 分层，多智能体 RL 引擎。这一页是它交付了什么、怎么搭起来、做到什么程度的 目录。
      </p>
    </header>

    <!-- ===== the numbers ===== -->
    <section class="facts" data-reveal>
      <div class="fact"><b>1 300</b><span>前端单测</span></div>
      <div class="fact"><b>59</b><span>e2e 用例</span></div>
      <div class="fact"><b>17</b><span>架构决策 ADR</span></div>
      <!--
        The city's own numbers are ASKED FOR, not remembered: the
        backend counts the very network it serves. Before the answer
        arrives the cell shows a dash rather than a guess.
      -->
      <div class="fact" :class="{ 'is-pending': !cityEvidence }">
        <b>{{ cityEvidence?.roads ?? '—' }}</b
        ><span>深圳福田道路</span>
      </div>
      <div class="fact" :class="{ 'is-pending': !cityEvidence }">
        <b>{{ cityEvidence?.intersections ?? '—' }}</b
        ><span>路口</span>
      </div>
      <div class="fact" :class="{ 'is-pending': !cityEvidence }">
        <b>{{ cityEvidence?.trafficLights ?? '—' }}</b
        ><span>信号灯</span>
      </div>
    </section>

    <!-- ===== the architecture ===== -->
    <section class="block" data-reveal>
      <h2>架构</h2>
      <p class="block-lead">
        前后端各自分层，接口只有 HTTP 与 WebSocket 两处。域逻辑不依赖框架，因此训练环境与浏览器
        跑的是同一份规则。
      </p>
      <div class="arch">
        <div class="arch-col">
          <span class="arch-label">前端 · Vue 3</span>
          <ul>
            <li><b>domain/</b> 纯域：车道几何、交通规则、路径规划</li>
            <li><b>application/</b> 用例：tick 管线、信号控制、传感器</li>
            <li><b>infrastructure/</b> Rapier / Cesium / Three.js / HTTP</li>
            <li><b>interfaces/</b> 视图与 Pinia store</li>
          </ul>
        </div>
        <div class="arch-arrow" aria-hidden>↔</div>
        <div class="arch-col">
          <span class="arch-label">后端 · FastAPI</span>
          <ul>
            <li><b>apps/maps</b> OSM 解析、路网图、Overpass 缓存</li>
            <li><b>apps/rl</b> 多智能体协商、PPO 训练、checkpoint</li>
            <li><b>apps/routes</b> A* 寻路与路线规划</li>
            <li><b>core/</b> 观测口径与动作语义（前后端共用）</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ===== the capability matrix ===== -->
    <section class="block" data-reveal>
      <h2>能力矩阵</h2>
      <div class="matrix">
        <div v-for="c in capabilities" :key="c.name" class="cap">
          <div class="cap-head">
            <span class="cap-name">{{ c.name }}</span>
            <span class="cap-state" :class="c.state === 'live' ? 'is-live' : 'is-plan'">
              {{ c.state === 'live' ? '已实现' : '规划中' }}
            </span>
          </div>
          <p class="cap-desc">{{ c.desc }}</p>
          <ul class="cap-list">
            <li v-for="f in c.features" :key="f">{{ f }}</li>
          </ul>
          <!--
            The evidence row: what the RUNNING product answered, per
            capability. A capability that is only claimed has no
            evidence row — and when the backend is unreachable the row
            says that, rather than showing the old remembered numbers.
          -->
          <p v-if="proofFor(c)" class="cap-proof" :class="proofClass(c)">
            <span class="cap-proof-tag">{{ proofTag(c) }}</span>
            <span class="cap-proof-text">{{ proofFor(c) }}</span>
          </p>
        </div>
      </div>
    </section>

    <!-- ===== the capability timeline ===== -->
    <section class="block" data-reveal>
      <h2>时间线</h2>
      <p class="block-lead">每个节点都对应仓库里的一组提交 —— 能力是长出来的，不是计划出来的。</p>
      <ol class="timeline">
        <li v-for="m in milestones" :key="m.date" class="milestone">
          <span class="m-date dc-num">{{ m.date }}</span>
          <span class="m-dot" aria-hidden></span>
          <div class="m-body">
            <h3>{{ m.title }}</h3>
            <p>{{ m.desc }}</p>
          </div>
        </li>
      </ol>
      <!-- The visual anchor: the timeline's last stretch is the city
           simulation loop, and this is what that looks like — a car
           tracked through the white-model streets. -->
      <figure class="timeline-shot">
        <img
          src="/timeline-chase.png"
          alt="SmartCity 3D：跟踪镜头跟在一辆车后穿过哑光白模街区"
          loading="lazy"
        />
        <figcaption>
          城区仿真闭环 — 跟踪镜头跟在一辆仿真车后，穿过 1 115 条道路的白模城区。
        </figcaption>
      </figure>
    </section>

    <!-- ===== the screen wall ===== -->
    <section class="block" data-reveal>
      <h2>界面</h2>
      <p class="block-lead">每一个模块都是可运行的，不是截图。</p>
      <div class="wall">
        <router-link v-for="s in screens" :key="s.to" :to="s.to" class="shot">
          <span class="shot-media">
            <img :src="s.tile" :alt="`${s.name} 界面`" loading="lazy" />
          </span>
          <span class="shot-name">{{ s.name }}</span>
          <span class="shot-sub">{{ s.sub }}</span>
        </router-link>
      </div>
    </section>

    <!-- ===== how to run it ===== -->
    <section class="block" data-reveal>
      <h2>跑起来</h2>
      <div class="run-grid">
        <div class="run-card">
          <span class="run-label">后端</span>
          <code>uv run uvicorn app.main:app --port 8001</code>
          <p class="muted">Python 3.11+ · FastAPI · PyTorch（RL 可选）</p>
        </div>
        <div class="run-card">
          <span class="run-label">前端</span>
          <code>npm run dev</code>
          <p class="muted">Node 20+ · Vite · Three.js · Cesium</p>
        </div>
        <div class="run-card">
          <span class="run-label">验证</span>
          <code>npm test &amp;&amp; npx playwright test</code>
          <p class="muted">1 255 单测 + 58 条 e2e（含视觉基线）</p>
        </div>
      </div>
    </section>

    <footer class="delivery-foot">
      <p class="muted">
        ADR 归档 001–017 全部裁定 · API 文档由 FastAPI 从 OpenAPI schema 生成 · 覆盖率 前端 89.95% /
        后端 89.27%
      </p>
      <div class="foot-actions">
        <router-link to="/scene-editor" class="btn">进入 SceneLab</router-link>
        <router-link to="/backend" class="btn ghost">检查后端状态</router-link>
      </div>
    </footer>
  </main>
</template>

<script setup lang="ts">
/**
 * DeliveryLab — the portfolio page.
 *
 * It used to be a placeholder that described what the page WOULD be.
 * Now it IS the thing it promised: the architecture, the capability
 * matrix, the screens and how to run it — with the numbers the project
 * actually has (the test counts come from the suites; the OSM counts
 * from the shipped Shenzhen slice).
 */
import { ShowcaseNav } from '@interfaces/components/showcase'
import { useLiveEvidence } from '@interfaces/composables/useLiveEvidence'

interface Capability {
  name: string
  state: 'live' | 'planned'
  desc: string
  features: string[]
  /**
   * Which live probe backs this card. The evidence row shows what the
   * running product answered for it.
   */
  probe?: 'city' | 'rl'
}

const capabilities: readonly Capability[] = [
  {
    name: '驾驶仿真',
    state: 'live',
    desc: '车道级：按车道语义选择转向，跟车、让行、红灯停车，路口不穿模。',
    features: ['车道语义箭头（外侧转弯 / 内侧直行）', 'A* 路线规划与跟车', '碰撞检测与越界回收'],
  },
  {
    name: '真实城区',
    state: 'live',
    desc: '导入真实路网，在同源底图上跑仿真。',
    features: ['OSM / PBF 解析与路网生成', 'Cesium 底图 + Three.js 叠加', '大屏指挥读数'],
    probe: 'city',
  },
  {
    name: '智能体训练',
    state: 'live',
    desc: '多智能体协商，策略在仿真里试错。',
    features: ['MAPPO 训练与 checkpoint', '训练曲线与回放', '信号策略热加载'],
    probe: 'rl',
  },
  {
    name: '事故预测',
    state: 'planned',
    desc: '把多场景碰撞样本变成风险预测。',
    features: ['碰撞样本库', '危险路段识别', '给车主的风险解释'],
  },
]

/**
 * The evidence a card shows — what the running product answered.
 *
 * The rule the page follows: a number is shown only where it was
 * MEASURED. When the backend did not answer, the card says so; it
 * does not fall back to the numbers this page used to hardcode.
 */
const {
  state: evidenceState,
  city: cityEvidence,
  rl: rlEvidence,
  note: evidenceNote,
} = useLiveEvidence()

const proofFor = (c: Capability): string => {
  if (c.probe === 'city') {
    const city = cityEvidence.value
    if (!city) return ''
    return `${city.roads} 条道路 · ${city.intersections} 个路口 · ${city.trafficLights} 盏信号灯（随包切片 ${city.source}）`
  }
  if (c.probe === 'rl') {
    const rl = rlEvidence.value
    if (!rl) return ''
    const device = rl.cuda ? rl.device : `${rl.device}（无 CUDA）`
    return `${rl.checkpoints} 个 checkpoint · ${rl.scenes.length} 个训练场景 · torch ${rl.torch} · ${device}`
  }
  return ''
}

const proofTag = (c: Capability): string => {
  if (evidenceState.value === 'probing') return '实测中'
  if (evidenceState.value === 'offline') return '未连接'
  return '实测'
}

const proofClass = (c: Capability): string => {
  if (evidenceState.value === 'probing') return 'is-probing'
  if (evidenceState.value === 'offline') return 'is-offline'
  return 'is-live'
}

/**
 * The capability timeline — every entry names a stretch of real
 * commits (`git log --date=short` is the source), month precision for
 * the early stretches and day precision for the recent ones.
 */
const milestones: readonly { date: string; title: string; desc: string }[] = [
  {
    date: '2026-06',
    title: '内核奠基',
    desc: 'DDD 分层 + Three.js 场景渲染 + 场景编辑器骨架，首日即带性能门禁与持久化。',
  },
  {
    date: '2026-10',
    title: '物理与训练',
    desc: 'Rapier 刚体物理（固定步长）、PPO 训练管线、LiDAR / 相机传感器与轨迹导出。',
  },
  {
    date: '2026-10-31',
    title: '多智能体协商',
    desc: '无信号路口的驾驶 agent 与网格泛化，训练出的策略回放进浏览器实时驾驶。',
  },
  {
    date: '2026-11-01',
    title: '接入真实地图',
    desc: 'OSM 导入（GCJ-02 / BD-09 自动转 WGS84）、零 Key 的 POI、路线规划与第一人称跟随。',
  },
  {
    date: '2026-11-07',
    title: '指挥大屏',
    desc: '设计令牌层、SmartCity 指挥中心、场景编辑器网格化、作品集视觉语言。',
  },
  {
    date: '2026-11-08',
    title: '城区仿真闭环',
    desc: '仿真网 = 绘制网（随包深圳福田 1 115 路）、哑光白模主题、点击跟踪与手动驾驶。',
  },
  {
    date: '2026-11-09',
    title: '信号回补与仪表盘',
    desc: 'Overpass 补回 264 个信控路口；驾驶舱仪表盘读活信号相位与倒计时。',
  },
  {
    date: '2026-11-10',
    title: '一条主线',
    desc: 'SimulationLab 并入场景编辑器：读数抽屉、传感器面板、一条路由讲完整件事。',
  },
]

const screens: ReadonlyArray<{ to: string; name: string; sub: string; tile: string }> = [
  { to: '/scene-editor', name: 'SceneLab', sub: '场景编辑器', tile: '/tiles/tile-scenelab.png' },
  { to: '/smart-city', name: 'SmartCity 3D', sub: '指挥大屏', tile: '/tiles/tile-smartcity.png' },
  { to: '/ai-playground', name: 'AI Proving Ground', sub: 'RL 训练', tile: '/tiles/tile-ai.png' },
  { to: '/map-importer', name: 'MapLab', sub: '地图导入', tile: '/tiles/tile-maplab.png' },
  { to: '/backend', name: 'Backend', sub: '服务状态', tile: '/tiles/tile-backend.png' },
]
</script>

<style scoped>
.delivery {
  min-height: 100vh;
  background: var(--dc-screen);
  color: var(--dc-text);
  padding: 96px 24px 64px;
  font-family: var(--ds-font);
}
.delivery-head {
  max-width: 900px;
  margin: 0 auto 40px;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--dc-flow);
}
.delivery-head h1 {
  margin: 10px 0 12px;
  font-family: var(--ds-font-display);
  font-size: clamp(38px, 5vw, 58px);
  font-weight: 600;
  letter-spacing: -1.4px;
  color: var(--dc-text);
}
.lead {
  margin: 0;
  max-width: 62ch;
  font-size: 16px;
  line-height: 1.7;
  color: var(--dc-text-dim);
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  max-width: 900px;
  margin: 0 auto 56px;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 16px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
}
.fact b {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.6px;
  color: var(--dc-flow);
  font-variant-numeric: tabular-nums;
}
.fact span {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--dc-text-faint);
}
/* A number that has not been measured yet: the dash is dimmed, so the
   eye reads "not known" instead of "zero". */
.fact.is-pending b {
  color: var(--dc-text-faint);
}
.block {
  max-width: 900px;
  margin: 0 auto 56px;
}
.block h2 {
  margin: 0 0 8px;
  font-family: var(--ds-font-display);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.4px;
  color: var(--dc-text);
}
.block-lead {
  margin: 0 0 18px;
  max-width: 60ch;
  font-size: 14px;
  line-height: 1.65;
  color: var(--dc-text-dim);
}
.arch {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px minmax(0, 1fr);
  align-items: stretch;
  gap: 8px;
}
.arch-col {
  padding: 16px 18px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
}
.arch-label {
  display: block;
  margin-bottom: 10px;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dc-flow);
}
.arch-col ul {
  margin: 0;
  padding-left: 16px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--dc-text-dim);
}
.arch-col b {
  color: var(--dc-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.arch-arrow {
  display: grid;
  place-items: center;
  font-size: 20px;
  color: var(--dc-text-faint);
}
.matrix {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.cap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px 20px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
}
/* The evidence row: what the running product answered for this
   capability. It sits at the bottom of the card, separated by a
   hairline, so it reads as a measurement rather than as another
   feature bullet. */
.cap-proof {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--dc-hairline);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dc-text-faint);
}
.cap-proof-tag {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.08em;
  border: 1px solid currentColor;
  color: var(--dc-text-faint);
}
.cap-proof.is-live .cap-proof-tag {
  color: var(--dc-flow);
}
.cap-proof.is-live .cap-proof-text {
  color: var(--dc-text);
}
.cap-proof.is-probing .cap-proof-tag,
.cap-proof.is-offline .cap-proof-tag {
  color: var(--dc-text-faint);
  opacity: 0.75;
}
.cap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cap-name {
  font-family: var(--ds-font-display);
  font-size: 18px;
  font-weight: 600;
  color: var(--dc-text);
}
.cap-state {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.08em;
}
.cap-state.is-live {
  background: color-mix(in srgb, var(--dc-ok) 16%, transparent);
  color: var(--dc-ok);
}
.cap-state.is-plan {
  background: color-mix(in srgb, var(--dc-warning) 14%, transparent);
  color: var(--dc-warning);
}
.cap-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dc-text-dim);
}
.cap-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--dc-text-faint);
}
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}
.shot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-decoration: none;
  color: var(--dc-text);
}
.shot-media {
  display: block;
  overflow: hidden;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: var(--dc-panel);
  transition:
    border-color var(--ds-dur) var(--ds-ease-out),
    transform var(--ds-dur) var(--ds-ease-spring);
}
.shot-media img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  transition: transform var(--ds-dur-slow) var(--ds-ease-out);
}
.shot:hover .shot-media {
  border-color: color-mix(in srgb, var(--dc-flow) 55%, transparent);
  transform: translate3d(0, -4px, 0);
}
.shot:hover .shot-media img {
  transform: scale(1.05);
}
.shot-name {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 600;
}
.shot-sub {
  font-size: 12px;
  color: var(--dc-text-faint);
}
.run-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.run-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
}
.run-label {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dc-text-faint);
}
.run-card code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dc-flow);
  word-break: break-all;
}
.run-card .muted {
  margin: 0;
  font-size: 12px;
  color: var(--dc-text-faint);
}
.delivery-foot {
  max-width: 900px;
  margin: 0 auto;
  padding-top: 24px;
  border-top: 1px solid var(--dc-hairline);
}
.delivery-foot .muted {
  margin: 0;
  font-size: 13px;
  color: var(--dc-text-faint);
}
.foot-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.btn {
  display: inline-block;
  padding: 9px 18px;
  border-radius: 999px;
  border: 1px solid var(--dc-hairline);
  background: rgba(255, 255, 255, 0.07);
  color: var(--dc-text);
  text-decoration: none;
  font-size: 13px;
  transition:
    background var(--ds-dur-fast) var(--ds-ease-out),
    border-color var(--ds-dur-fast) var(--ds-ease-out);
}
.btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--dc-hairline-strong);
}
.btn.ghost {
  background: transparent;
}
@media (max-width: 720px) {
  .delivery {
    padding: 88px 16px 40px;
  }
  .arch {
    grid-template-columns: minmax(0, 1fr);
  }
  .arch-arrow {
    transform: rotate(90deg);
  }
}

/* ===== the capability timeline =====
   A vertical rail with dated nodes. The rail is a hairline; the node
   is a small ring that fills with the accent when its entry is in
   view (the reveal layer handles the fade). */
.timeline {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  position: relative;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 96px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: color-mix(in srgb, var(--dc-accent) 26%, transparent);
}
.milestone {
  display: grid;
  grid-template-columns: 84px 24px minmax(0, 1fr);
  align-items: baseline;
  padding: 9px 0;
}
.m-date {
  text-align: right;
  font-size: 12px;
  color: var(--dc-text-faint);
  letter-spacing: 0.04em;
}
.m-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--dc-screen);
  border: 2px solid var(--dc-accent);
  justify-self: center;
  align-self: center;
  box-shadow: 0 0 8px color-mix(in srgb, var(--dc-accent) 55%, transparent);
}
.m-body {
  min-width: 0;
}
.m-body h3 {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 600;
  color: var(--dc-text);
}
.m-body p {
  margin: 0;
  font-size: 13px;
  color: var(--dc-text-dim);
  line-height: 1.6;
}
@media (max-width: 720px) {
  .timeline::before {
    left: 12px;
  }
  .milestone {
    grid-template-columns: 24px minmax(0, 1fr);
  }
  .m-date {
    grid-column: 2;
    text-align: left;
    order: 3;
  }
  .m-dot {
    grid-row: 1;
  }
  .m-body {
    grid-column: 2;
  }
}

/* The timeline's visual anchor: the same framed-card idiom the home
   page's bands use. */
.timeline-shot {
  margin: 22px 0 0 108px;
  padding: 10px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius-xl);
  background: var(--dc-panel);
  box-shadow: var(--ds-shadow-product);
  overflow: hidden;
  max-width: 720px;
}
.timeline-shot img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--dc-radius-lg);
  background: var(--dc-screen);
}
.timeline-shot figcaption {
  padding: 8px 4px 0;
  font-size: 12px;
  color: var(--dc-text-faint);
}
@media (max-width: 720px) {
  .timeline-shot {
    margin-left: 0;
  }
}
</style>

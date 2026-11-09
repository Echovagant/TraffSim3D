<template>
  <div ref="root" class="main-container">
    <EnhancedWebGLBackground />

    <ShowcaseNav />

    <main class="content-wrap">
      <section class="hero">
        <!--
          The hero is asymmetric on purpose (2026-11-07): a centred
          white card with a big title is the landing-page template every
          generated site has. The copy sits on the left, the evidence on
          the right — and the evidence is a real screenshot of the
          product, not a mock-up.
        -->
        <div class="hero-copy">
          <p class="hero-eyebrow gsap-hero-title">3D 智能交通仿真 · 多智能体 RL</p>
          <h1 class="hero-title gsap-hero-tagline">TraffSim3D</h1>
          <p class="hero-sub gsap-hero-sub">
            面向智慧城市的 3D 交通仿真平台 — 前端 Vue3 + Three.js，后端 FastAPI + PyTorch， 通过 DDD
            分层 + 多智能体 RL 引擎联合驱动。场景编辑器、物理仿真、OSM 地图导入、 智能体 RL
            训练，另附 SmartCity 3D 底图（Cesium + OSM 瓦片 + 真实建筑 3D 拉伸）。
          </p>
          <div class="hero-ctas gsap-hero-ctas">
            <router-link to="/scene-editor" class="btn primary">进入 SceneLab</router-link>
            <router-link to="/smart-city" class="btn">SmartCity 3D</router-link>
            <router-link to="/backend" class="btn ghost">后端状态</router-link>
          </div>
          <ul class="hero-facts">
            <li><b>8</b><span>模块路由</span></li>
            <li><b>1 255</b><span>前端单测</span></li>
            <li><b>5 422</b><span>深圳福田建筑</span></li>
            <li><b>460</b><span>信号灯</span></li>
          </ul>
        </div>
        <figure class="hero-shot">
          <img src="/scene-smartcity.png" alt="SmartCity 3D：OSM 底图上的仿真路网与车辆" />
          <figcaption>
            SmartCity 3D — 深圳福田：988 条道路、5 422 栋建筑、460 盏信号灯，仿真车辆跑在同源路网上
          </figcaption>
        </figure>
      </section>

      <!--
        The modules, presented as a narrative rather than a wall of
        cards (2026-11-07): the nav already lists them, so repeating
        them as a grid of equal tiles was wallpaper. The three that
        carry the story get a full-bleed band — a large screenshot
        with the copy beside it — and the rest live in a typographic
        index whose thumbnail arrives on hover.
      -->
      <section class="features">
        <header class="modules-header gsap-modules-header" data-reveal>
          <h2>能做什么</h2>
          <p>三条主线：驾驶仿真、真实城区、AI 训练。</p>
        </header>

        <article
          v-for="(m, i) in featured"
          :key="m.to"
          class="feature-band"
          :class="{ 'is-flipped': i % 2 === 1 }"
          data-reveal
        >
          <figure class="band-media">
            <img :src="m.tile" :alt="`${m.name} 界面`" loading="lazy" />
          </figure>
          <div class="band-copy">
            <span class="band-index">{{ String(i + 1).padStart(2, '0') }}</span>
            <h3>{{ m.name }}</h3>
            <p class="band-sub">{{ m.sub }}</p>
            <p class="band-desc">{{ m.desc }}</p>
            <router-link :to="m.to" class="band-link">
              打开 {{ m.name }}
              <span class="band-arrow" aria-hidden>→</span>
            </router-link>
          </div>
        </article>
      </section>

      <section class="modules">
        <header class="modules-header gsap-modules-header" data-reveal>
          <h2>模块索引</h2>
          <p>其余模块 — 悬停可预览界面。</p>
        </header>
        <ul class="module-index">
          <li v-for="m in rest" :key="m.to" data-reveal>
            <router-link :to="m.to" class="index-row">
              <span class="index-name">{{ m.name }}</span>
              <span class="index-sub">{{ m.sub }}</span>
              <span class="index-desc">{{ m.desc }}</span>
              <span class="index-thumb" aria-hidden>
                <img :src="m.tile" alt="" loading="lazy" />
              </span>
            </router-link>
          </li>
        </ul>
      </section>
    </main>

    <footer class="site-footer">
      <span>© {{ new Date().getFullYear() }} TraffSim3D</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * GSAP-powered homepage animations.
 *
 * Animation design (per the gsap-skills `gsap-frameworks` Vue 3
 * patterns + `gsap-scrolltrigger` recommendations):
 *
 *  1. Hero entrance (no scroll needed) — stagger fade-up on
 *     `.gsap-hero-*` selectors via `gsap.from()`. Runs once at
 *     `onMounted`, no ScrollTrigger.
 *
 *  2. Module cards stagger on scroll — `gsap.from('.module-card',
 *     { ..., stagger: 0.10, scrollTrigger: { trigger: grid, start:
 *     'top 82%' } })`. The 82% start triggers when the top of the
 *     grid is 18% above the bottom of the viewport — feels snappy
 *     without firing the moment the user scrolls.
 *
 *  3. Subtle hover lift on each card (CSS only, no GSAP — keeps
 *     the no-cost micro-interactions separate from the page-load
 *     animations).
 *
 * Cleanup: `ctx.revert()` in `onBeforeUnmount` kills tweens AND
 * ScrollTriggers and reverts inline styles. Critical for hot-reload
 * during dev (otherwise Vue re-mounts leave dangling ScrollTriggers).
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useReveal } from '@interfaces/composables/useReveal'
import { ShowcaseNav } from '@interfaces/components/showcase'
import { gsap } from 'gsap'
import EnhancedWebGLBackground from '@interfaces/components/showcase/EnhancedWebGLBackground.vue'

const root = ref<HTMLElement | null>(null)

/**
 * The modules, as data.
 *
 * The cards used to be hand-written markup; they are now rendered from
 * this list, which lets the page present them in two forms: the big
 * editorial bands (the three that carry the story) and the compact
 * index (all seven, with the thumbnail arriving on hover).
 */
interface ModuleEntry {
  to: string
  name: string
  sub: string
  desc: string
  badge: 'Active' | 'New' | 'Planned'
  tile: string
  /** Featured modules get a full-bleed band. */
  feature?: boolean
}

const MODULES: readonly ModuleEntry[] = [
  {
    to: '/scene-editor',
    name: 'SceneLab',
    sub: '场景编辑器',
    desc: '车道级驾驶仿真 + 实时读数：按车道语义转向、跟车、让行，信号控制与传感器 (LiDAR/相机) 就在同一页。',
    badge: 'Active',
    tile: '/tiles/tile-scenelab.png',
    feature: true,
  },
  {
    to: '/smart-city',
    name: 'SmartCity 3D',
    sub: '大屏 · Cesium + Three.js',
    desc: '真实城区路网上跑仿真：988 条道路、5 422 栋建筑，点击车辆跟踪或亲自驾驶探索城区。',
    badge: 'New',
    tile: '/tiles/tile-smartcity.png',
    feature: true,
  },
  {
    to: '/ai-playground',
    name: 'AI Proving Ground',
    sub: 'RL 训练 + 回放',
    desc: '多智能体协商：策略在仿真里试错，训练曲线与回放过程可逐步查看。',
    badge: 'Active',
    tile: '/tiles/tile-ai.png',
    feature: true,
  },
  {
    to: '/map-importer',
    name: 'MapLab',
    sub: 'OSM 地图导入与路网生成',
    desc: '解析 .osm / .pbf，生成可行驶路网，直接送进 SceneLab。',
    badge: 'Active',
    tile: '/tiles/tile-maplab.png',
  },
  {
    to: '/backend',
    name: 'Backend',
    sub: 'FastAPI 服务状态',
    desc: '从 OpenAPI schema 动态发现端点，实时探活与时延。',
    badge: 'Active',
    tile: '/tiles/tile-backend.png',
  },
  {
    to: '/deliverables',
    name: 'DeliveryLab',
    sub: '部署与交付物总览',
    desc: '架构、契约、交付清单与验收口径。',
    badge: 'Planned',
    tile: '/tiles/tile-deliverables.png',
  },
]

const featured = MODULES.filter((m) => m.feature)
const rest = MODULES.filter((m) => !m.feature)

let ctx: gsap.Context | null = null

onMounted(() => {
  if (!root.value) return
  ctx = gsap.context(() => {
    // 1) Hero — entrance stagger (no scroll)
    gsap.from('.gsap-hero-title', {
      autoAlpha: 0,
      y: 28,
      duration: 0.7,
      ease: 'power3.out',
    })
    gsap.from('.gsap-hero-tagline', {
      autoAlpha: 0,
      y: 16,
      duration: 0.6,
      ease: 'power2.out',
      delay: 0.15,
    })
    gsap.from('.gsap-hero-sub', {
      autoAlpha: 0,
      y: 12,
      duration: 0.5,
      ease: 'power2.out',
      delay: 0.28,
    })
    gsap.from('.gsap-hero-ctas', {
      autoAlpha: 0,
      y: 10,
      duration: 0.5,
      ease: 'power2.out',
      delay: 0.42,
    })
    // 2) Modules header — fade up when in view
    gsap.from('.gsap-modules-header', {
      autoAlpha: 0,
      y: 18,
      duration: 0.6,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: '.gsap-modules-header',
        start: 'top 85%',
        once: true,
        toggleActions: 'play none none reverse',
      },
    })
    // 3) Module cards — the scroll reveal is CSS + IntersectionObserver
    //    now (see `useReveal`): the GSAP tween that used to live here
    //    fought the new `data-reveal` classes, and the observer version
    //    is cheaper (no scroll listener, no per-frame layout).
  }, root.value)

  // The reveal layer: every `[data-reveal]` inside the page fades up
  // once, staggered, when it enters the viewport.
  useReveal(root, { stagger: 80 })
})

onBeforeUnmount(() => {
  // Kill tweens + ScrollTriggers + revert inline styles. Critical
  // for hot-reload (otherwise ScrollTriggers accumulate across
  // HMR cycles and fire for elements that no longer exist).
  ctx?.revert()
})
</script>

<style>
/* === Brand & layout ===
 * `.main-container` is intentionally TRANSPARENT — the WebGL particle canvas
 * sits behind it (`z-index: -1`). The light page background is set on `html`
 * so dark-mode browser extensions don't sneak a black background through. */
.main-container {
  position: relative;
  width: 100vw;
  min-height: 100vh;
  overflow-x: hidden;
  color: var(--dc-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}
html {
  /* The night surface (2026-11-07): the WebGL particle field behind
     the page blends ADDITIVELY, so it only reads as a glowing network
     mesh on a dark ground — on the old light page it was a pale tangle. */
  background: var(--dc-screen);
}

/* === Top nav === */
/* The page itself is the night surface — the WebGL particle field
   behind it uses ADDITIVE blending, so on a dark page the mesh glows
   instead of washing out (on the old light page it was a pale grey
   tangle). */
.content-wrap {
  background: transparent;
}

.title .project-name {
  font-weight: 700;
  font-size: 16px;
  display: block;
  letter-spacing: -0.01em;
}
.title .subtitle {
  font-size: 12px;
  color: rgba(15, 23, 42, 0.55);
  display: block;
}

/* SmartCity link has a violet gradient to signal it's
   the "new" 3D basemap entry (matches the imported-scene badge). */
.nav-link.nav-link-new {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.16), rgba(59, 130, 246, 0.16));
  color: #7c3aed;
  font-weight: 600;
}
.nav-link.nav-link-new:hover {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.28), rgba(59, 130, 246, 0.28));
  color: #5b21b6;
}

/* === Hero === */
.hero {
  padding: 140px 24px 60px;
  max-width: 1200px;
  margin: 0 auto;
}
.hero-card {
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 18px;
  padding: 44px 48px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.6) inset,
    0 24px 48px -16px rgba(15, 23, 42, 0.16);
}
.hero-card h1 {
  font-size: 44px;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--dc-accent), #7c3aed);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-tagline {
  font-size: 16px;
  line-height: 1.65;
  color: color-mix(in srgb, var(--dc-panel) 78%, transparent);
  margin: 12px 0 8px;
}
.hero-sub {
  font-size: 13px;
  color: rgba(15, 23, 42, 0.55);
  margin: 0 0 28px;
}
.hero-ctas {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition:
    transform 0.15s,
    background 0.18s,
    box-shadow 0.18s;
  background: var(--dc-accent);
  color: #fff;
  border: 1px solid var(--dc-accent);
}
.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 16px -4px rgba(29, 78, 216, 0.4);
}
.btn.primary {
  background: linear-gradient(135deg, #7c3aed, var(--dc-accent));
  border-color: transparent;
}
.btn.primary:hover {
  box-shadow: 0 8px 16px -4px rgba(124, 58, 237, 0.4);
}
.btn.ghost {
  background: transparent;
  color: rgba(15, 23, 42, 0.75);
  border-color: rgba(15, 23, 42, 0.18);
}
.btn.ghost:hover {
  background: rgba(15, 23, 42, 0.04);
  box-shadow: none;
  transform: none;
}

/* === Modules grid === */
.modules {
  max-width: 1200px;
  margin: 0 auto;
  padding: 40px 24px 80px;
}
.modules-header {
  text-align: center;
  margin-bottom: 32px;
}
.modules-header h2 {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
}
.modules-header p {
  margin: 0;
  color: rgba(15, 23, 42, 0.6);
  font-size: 14px;
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 18px;
}

.module-card {
  display: flex;
  gap: 16px;
  padding: 22px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 14px;
  text-decoration: none;
  color: inherit;
  position: relative;
  overflow: hidden;
  transition:
    transform 0.18s,
    box-shadow 0.18s,
    border-color 0.18s;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.module-card:hover {
  transform: translateY(-3px);
  border-color: rgba(59, 130, 246, 0.3);
  box-shadow: 0 12px 24px -8px rgba(15, 23, 42, 0.18);
}
.module-card.router-link-active {
  border-color: rgba(59, 130, 246, 0.4);
  background: rgba(255, 255, 255, 0.92);
}

/* SmartCity card gets the "featured" violet gradient
   to distinguish it from the regular modules. The hover effect
   is amplified (slightly more lift, more glow). */
.module-card.module-card-featured {
  background:
    linear-gradient(135deg, rgba(168, 85, 247, 0.06), rgba(59, 130, 246, 0.06)),
    rgba(255, 255, 255, 0.85);
  border-color: rgba(168, 85, 247, 0.25);
}
.module-card.module-card-featured:hover {
  border-color: rgba(168, 85, 247, 0.45);
  box-shadow: 0 16px 32px -10px rgba(124, 58, 237, 0.32);
}

.module-icon {
  font-size: 28px;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 10px;
}
.module-card-featured .module-icon {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.18), rgba(59, 130, 246, 0.18));
}

.module-body {
  flex: 1 1 auto;
  min-width: 0;
}
.module-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.module-title-row h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.module-sub {
  font-size: 12px;
  color: rgba(15, 23, 42, 0.55);
  margin: 0 0 10px;
}
.module-desc {
  font-size: 13px;
  line-height: 1.55;
  color: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  margin: 0;
}
.module-desc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.badge-active {
  background: rgba(34, 197, 94, 0.18);
  color: #047857;
}
.badge-planned {
  background: color-mix(in srgb, var(--dc-text-dim) 22%, transparent);
  color: rgba(15, 23, 42, 0.55);
}
/* Badge for the brand-new SmartCity card. Violet gradient
   matches the featured-card border to signal "new + featured". */
.badge-new {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.22), rgba(59, 130, 246, 0.22));
  color: #7c3aed;
}

/* === Footer === */
.site-footer {
  text-align: center;
  padding: 24px 16px 36px;
  font-size: 12px;
  color: color-mix(in srgb, var(--dc-panel) 50%, transparent);
}

/* ===================================================================
   The night skin (2026-11-07).

   The page was a light theme: white nav, a big white hero card, pale
   module cards — the generic landing-page look, and it disagreed with
   the dark instrument language the editor and the Smart City screen now
   speak. The animated background stays (it is the only motion on the
   page and it reads as a network mesh, which is the point); everything
   ON TOP of it is re-skinned with the `--dc-*` tokens.

   The rules below only restyle; no markup outside the hero changed.
   =================================================================== */

.top-nav {
  background: color-mix(in srgb, var(--dc-panel) 78%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid color-mix(in srgb, var(--dc-accent) 40%, transparent);
  color: var(--dc-text);
}
.top-nav .nav-link {
  color: var(--dc-text-dim);
}
.top-nav .nav-link:hover {
  color: var(--dc-flow);
}
.top-nav .brand {
  color: var(--dc-text);
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  align-items: center;
  gap: 40px;
  padding: 56px 0 40px;
}
.hero-copy {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.hero-eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--dc-flow);
}
.hero-title {
  margin: 0;
  font-size: clamp(38px, 5vw, 62px);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.02;
  color: var(--dc-text);
  text-shadow: 0 0 34px color-mix(in srgb, var(--dc-flow) 30%, transparent);
}
.hero-sub {
  margin: 0;
  max-width: 56ch;
  font-size: 14px;
  line-height: 1.75;
  color: var(--dc-text-dim);
}
.hero-ctas {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.hero-ctas .btn {
  padding: 9px 18px;
  border-radius: var(--dc-radius);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 45%, transparent);
  background: color-mix(in srgb, var(--dc-panel) 72%, transparent);
  color: var(--dc-text);
  font-size: 13px;
  letter-spacing: 0.06em;
  text-decoration: none;
  transition:
    border-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
}
.hero-ctas .btn:hover {
  border-color: var(--dc-flow);
  color: var(--dc-flow);
  transform: translateY(-1px);
}
.hero-ctas .btn.primary {
  background: color-mix(in srgb, var(--dc-flow) 26%, transparent);
  border-color: var(--dc-flow);
  color: var(--dc-text);
  box-shadow: 0 0 20px color-mix(in srgb, var(--dc-flow) 22%, transparent);
}
.hero-facts {
  list-style: none;
  display: flex;
  gap: 26px;
  margin: 14px 0 0;
  padding: 0;
  flex-wrap: wrap;
}
.hero-facts li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hero-facts b {
  font-size: 20px;
  font-weight: 600;
  color: var(--dc-flow);
  font-variant-numeric: tabular-nums;
}
.hero-facts span {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--dc-text-faint);
}
/* The evidence: a real screenshot of the product. */
.hero-shot {
  margin: 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 38%, transparent);
  border-radius: var(--dc-radius-lg);
  background: color-mix(in srgb, var(--dc-panel) 74%, transparent);
  box-shadow: 0 18px 50px rgba(2, 6, 23, 0.55);
}
.hero-shot img {
  display: block;
  width: 100%;
  border-radius: var(--dc-radius);
  background: var(--dc-screen);
}
.hero-shot figcaption {
  padding: 8px 4px 2px;
  font-size: 11px;
  color: var(--dc-text-faint);
  letter-spacing: 0.04em;
}

/* ===== the module matrix ===== */
.modules-header {
  text-align: left;
  margin-bottom: 18px;
}
.modules-header h2 {
  color: var(--dc-text);
  font-size: 22px;
  letter-spacing: 0.02em;
}
.modules-header p {
  color: var(--dc-text-faint);
  font-size: 13px;
}
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(258px, 1fr));
  gap: 12px;
}
.module-card {
  background: color-mix(in srgb, var(--dc-panel) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--dc-accent) 30%, transparent);
  border-radius: var(--dc-radius);
  color: var(--dc-text);
  transition:
    border-color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.18s ease;
}
.module-card:hover {
  border-color: color-mix(in srgb, var(--dc-flow) 55%, transparent);
  transform: translateY(-2px);
  box-shadow: 0 12px 30px rgba(2, 6, 23, 0.45);
}
.module-card h3 {
  color: var(--dc-text);
}
.module-sub {
  color: var(--dc-flow);
}
.module-desc {
  color: var(--dc-text-dim);
}
.module-icon {
  background: color-mix(in srgb, var(--dc-accent) 22%, transparent);
}
.badge-active {
  background: color-mix(in srgb, var(--dc-ok) 18%, transparent);
  color: color-mix(in srgb, var(--dc-ok) 88%, var(--dc-text));
}

.site-footer {
  border-top: 1px solid color-mix(in srgb, var(--dc-accent) 30%, transparent);
  color: var(--dc-text-faint);
  text-align: left;
}

@media (max-width: 980px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
    padding-top: 32px;
  }
  .hero-shot {
    order: -1;
  }
}

/* ===================================================================
   The showcase skin (2026-11-07, second pass).

   The brief changed: this is a PORTFOLIO piece — the point is to show
   design thinking, front-end craft and motion, not to be merely
   practical. So the page moves to Apple's system language (taken from
   the design-md Apple DESIGN.md — real type scale with its negative
   tracking, hairline rules, the near-black tile surfaces, Action Blue)
   and the cards become TILES: a real screenshot of the product, the
   icon floating over it, and hover physics (the tile lifts, the
   image zooms a touch, the arrow slides).
   =================================================================== */

.main-container {
  color: var(--dc-text);
  font-family: var(--ds-font);
}

/* ===== the floating glass nav ===== */
.top-nav {
  background: transparent;
  border-bottom: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  padding-top: 14px;
}
.nav-inner {
  max-width: 1180px;
  margin: 0 auto;
  padding: 8px 10px 8px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--dc-hairline);
  border-radius: 999px;
  background: var(--dc-chrome);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  transition:
    transform var(--ds-dur) var(--ds-ease-spring),
    background var(--ds-dur) var(--ds-ease-out);
}
.brand {
  color: var(--dc-text);
  text-decoration: none;
  transition: opacity var(--ds-dur-fast) var(--ds-ease-out);
}
.brand:hover {
  opacity: 0.72;
}
.brand .logo {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: linear-gradient(160deg, #2b6cff, #7d4bff);
  box-shadow: 0 4px 14px rgba(43, 108, 255, 0.4);
  font-size: 15px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 2px;
}
.nav-link {
  position: relative;
  padding: 7px 13px;
  border-radius: 999px;
  font-size: 13px;
  letter-spacing: -0.1px;
  color: var(--dc-text-dim);
  text-decoration: none;
  transition:
    color var(--ds-dur-fast) var(--ds-ease-out),
    background var(--ds-dur-fast) var(--ds-ease-out);
}
.nav-link:hover {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.07);
}
.nav-link.router-link-active {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.12);
}
/* The "New" dot keeps its accent but loses the loud pill. */

/* ===== the hero ===== */
.hero {
  padding: calc(var(--ds-space-8) + 20px) 0 var(--ds-space-7);
}
.hero-title {
  font-family: var(--ds-font-display);
  font-size: clamp(44px, 6.2vw, 76px);
  font-weight: 600;
  letter-spacing: -1.6px;
  line-height: 1.04;
  /* The display face is a gradient on the night theme; on the paper
     theme a white-to-grey gradient would be invisible, so the ink
     gradient runs the other way. */
  background: linear-gradient(180deg, #ffffff 30%, #9aa0ab);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: none;
}
:root[data-theme='paper'] .hero-title {
  background: linear-gradient(180deg, #1d1d1f 30%, #6b6b70);
  -webkit-background-clip: text;
  background-clip: text;
}
.hero-eyebrow {
  font-size: 13px;
  letter-spacing: 0.22em;
  color: var(--dc-flow);
  text-transform: uppercase;
}
.hero-sub {
  font-size: var(--ds-body-size);
  letter-spacing: var(--ds-body-track);
  color: var(--dc-text-dim);
}
.hero-shot {
  background: var(--dc-panel);
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius-xl);
  box-shadow: var(--ds-shadow-product);
  padding: 10px;
}

/* ===== the module tiles ===== */
.modules {
  padding-bottom: var(--ds-space-8);
}
.modules-header {
  text-align: left;
  margin-bottom: var(--ds-space-5);
}
.modules-header h2 {
  font-family: var(--ds-font-display);
  font-size: 34px;
  font-weight: 600;
  letter-spacing: -0.6px;
  color: var(--dc-text);
}
.modules-header p {
  font-size: 15px;
  color: var(--dc-text-faint);
}
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(272px, 1fr));
  gap: 16px;
}
.module-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 0 18px;
  overflow: hidden;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius-lg);
  background: var(--dc-panel);
  color: var(--dc-text);
  text-decoration: none;
  transition:
    transform var(--ds-dur) var(--ds-ease-spring),
    border-color var(--ds-dur) var(--ds-ease-out),
    box-shadow var(--ds-dur) var(--ds-ease-out);
}
.module-card:hover {
  transform: translate3d(0, -6px, 0);
  border-color: var(--dc-hairline-strong);
  box-shadow: var(--ds-shadow-product);
}
/* The screenshot: the product speaks first. */
.ds-tile-media {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--dc-screen);
  border-bottom: 1px solid var(--dc-hairline);
}
.ds-tile-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transform: scale(1.01);
  transition: transform var(--ds-dur-slow) var(--ds-ease-out);
}
.module-card:hover .ds-tile-media img {
  transform: scale(1.06);
}
/* The icon rides on the media's lower-left corner. */
.module-card .module-icon {
  position: absolute;
  top: calc(50% - 60px);
  left: 16px;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--dc-hairline);
  font-size: 18px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  transition: transform var(--ds-dur) var(--ds-ease-spring);
}
.module-card:hover .module-icon {
  transform: translate3d(0, -3px, 0) scale(1.06);
}
.module-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 16px;
}
.module-card h3 {
  font-family: var(--ds-font-display);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.3px;
  color: var(--dc-text);
}
.module-sub {
  font-size: 13px;
  letter-spacing: 0.01em;
  color: var(--dc-flow);
}
.module-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--dc-text-dim);
}
.module-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge-active {
  background: rgba(48, 209, 88, 0.16);
  color: #30d158;
}
.badge-new {
  background: rgba(100, 210, 255, 0.16);
  color: #64d2ff;
}
.badge-planned {
  background: rgba(255, 214, 10, 0.14);
  color: #ffd60a;
}
/* The featured tile spans two columns and carries the hero shot. */
.module-card-featured {
  grid-column: span 2;
}
.module-card-featured .ds-tile-media {
  aspect-ratio: 21 / 9;
}

.site-footer {
  border-top: 1px solid var(--dc-hairline);
  color: var(--dc-text-faint);
  text-align: left;
  padding: 28px 0 40px;
}

/* ===================================================================
   The editorial form (2026-11-07).

   The modules are no longer a grid of equal tiles. The three that
   carry the story are full-bleed BANDS — a large product shot beside
   the copy, alternating sides — and the rest are typographic INDEX
   ROWS whose thumbnail arrives on hover. The nav already lists every
   module; repeating them as a wall of cards was wallpaper.
   =================================================================== */

.features {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-8);
  padding-bottom: var(--ds-space-8);
}
.feature-band {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  align-items: center;
  gap: var(--ds-space-7);
}
.feature-band.is-flipped {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
}
.feature-band.is-flipped .band-media {
  order: 2;
}
.band-media {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--dc-hairline);
  border-radius: var(--dc-radius-xl);
  background: var(--dc-panel);
  box-shadow: var(--ds-shadow-product);
  overflow: hidden;
}
.band-media img {
  display: block;
  width: 100%;
  /* A fixed ratio so the bands line up whatever the screenshot's shape
     is — a 4:5 shot would otherwise leave the band twice as tall. */
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--dc-radius-lg);
  background: var(--dc-screen);
  transform: scale(1.01);
  transition: transform var(--ds-dur-slow) var(--ds-ease-out);
}
.feature-band:hover .band-media img {
  transform: scale(1.04);
}
.band-copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.band-index {
  font-family: var(--ds-font-display);
  font-size: 13px;
  letter-spacing: 0.22em;
  color: var(--dc-flow);
}
.band-copy h3 {
  margin: 0;
  font-family: var(--ds-font-display);
  font-size: clamp(26px, 3vw, 38px);
  font-weight: 600;
  letter-spacing: -0.6px;
  color: var(--dc-text);
}
.band-sub {
  margin: 0;
  font-size: 14px;
  color: var(--dc-flow);
}
.band-desc {
  margin: 0;
  max-width: 46ch;
  font-size: 15px;
  line-height: 1.65;
  color: var(--dc-text-dim);
}
/* The link with its arrow nested in its own disc (Apple's
   button-in-button). */
.band-link {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  padding: 9px 8px 9px 18px;
  border-radius: 999px;
  border: 1px solid var(--dc-hairline);
  background: color-mix(in srgb, var(--dc-panel) 70%, transparent);
  color: var(--dc-text);
  font-size: 13px;
  text-decoration: none;
  width: fit-content;
  transition:
    border-color var(--ds-dur-fast) var(--ds-ease-out),
    transform var(--ds-dur) var(--ds-ease-spring);
}
.band-link:hover {
  border-color: var(--dc-flow);
  transform: translate3d(0, -2px, 0);
}
.band-arrow {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--dc-flow);
  transition: transform var(--ds-dur) var(--ds-ease-spring);
}
.band-link:hover .band-arrow {
  transform: translate3d(2px, 0, 0);
}
:root[data-theme='paper'] .band-arrow {
  background: rgba(0, 0, 0, 0.06);
}

/* ===== the index ===== */
.modules {
  padding-bottom: var(--ds-space-8);
}
.module-index {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--dc-hairline);
}
.module-index li {
  border-bottom: 1px solid var(--dc-hairline);
}
.index-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 220px) minmax(0, 260px) minmax(0, 1fr);
  align-items: baseline;
  gap: 18px;
  padding: 18px 4px;
  color: var(--dc-text);
  text-decoration: none;
  transition: background var(--ds-dur-fast) var(--ds-ease-out);
}
.index-row:hover {
  background: color-mix(in srgb, var(--dc-panel) 55%, transparent);
}
.index-name {
  font-family: var(--ds-font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.3px;
}
.index-sub {
  font-size: 13px;
  color: var(--dc-flow);
}
.index-desc {
  font-size: 13px;
  line-height: 1.55;
  color: var(--dc-text-faint);
}
/* The thumbnail arrives on hover — the preview the cards used to give,
   without the wall. */
.index-thumb {
  position: absolute;
  right: 12px;
  top: 50%;
  width: 220px;
  transform: translate3d(0, -46%, 0) scale(0.96);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--ds-dur) var(--ds-ease-out),
    transform var(--ds-dur) var(--ds-ease-spring);
}
.index-thumb img {
  display: block;
  width: 100%;
  border-radius: var(--dc-radius);
  border: 1px solid var(--dc-hairline-strong);
  box-shadow: var(--ds-shadow-product);
}
.index-row:hover .index-thumb {
  opacity: 1;
  transform: translate3d(0, -50%, 0) scale(1);
}
/* On a narrow screen the preview is dropped rather than squeezed. */
@media (max-width: 900px) {
  .feature-band,
  .feature-band.is-flipped {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--ds-space-5);
  }
  .feature-band.is-flipped .band-media {
    order: 0;
  }
  .index-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .index-thumb {
    display: none;
  }
}
</style>

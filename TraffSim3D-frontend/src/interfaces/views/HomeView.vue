<template>
  <div ref="root" class="main-container">
    <EnhancedWebGLBackground />

    <header class="top-nav" role="navigation" aria-label="主导航">
      <div class="nav-inner">
        <router-link to="/" class="brand" aria-label="返回首页">
          <div class="logo" aria-hidden>🛰️</div>
          <div class="title">
            <span class="project-name">TraffSim3D</span>
            <small class="subtitle">3D 智能交通仿真 · 多智能体 RL</small>
          </div>
        </router-link>

        <nav class="nav-links" aria-label="模块导航">
          <router-link to="/scene-editor" class="nav-link">SceneLab</router-link>
          <router-link to="/simulation-lab" class="nav-link">SimulationLab</router-link>
          <router-link to="/map-importer" class="nav-link">MapLab</router-link>
          <router-link to="/smart-city" class="nav-link nav-link-new">SmartCity 3D</router-link>
          <router-link to="/ai-playground" class="nav-link">AI Proving Ground</router-link>
          <router-link to="/deliverables" class="nav-link">DeliveryLab</router-link>
          <router-link to="/backend" class="nav-link">Backend</router-link>
        </nav>
      </div>
    </header>

    <main class="content-wrap">
      <section class="hero">
        <div class="hero-card">
          <h1 class="gsap-hero-title">TraffSim3D</h1>
          <p class="hero-tagline gsap-hero-tagline">
            面向智慧城市的 3D 交通仿真平台 — 前端 Vue3 + Three.js，后端 FastAPI + PyTorch，
            通过 DDD 分层 + 多智能体 RL 引擎联合驱动。
          </p>
          <p class="hero-sub gsap-hero-sub">
            M1–M4 已交付：场景编辑器、物理仿真、OSM 地图导入、智能体 RL 训练。M3 新增 SmartCity 3D 底图(基于 Cesium + 高德瓦片 + 真实建筑 3D 拉伸)。
          </p>
          <div class="hero-ctas gsap-hero-ctas">
            <router-link to="/scene-editor" class="btn">进入 SceneLab</router-link>
            <router-link to="/smart-city" class="btn primary">🛰️ SmartCity 3D</router-link>
            <router-link to="/backend" class="btn ghost">查看后端状态</router-link>
          </div>
        </div>
      </section>

      <section class="modules">
        <header class="modules-header gsap-modules-header">
          <h2>产品模块矩阵</h2>
          <p>每个模块对应一个前端路由和一个后端 app，按里程碑逐步交付。</p>
        </header>

        <div class="module-grid gsap-module-grid">
          <router-link to="/scene-editor" class="module-card status-active">
            <div class="module-icon" aria-hidden>🚦</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>SceneLab</h3>
                <span class="badge badge-active">M1 · Active</span>
              </div>
              <p class="module-sub">场景编辑器 / SceneEditor</p>
              <p class="module-desc">
                3D 场景：车辆、信号灯、道路。已实现车迹、车道线（黄实线 + 白虚线）、信号灯相位倒计时条、选中高亮环、LocalStorage 持久化、并通过 Vite proxy 调用后端 health/ping。
              </p>
            </div>
          </router-link>

          <router-link to="/simulation-lab" class="module-card status-active">
            <div class="module-icon" aria-hidden>🧪</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>SimulationLab</h3>
                <span class="badge badge-active">M2 · Active</span>
              </div>
              <p class="module-sub">物理 + 传感器仿真</p>
              <p class="module-desc">
                接入 Rapier WASM 做车辆动力学、碰撞检测；叠加 lidar / camera / IMU 传感器仿真，为 RL 训练提供真实可微的观测空间。
              </p>
            </div>
          </router-link>

          <router-link to="/map-importer" class="module-card status-active">
            <div class="module-icon" aria-hidden>🗺️</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>MapLab</h3>
                <span class="badge badge-active">M3 · Active</span>
              </div>
              <p class="module-sub">OSM 地图导入与路网生成</p>
              <p class="module-desc">
                解析 OpenStreetMap 的 <code>.osm</code> / <code>.pbf</code> 文件 → 路网 graph → SceneLab 加载。
                通过后端 <code>apps/maps</code> (PostGIS) 持久化, 前端拉取并渲染。
              </p>
            </div>
          </router-link>

          <!-- Plan 055: SmartCity 3D basemap (Cesium + Three.js overlay) -->
          <router-link
            to="/smart-city"
            class="module-card status-active module-card-featured"
            data-testid="smart-city-card"
          >
            <div class="module-icon" aria-hidden>🛰️</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>SmartCity 3D</h3>
                <span class="badge badge-new">M3 · New</span>
              </div>
              <p class="module-sub">智慧城市 3D 底图（Cesium + 高德瓦片）</p>
              <p class="module-desc">
                Cesium 1.134 渲染高德瓦片 + OSM 3D 拉伸建筑 + 道路多段线,Three.js 透明 overlay 渲染车辆 + 信号灯 + LiDAR。
                鸟瞰 / 平视 / 自由 切换;Overpass 数据经后端缓存,首次冷启动 &lt; 100ms。
              </p>
            </div>
          </router-link>

          <router-link to="/ai-playground" class="module-card status-active">
            <div class="module-icon" aria-hidden>🤖</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>AI Proving Ground</h3>
                <span class="badge badge-active">M4 · Active</span>
              </div>
              <p class="module-sub">RL 训练 + 回放</p>
              <p class="module-desc">
                与后端 apps/rl (PyTorch + Gymnasium) 联动:多智能体策略训练、回放 buffer 可视化、学到策略的影子车在 SceneLab 里 replay。
              </p>
            </div>
          </router-link>

          <router-link to="/deliverables" class="module-card status-planned">
            <div class="module-icon" aria-hidden>📦</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>DeliveryLab</h3>
                <span class="badge badge-planned">M5 · Planned</span>
              </div>
              <p class="module-sub">部署与交付物总览</p>
              <p class="module-desc">
                Docker Compose 启动清单、ADR 归档、API 文档、测试覆盖率报告的目录页。
                不引入新功能, 只把前 4 个里程碑的可交付物集中展示给项目接手人。
              </p>
            </div>
          </router-link>

          <router-link to="/backend" class="module-card status-active">
            <div class="module-icon" aria-hidden>⚙️</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>Backend Services</h3>
                <span class="badge badge-active">M1 · Active</span>
              </div>
              <p class="module-sub">FastAPI 服务面</p>
              <p class="module-desc">
                所有模块的统一 API 入口。当前已暴露 <code>GET /health</code> 与 <code>GET /api/v1/ping</code> 两个 smoke 端点;scene sync、tick stream、RL control 等接口在 M2–M4 落地。
              </p>
            </div>
          </router-link>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <span>© {{ new Date().getFullYear() }} TraffSim3D</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * Plan 057: GSAP-powered homepage animations.
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
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { gsap } from 'gsap';
import EnhancedWebGLBackground from '@interfaces/components/showcase/EnhancedWebGLBackground.vue';

const root = ref<HTMLElement | null>(null);
let ctx: gsap.Context | null = null;

onMounted(() => {
  if (!root.value) return;
  ctx = gsap.context(() => {
    // 1) Hero — entrance stagger (no scroll)
    gsap.from('.gsap-hero-title', {
      autoAlpha: 0,
      y: 28,
      duration: 0.7,
      ease: 'power3.out',
    });
    gsap.from('.gsap-hero-tagline', {
      autoAlpha: 0,
      y: 16,
      duration: 0.6,
      ease: 'power2.out',
      delay: 0.15,
    });
    gsap.from('.gsap-hero-sub', {
      autoAlpha: 0,
      y: 12,
      duration: 0.5,
      ease: 'power2.out',
      delay: 0.28,
    });
    gsap.from('.gsap-hero-ctas', {
      autoAlpha: 0,
      y: 10,
      duration: 0.5,
      ease: 'power2.out',
      delay: 0.42,
    });
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
    });
    // 3) Module cards — stagger fade-up when grid enters viewport
    gsap.from('.module-card', {
      autoAlpha: 0,
      y: 32,
      duration: 0.55,
      ease: 'power3.out',
      stagger: 0.10,
      scrollTrigger: {
        trigger: '.gsap-module-grid',
        start: 'top 82%',
        once: true,
        toggleActions: 'play none none reverse',
      },
    });
  }, root.value);
});

onBeforeUnmount(() => {
  // Kill tweens + ScrollTriggers + revert inline styles. Critical
  // for hot-reload (otherwise ScrollTriggers accumulate across
  // HMR cycles and fire for elements that no longer exist).
  ctx?.revert();
});
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
  color: rgba(15, 23, 42, 0.92);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}
html { background: #f8fafc; }

/* === Top nav === */
.top-nav {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 2;
  backdrop-filter: blur(8px);
  background: linear-gradient(to right, rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6));
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
}
.nav-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: inherit;
}
.brand .logo {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  background: rgba(59, 130, 246, 0.12);
  border-radius: 10px;
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

.nav-links {
  display: flex;
  gap: 6px;
  align-items: center;
}
.nav-link {
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: rgba(15, 23, 42, 0.75);
  text-decoration: none;
  transition: background 0.18s, color 0.18s;
}
.nav-link:hover { background: rgba(15, 23, 42, 0.06); color: rgba(15, 23, 42, 0.95); }
.nav-link.router-link-active {
  background: rgba(59, 130, 246, 0.12);
  color: #1d4ed8;
}

/* Plan 057: SmartCity link has a violet gradient to signal it's
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
  background: linear-gradient(135deg, #1d4ed8, #7c3aed);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-tagline {
  font-size: 16px;
  line-height: 1.65;
  color: rgba(15, 23, 42, 0.78);
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
  transition: transform 0.15s, background 0.18s, box-shadow 0.18s;
  background: #1d4ed8;
  color: #fff;
  border: 1px solid #1d4ed8;
}
.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 16px -4px rgba(29, 78, 216, 0.4);
}
.btn.primary {
  background: linear-gradient(135deg, #7c3aed, #1d4ed8);
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
.modules-header { text-align: center; margin-bottom: 32px; }
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
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
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

/* Plan 057: SmartCity card gets the "featured" violet gradient
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

.module-body { flex: 1 1 auto; min-width: 0; }
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
  color: rgba(15, 23, 42, 0.7);
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
  background: rgba(148, 163, 184, 0.2);
  color: rgba(15, 23, 42, 0.55);
}
/* Plan 057: badge for the brand-new SmartCity card. Violet gradient
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
  color: rgba(15, 23, 42, 0.5);
}
</style>
<template>
  <div class="main-container">
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
          <router-link to="/ai-playground" class="nav-link">AI Proving Ground</router-link>
          <router-link to="/deliverables" class="nav-link">DeliveryLab</router-link>
          <router-link to="/backend" class="nav-link">Backend</router-link>
        </nav>
      </div>
    </header>

    <main class="content-wrap">
      <section class="hero">
        <div class="hero-card">
          <h1>TraffSim3D</h1>
          <p class="hero-tagline">
            面向智慧城市的 3D 交通仿真平台 — 前端 Vue3 + Three.js，后端 FastAPI + PyTorch，
            通过 DDD 分层 + 多智能体 RL 引擎联合驱动。
          </p>
          <p class="hero-sub">
            M1 已交付：场景编辑器（SceneLab）+ 后端 smoke 联调。 后续 M2–M5 将在此基础上叠加物理、OSM 地图、强化学习训练与交付流水线。
          </p>
          <div class="hero-ctas">
            <router-link to="/scene-editor" class="btn">进入 SceneLab</router-link>
            <router-link to="/backend" class="btn ghost">查看后端状态</router-link>
          </div>
        </div>
      </section>

      <section class="modules">
        <header class="modules-header">
          <h2>五大产品模块</h2>
          <p>每个模块对应一个前端路由和一个后端 app，按里程碑逐步交付。</p>
        </header>

        <div class="module-grid">
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

          <router-link to="/simulation-lab" class="module-card status-planned">
            <div class="module-icon" aria-hidden>🧪</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>SimulationLab</h3>
                <span class="badge badge-planned">M2 · Planned</span>
              </div>
              <p class="module-sub">物理 + 传感器仿真</p>
              <p class="module-desc">
                接入 Rapier WASM 做车辆动力学、碰撞检测；叠加 lidar / camera / IMU 传感器仿真，为 RL 训练提供真实可微的观测空间。
              </p>
            </div>
          </router-link>

          <router-link to="/map-importer" class="module-card status-planned">
            <div class="module-icon" aria-hidden>🗺️</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>MapLab</h3>
                <span class="badge badge-planned">M3 · Planned</span>
              </div>
              <p class="module-sub">OSM 地图导入与路网生成</p>
              <p class="module-desc">
                解析 OpenStreetMap 的 <code>.osm</code> / <code>.pbf</code> 文件 → 路网 graph → SceneLab 加载。
                通过后端 <code>apps/maps</code> (PostGIS) 持久化, 前端拉取并渲染。
              </p>
            </div>
          </router-link>

          <router-link to="/ai-playground" class="module-card status-planned">
            <div class="module-icon" aria-hidden>🤖</div>
            <div class="module-body">
              <div class="module-title-row">
                <h3>AI Proving Ground</h3>
                <span class="badge badge-planned">M4 · Planned</span>
              </div>
              <p class="module-sub">RL 训练 + 回放</p>
              <p class="module-desc">
                与后端 apps/rl (PyTorch + Gymnasium) 联动：多智能体策略训练、回放 buffer 可视化、学到策略的影子车在 SceneLab 里 replay。
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
                所有模块的统一 API 入口。当前已暴露 <code>GET /health</code> 与 <code>GET /api/v1/ping</code> 两个 smoke 端点；scene sync、tick stream、RL control 等接口在 M2–M4 落地。
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

<script setup>
import EnhancedWebGLBackground from '@interfaces/components/showcase/EnhancedWebGLBackground.vue'
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

/* === Content === */
.content-wrap {
  padding: 96px 24px 64px;
  max-width: 1200px;
  margin: 0 auto;
}

/* === Hero === */
.hero {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0 56px;
}
.hero-card {
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(12px);
  border-radius: 16px;
  padding: 36px 40px;
  box-shadow: 0 10px 32px rgba(2, 6, 23, 0.08);
  max-width: 880px;
}
.hero-card h1 {
  margin: 0 0 12px;
  font-size: 36px;
  letter-spacing: -0.02em;
}
.hero-tagline {
  margin: 0 0 12px;
  font-size: 15px;
  line-height: 1.7;
  color: rgba(15, 23, 42, 0.78);
}
.hero-sub {
  margin: 0 0 22px;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(15, 23, 42, 0.55);
}
.hero-ctas { display: flex; gap: 12px; flex-wrap: wrap; }
.btn {
  display: inline-block;
  padding: 10px 18px;
  border-radius: 8px;
  background: #2563eb;
  color: white;
  text-decoration: none;
  font-size: 14px;
  transition: background 0.18s;
}
.btn:hover { background: #1d4ed8; }
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(15, 23, 42, 0.12);
  color: inherit;
}
.btn.ghost:hover { background: rgba(15, 23, 42, 0.04); }

/* === Module grid === */
.modules-header {
  margin: 0 0 20px;
}
.modules-header h2 {
  font-size: 22px;
  margin: 0 0 6px;
  letter-spacing: -0.01em;
}
.modules-header p {
  margin: 0;
  color: rgba(15, 23, 42, 0.6);
  font-size: 14px;
}
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.module-card {
  display: flex;
  gap: 14px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(8px);
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: 0 4px 16px rgba(2, 6, 23, 0.05);
  text-decoration: none;
  color: inherit;
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.module-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgba(2, 6, 23, 0.12);
  border-color: rgba(59, 130, 246, 0.4);
}
.module-icon {
  font-size: 32px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 10px;
  flex-shrink: 0;
}
.module-body { flex: 1; }
.module-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.module-title-row h3 {
  margin: 0;
  font-size: 16px;
}
.module-sub {
  margin: 0 0 8px;
  font-size: 12px;
  color: rgba(15, 23, 42, 0.55);
}
.module-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(15, 23, 42, 0.72);
}
.module-desc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}

.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.badge-active { background: rgba(34, 197, 94, 0.15); color: #15803d; }
.badge-planned { background: rgba(148, 163, 184, 0.2); color: #475569; }

/* === Footer === */
.site-footer {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: rgba(15, 23, 42, 0.45);
}

/* === Mobile === */
@media (max-width: 720px) {
  .nav-links { gap: 2px; }
  .nav-link { padding: 6px 10px; font-size: 12px; }
  .title .subtitle { display: none; }
  .hero-card { padding: 24px; }
  .hero-card h1 { font-size: 28px; }
}
</style>

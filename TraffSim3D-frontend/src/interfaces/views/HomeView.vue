<template>
  <div class="main-container">
    <EnhancedWebGLBackground />

    <header class="top-nav" role="navigation" aria-label="主导航">
      <div class="nav-inner">
        <div class="brand" @click="scrollToTop">
          <div class="logo" aria-hidden>🛰️</div>
          <div class="title">
            <span class="project-name">3D 仿真系统</span>
            <small class="subtitle">智慧城市 · 可视化</small>
          </div>
        </div>

        <nav class="nav-links" :class="{ open: mobileOpen }" aria-label="主要链接">
          <a href="#home" @click="closeMenu">首页</a>
          <a href="#simulation" @click="closeMenu">仿真</a>
          <a href="#data" @click="closeMenu">数据</a>
          <a href="#dashboard" @click="closeMenu">仪表盘</a>
          <a href="#about" @click="closeMenu">关于</a>
        </nav>

        <button
          class="mobile-toggle"
          @click="toggleMenu"
          aria-expanded="false"
          aria-label="切换菜单"
        >
          <span v-if="!mobileOpen">☰</span>
          <span v-else>✕</span>
        </button>
      </div>
    </header>

    <main class="content-wrap" id="home">
      <section class="hero">
        <div class="hero-card">
          <h1>3D 仿真系统</h1>
          <p>基于 WebGL 的实时三维粒子与后处理效果，面向城市级仿真与数据可视化。</p>
          <div class="hero-ctas">
            <a href="#simulation" class="btn" @click="closeMenu">开始仿真</a>
            <a href="#dashboard" class="btn ghost" @click="closeMenu">查看仪表盘</a>
          </div>
        </div>
      </section>

      <section id="simulation" class="section">
        <h2>仿真</h2>
        <p>实时场景、粒子层次与光照交互示例 — 可在本系统中扩展为车辆、行人与环境模拟。</p>
      </section>

      <section id="data" class="section">
        <h2>数据</h2>
        <p>接入实时数据流或 CSV，驱动可视化与告警。</p>
      </section>

      <section id="dashboard" class="section">
        <h2>仪表盘</h2>
        <p>展示关键指标、时间序列与统计面板（占位）。</p>
      </section>

      <section id="about" class="section">
        <h2>关于</h2>
        <p>项目：3D 仿真系统 — 数据可视化与城市级仿真前端展示。</p>
      </section>
    </main>

    <footer class="site-footer">
      <span>© {{ new Date().getFullYear() }} 3D 仿真系统</span>
    </footer>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import EnhancedWebGLBackground from '@interfaces/components/showcase/EnhancedWebGLBackground.vue'

const mobileOpen = ref(false)

function toggleMenu() {
  mobileOpen.value = !mobileOpen.value
}

function closeMenu() {
  mobileOpen.value = false
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
</script>

<style>
/* 基础布局 */
.main-container {
  position: relative;
  width: 100vw;
  min-height: 100vh;
  overflow-x: hidden;
  color: rgba(20, 14, 14, 0.9);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}

/* 顶部导航 */
.top-nav {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 2;
  backdrop-filter: blur(8px);
  background: linear-gradient(to right, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.nav-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.logo {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.title .project-name {
  font-weight: 700;
  display: block;
}
.title .subtitle {
  display: block;
  font-size: 12px;
  color: rgba(20, 14, 14, 0.6);
}

/* 链接 */
.nav-links {
  display: flex;
  gap: 18px;
  align-items: center;
}
.nav-links a {
  color: inherit;
  text-decoration: none;
  padding: 6px 8px;
  border-radius: 6px;
  transition: background 0.18s;
}
.nav-links a:hover {
  background: rgba(255, 255, 255, 0.04);
}

/* 移动 */
.mobile-toggle {
  display: none;
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: inherit;
}

/* 主要内容区，给背景留出空间 */
.content-wrap {
  padding-top: 100px; /* 顶部导航高度 + 余白 */
  max-width: 1200px;
  margin: 0 auto;
}

/* 英雄区 */
.hero {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 140px);
  padding: 40px 20px;
}
.hero-card {
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  padding: 32px;
  text-align: center;
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(2, 6, 23, 0.4);
  max-width: 820px;
}
.hero-card h1 {
  margin: 0 0 8px;
  font-size: 36px;
}
.hero-card p {
  margin: 0 0 18px;
  color: rgba(20, 14, 14, 0.7);
}
.btn {
  display: inline-block;
  padding: 10px 18px;
  margin-right: 10px;
  border-radius: 8px;
  background: rgba(0, 150, 255, 0.9);
  color: white;
  text-decoration: none;
}
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: inherit;
}

/* 普通章节样式 */
.section {
  padding: 40px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.02);
  color: rgba(20, 14, 14, 0.85);
}

/* 页脚 */
.site-footer {
  padding: 18px 20px;
  text-align: center;
  color: rgba(20, 14, 14, 0.6);
}

/* 响应式：移动设备将导航改为弹出 */
@media (max-width: 900px) {
  .nav-links {
    position: fixed;
    top: 64px;
    right: 12px;
    width: calc(100% - 32px);
    max-width: 320px;
    flex-direction: column;
    background: rgba(0, 0, 0, 0.45);
    padding: 12px;
    border-radius: 10px;
    transform: translateY(-12px) scaleY(0.98);
    opacity: 0;
    pointer-events: none;
    transition: all 0.18s ease;
  }
  .nav-links.open {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scaleY(1);
  }
  .mobile-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}
</style>

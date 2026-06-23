<template>
  <main class="placeholder-view">
    <router-link to="/" class="back-link">← 返回首页</router-link>
    <header class="placeholder-header">
      <span class="badge badge-planned">M2 · Planned</span>
      <h1>SimulationLab</h1>
      <p class="placeholder-sub">物理 + 传感器仿真</p>
    </header>

    <section class="placeholder-card">
      <h2>本模块做什么</h2>
      <p>
        SimulationLab 负责把 SceneLab 里编辑的场景从"几何 + 域对象"升级到"物理 + 传感器"。
        计划接入 <strong>Rapier (WASM)</strong> 做刚体物理，再叠加 lidar / camera / IMU 传感器的合成观测，
        为 AI Proving Ground 提供可微的 observation space。
      </p>

      <h2>M2 计划范围 (摘自执行方案)</h2>
      <ul>
        <li>车辆动力学：质量 / 摩擦 / 转向限幅；与现有 <code>tick()</code> 衔接而非替换。</li>
        <li>碰撞检测：基于 Rapier 的 contact graph 触发 <code>DomainEvent.collision-detected</code>。</li>
        <li>传感器仿真：俯视 RGB、2D 激光雷达、车辆自身 IMU（yaw rate + 速度）。</li>
        <li>观测空间 schema：作为 Pydantic model 暴露在后端 <code>apps/simulation</code>。</li>
      </ul>

      <h2>当前状态</h2>
      <p class="muted">
        仍在骨架阶段。当前 SceneEditor 用的是简化的几何移动 ( <code>tick()</code> )，
        未接入物理引擎。等到 M2 启动时，本视图会变成传感器面板 + 物理回放控制。
      </p>

      <div class="placeholder-actions">
        <router-link to="/scene-editor" class="btn">先去 SceneLab 编辑场景</router-link>
        <router-link to="/backend" class="btn ghost">检查后端状态</router-link>
      </div>
    </section>
  </main>
</template>

<script setup>
// Placeholder. Real implementation in M2.
</script>

<style scoped>
.placeholder-view {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
  padding: 80px 24px 48px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}
.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #93c5fd;
  text-decoration: none;
}
.back-link:hover { text-decoration: underline; }
.placeholder-header { max-width: 880px; margin: 0 auto 20px; }
.placeholder-header h1 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.placeholder-sub { margin: 0; color: #94a3b8; font-size: 14px; }

.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 600;
}
.badge-planned { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }

.placeholder-card {
  max-width: 880px;
  margin: 0 auto;
  padding: 28px 32px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
  line-height: 1.7;
}
.placeholder-card h2 {
  margin: 22px 0 8px;
  font-size: 15px;
  color: #cbd5e1;
  letter-spacing: 0.01em;
}
.placeholder-card h2:first-child { margin-top: 0; }
.placeholder-card p { margin: 0 0 12px; color: #cbd5e1; font-size: 14px; }
.placeholder-card ul {
  margin: 0 0 12px;
  padding-left: 22px;
  color: #cbd5e1;
  font-size: 14px;
}
.placeholder-card li { margin-bottom: 4px; }
.placeholder-card code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(2, 6, 23, 0.7);
  padding: 1px 6px;
  border-radius: 4px;
  color: #93c5fd;
}
.muted { color: #94a3b8 !important; font-size: 13px; }
.placeholder-actions {
  margin-top: 24px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.btn {
  display: inline-block;
  padding: 8px 16px;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  text-decoration: none;
  font-size: 13px;
}
.btn:hover { background: #1d4ed8; }
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
}
.btn.ghost:hover { background: rgba(148, 163, 184, 0.08); }

@media (max-width: 720px) {
  .placeholder-view { padding: 72px 16px 32px; }
  .placeholder-card { padding: 20px; }
  .placeholder-header h1 { font-size: 22px; }
}
</style>

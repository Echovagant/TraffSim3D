<template>
  <main class="placeholder-view">
    <router-link to="/" class="back-link">← 返回首页</router-link>
    <header class="placeholder-header">
      <span class="badge badge-planned">M4 · Planned</span>
      <h1>AI Proving Ground</h1>
      <p class="placeholder-sub">多智能体强化学习训练 + 回放</p>
    </header>

    <section class="placeholder-card">
      <h2>本模块做什么</h2>
      <p>
        与后端 <code>apps/rl</code>（PyTorch + Gymnasium）联动：把 SceneLab 编辑好的场景序列化到后端，
        在云端训练多智能体策略（路口信号配时 / 个体车辆驾驶），再把训练好的策略作为"影子车"
        放回 SceneLab 中 replay，可视化对比 baseline。
      </p>

      <h2>M4 计划范围 (摘自执行方案)</h2>
      <ul>
        <li>Gymnasium 环境：observation = SceneLab 序列化状态；action = 离散 / 连续动作空间。</li>
        <li>训练循环：PPO / SAC； checkpoint 写到 <code>apps/storage</code>。</li>
        <li>回放 buffer：场景轨迹可下载、在 SceneLab 中 shadow-vehicle 形式回放。</li>
        <li>评估指标：吞吐、碰撞率、平均等待时间 — 与 M1 的 perf gate 联动。</li>
      </ul>

      <h2>前置依赖</h2>
      <p class="muted">
        在 M2 (SimulationLab) 和 M3 (OSM 地图接入) 落地之前，本模块没有可训练的真实环境。
        当前为占位页 — 真正的 RL 训练面板、checkpoint 上传、replay 对比都在 M4 启动后再做。
      </p>

      <div class="placeholder-actions">
        <router-link to="/scene-editor" class="btn">先去 SceneLab 编辑场景</router-link>
        <router-link to="/backend" class="btn ghost">检查后端状态</router-link>
      </div>
    </section>
  </main>
</template>

<script setup>
// Placeholder. Real implementation in M4.
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

<template>
  <main class="placeholder-view">
    <router-link to="/" class="back-link">← 返回首页</router-link>
    <header class="placeholder-header">
      <span class="badge badge-planned">M5 · Planned</span>
      <h1>DeliveryLab</h1>
      <p class="placeholder-sub">部署与交付物</p>
    </header>

    <section class="placeholder-card">
      <h2>本模块做什么</h2>
      <p>
        DeliveryLab 是 M5 阶段的交付物总览页 — 本地部署清单、ADR 归档、API 文档、测试覆盖率报告。
        这一页不引入新功能, 只把 <strong>前 4 个里程碑的可交付物</strong> 集中展示给项目接手人。
      </p>

      <h2>M5 计划范围 (摘自执行方案)</h2>
      <ul>
        <li>
          本地进程部署: frontend (Vite) + backend (uvicorn)。<strong>不使用容器</strong> — ADR-007
          已于 2026-10-17 裁定为 Rejected。
        </li>
        <li>
          ADR 归档: 7 份 ADR 的 <code>Status</code> 已全部裁定 (001–006 Accepted, 007 Rejected)。
        </li>
        <li>
          API 文档: FastAPI 自动生成的 OpenAPI schema (<code>docs/openapi.json</code>) +
          部署与用户指南。
        </li>
        <li>测试覆盖率 ≥ 70% — 已达成: 前端 77.61% / 后端 87%。</li>
      </ul>

      <h2>当前状态</h2>
      <p class="muted">
        仍在占位阶段。M5 是项目收官, 计划 2-3 周; 触发条件是 M4 (RL 训练) 通过验收。
        当前所有交付物散落在 <code>docs/</code>, 本视图是它们的目录页。
      </p>

      <div class="placeholder-actions">
        <router-link to="/scene-editor" class="btn">看 SceneLab demo</router-link>
        <router-link to="/backend" class="btn ghost">检查后端状态</router-link>
      </div>
    </section>
  </main>
</template>

<script setup>
// Placeholder. Real implementation in M5.
</script>

<style scoped>
/* IDENTICAL to MapImporterView. To keep DRY in a future refactor, extract
 * to `<PlaceholderView>` in components/. Out of scope for this plan — keep
 * 2 copies, the duplication is intentional and small. */
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
.back-link:hover {
  text-decoration: underline;
}
.placeholder-header {
  max-width: 880px;
  margin: 0 auto 20px;
}
.placeholder-header h1 {
  margin: 8px 0 4px;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.placeholder-sub {
  margin: 0;
  color: #94a3b8;
  font-size: 14px;
}

.badge {
  display: inline-block;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 600;
}
.badge-planned {
  background: rgba(148, 163, 184, 0.2);
  color: #cbd5e1;
}

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
.placeholder-card h2:first-child {
  margin-top: 0;
}
.placeholder-card p {
  margin: 0 0 12px;
  color: #cbd5e1;
  font-size: 14px;
}
.placeholder-card ul {
  margin: 0 0 12px;
  padding-left: 22px;
  color: #cbd5e1;
  font-size: 14px;
}
.placeholder-card li {
  margin-bottom: 4px;
}
.placeholder-card code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(2, 6, 23, 0.7);
  padding: 1px 6px;
  border-radius: 4px;
  color: #93c5fd;
}
.muted {
  color: #94a3b8 !important;
  font-size: 13px;
}
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
.btn:hover {
  background: #1d4ed8;
}
.btn.ghost {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: inherit;
}
.btn.ghost:hover {
  background: rgba(148, 163, 184, 0.08);
}

@media (max-width: 720px) {
  .placeholder-view {
    padding: 72px 16px 32px;
  }
  .placeholder-card {
    padding: 20px;
  }
  .placeholder-header h1 {
    font-size: 22px;
  }
}
</style>

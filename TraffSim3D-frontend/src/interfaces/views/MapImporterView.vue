<template>
  <main class="placeholder-view">
    <router-link to="/" class="back-link">← 返回首页</router-link>
    <header class="placeholder-header">
      <span class="badge badge-planned">M3 · Planned</span>
      <h1>MapLab</h1>
      <p class="placeholder-sub">OSM 地图导入与路网生成</p>
    </header>

    <section class="placeholder-card">
      <h2>本模块做什么</h2>
      <p>
        MapLab 把 OpenStreetMap 的 <code>.osm</code> / <code>.pbf</code> 文件解析成 SceneLab 可加载的路网图。
        流程: <strong>OSM 解析 → 路网 graph → SceneLab 加载</strong>。
        解析出的 node / way / relation 三元组存到后端 <code>apps/maps</code> 的 PostGIS,
        SceneLab 通过 <code>GET /api/v1/maps/:id</code> 拉取并渲染。
      </p>

      <h2>M3 计划范围 (摘自执行方案)</h2>
      <ul>
        <li>OSM XML / PBF 解析: 提取 highways + buildings + POI。</li>
        <li>路网 graph 构建: intersection 检测, lane segment 切分, 单向/双向标注。</li>
        <li>地图坐标系 → 世界坐标: WGS84 经纬度 → Web Mercator → SceneLab 单位 (米)。</li>
        <li>SceneLab 集成: <code>MapImporter</code> 工具栏按钮 + 后端 pull 接口。</li>
      </ul>

      <h2>当前状态</h2>
      <p class="muted">
        仍在占位阶段。SceneLab 当前的 defaultScene 是手写的 4-way intersection + 2 条 60u 直路,
        解析 OSM 的代码还没启动。M3 启动时本视图会变成 OSM 文件上传 + 路网预览 + SceneLab 跳转按钮。
      </p>

      <div class="placeholder-actions">
        <router-link to="/scene-editor" class="btn">先去 SceneLab 看现有 demo</router-link>
        <router-link to="/backend" class="btn ghost">检查后端状态</router-link>
      </div>
    </section>
  </main>
</template>

<script setup>
// Placeholder. Real implementation in M3.
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

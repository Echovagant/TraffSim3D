<template>
  <main class="view view--placeholder">
    <h1>404</h1>
    <p>未找到该页面。</p>
    <router-link to="/" class="back-link">返回首页</router-link>
  </main>
</template>

<script setup>
// Placeholder. Real implementation in M2.
</script>

<style scoped>
.view--placeholder {
  min-height: 100vh;
  background: #0b1220;
  color: #e2e8f0;
  padding: 96px 24px;
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}
.view--placeholder h1 {
  font-size: 64px;
  margin: 0 0 12px;
}
.view--placeholder p {
  color: #94a3b8;
  margin: 0 0 24px;
}
.back-link {
  display: inline-block;
  padding: 8px 16px;
  border-radius: 6px;
  background: #1e293b;
  color: #f1f5f9;
  text-decoration: none;
}
.back-link:hover {
  background: #334155;
}
</style>

<template>
  <main class="view view--placeholder">
    <ShowcaseNav />
    <h1>404</h1>
    <p>未找到该页面。</p>
    <router-link to="/" class="back-link">返回首页</router-link>
  </main>
</template>

<script setup>
// Placeholder. Real implementation to follow.
</script>

<style scoped>
.view--placeholder {
  min-height: 100vh;
  background: var(--dc-screen);
  color: var(--dc-text);
  padding: 96px 24px;
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}
.view--placeholder h1 {
  font-size: 64px;
  margin: 0 0 12px;
}
.view--placeholder p {
  color: var(--dc-text-dim);
  margin: 0 0 24px;
}
.back-link {
  display: inline-block;
  padding: 8px 16px;
  border-radius: 6px;
  background: var(--dc-panel-2);
  color: var(--dc-text);
  text-decoration: none;
}
.back-link:hover {
  background: var(--dc-secondary);
}
</style>

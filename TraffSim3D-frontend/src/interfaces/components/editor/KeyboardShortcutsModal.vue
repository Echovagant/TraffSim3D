<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
      @click.self="$emit('update:open', false)"
    >
      <div class="modal-card">
        <header class="modal-header">
          <h2>键盘快捷键</h2>
          <button
            class="close-btn"
            aria-label="关闭"
            @click="$emit('update:open', false)"
          >✕</button>
        </header>

        <table class="shortcuts">
          <thead>
            <tr>
              <th>键</th>
              <th>动作</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><kbd>Space</kbd></td>
              <td>播放 / 暂停仿真</td>
            </tr>
            <tr>
              <td><kbd>Delete</kbd> / <kbd>Backspace</kbd></td>
              <td>删除当前选中的车辆或信号灯</td>
            </tr>
            <tr>
              <td><kbd>R</kbd></td>
              <td>重置场景为默认</td>
            </tr>
            <tr>
              <td><kbd>+</kbd> / <kbd>=</kbd></td>
              <td>提升仿真速率</td>
            </tr>
            <tr>
              <td><kbd>-</kbd> / <kbd>_</kbd></td>
              <td>降低仿真速率</td>
            </tr>
            <tr>
              <td><kbd>Esc</kbd></td>
              <td>取消选择 / 关闭弹窗</td>
            </tr>
            <tr>
              <td><kbd>F</kbd></td>
              <td>聚焦到当前选中的实体</td>
            </tr>
            <tr>
              <td><kbd>?</kbd></td>
              <td>显示本快捷键面板</td>
            </tr>
          </tbody>
        </table>

        <p class="hint">输入框 / 下拉框中的按键不会触发快捷键。</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{ open: boolean }>();
defineEmits<{ (e: 'update:open', value: boolean): void }>();
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-card {
  background: rgba(15, 23, 42, 0.95);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
  padding: 24px 28px;
  min-width: 360px;
  max-width: 480px;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.modal-header h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.01em;
}
.close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.close-btn:hover { background: rgba(148, 163, 184, 0.15); color: #e2e8f0; }

.shortcuts {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.shortcuts th {
  text-align: left;
  padding: 6px 12px 6px 0;
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}
.shortcuts td {
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.08);
  color: #cbd5e1;
}
.shortcuts tr:last-child td { border-bottom: none; }
kbd {
  display: inline-block;
  padding: 2px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(2, 6, 23, 0.7);
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-bottom-width: 2px;
  border-radius: 4px;
  color: #93c5fd;
  min-width: 24px;
  text-align: center;
}
.hint {
  margin: 16px 0 0;
  font-size: 12px;
  color: #94a3b8;
}
</style>

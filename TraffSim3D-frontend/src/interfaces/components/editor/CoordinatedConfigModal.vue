<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <div class="modal">
      <header>
        <h2>协调偏移 (绿波带)</h2>
        <button class="ghost" title="关闭" @click="close">✕</button>
      </header>
      <p class="hint">
        每个路口设一个时间偏移 (相对全局基准). 正值 = 该路口的绿灯比基准晚这个秒数开始.
        一条走廊上的各个路口配上递延的偏移, 就是绿波带. 实际生效需要控制器切到 "协调".
      </p>
      <table>
        <thead>
          <tr>
            <th>路口</th>
            <th>偏移 (s)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td>
              <code>{{ row.label }}</code>
            </td>
            <td>
              <input
                type="number"
                step="0.5"
                min="-30"
                max="30"
                :value="row.value"
                @change="onChange(row.key, Number(($event.target as HTMLInputElement).value))"
              />
            </td>
            <td>
              <button class="ghost" title="重置为 0" @click="onReset(row.key)">↺</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="3" class="empty">场景里没有路口.</td>
          </tr>
        </tbody>
      </table>
      <footer>
        <label class="enable-toggle">
          <input type="checkbox" :checked="enabled" @change="onToggle($event)" />
          <span>启用 (需切到协调控制器才生效)</span>
        </label>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import { COORDINATED_DEFAULT_OFFSET_KEY } from '@application/services/controllers'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const store = useWorldStore()

/**
 * The rows: the corridor-wide default first, then one row per junction
 * of the current scene.
 *
 * The offset is **per junction** — a green wave is a relation between
 * junctions, so the shift of one junction's whole plan against the
 * common reference is what the wave is. The default row is the offset a
 * junction inherits when it has none of its own.
 */
const rows = computed(() => {
  const ids = Object.keys(store.network.intersections).sort()
  return [COORDINATED_DEFAULT_OFFSET_KEY, ...ids].map((key) => ({
    key,
    label: key === COORDINATED_DEFAULT_OFFSET_KEY ? '默认 (全部路口)' : key,
    value: store.coordinatedOffsets.get(key) ?? 0,
  }))
})
const enabled = computed(() => store.coordinatedOffsetsEnabled)

const close = (): void => emit('update:open', false)

const onChange = (key: string, v: number): void => {
  if (Number.isFinite(v)) store.setCoordinatedOffset(key, v)
}
const onReset = (key: string): void => store.setCoordinatedOffset(key, 0)
const onToggle = (e: Event): void => {
  store.toggleCoordinatedOffsets((e.target as HTMLInputElement).checked)
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #0f172a;
  color: #f1f5f9;
  border-radius: 8px;
  padding: 18px 22px;
  min-width: 420px;
  max-width: 560px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.modal header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.modal h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.modal .ghost {
  background: transparent;
  color: #cbd5e1;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}
.modal .ghost:hover {
  color: #f1f5f9;
}
.modal .hint {
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.5;
  margin: 0 0 12px;
}
.modal table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}
.modal th,
.modal td {
  padding: 6px 8px;
  text-align: left;
  font-size: 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
}
.modal th {
  color: #94a3b8;
  font-weight: 500;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.modal input[type='number'] {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 12px;
  width: 70px;
}
.modal .empty {
  color: #94a3b8;
  text-align: center;
  padding: 12px 8px;
  font-size: 11px;
}
.modal code {
  background: rgba(148, 163, 184, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.modal footer {
  margin-top: 8px;
  font-size: 11px;
  color: #cbd5e1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
}
.modal .enable-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
</style>

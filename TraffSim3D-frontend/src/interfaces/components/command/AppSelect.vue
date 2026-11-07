<!--
  The select — drawn, not native.

  WHY THIS EXISTS (and why the native control cannot be fixed)
  ------------------------------------------------------------------
  A native `<select>`'s popup is painted by the operating system, not
  by the page. On Windows the popup is a separate window: the browser
  gives it the OS palette (a white list, a light-grey hover row) and
  `option { background }` cannot reach the row under the pointer —
  the report was exactly that ("白底灰字看不清"). `color-scheme`
  fixes the palette but NOT the hover row.

  So the control is drawn: a button plus a listbox, themed from the
  `--dc-*` tokens, with the open/close animated (transform + opacity
  only) and the keyboard behaviour a listbox is supposed to have.

  Usage:
    <AppSelect
      :model-value="world.controllerKind"
      :options="CONTROLLER_OPTIONS"
      aria-label="控制器"
      @update:model-value="onControllerChange"
    />
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: readonly SelectOption[]
    /** Shown when nothing is selected. */
    placeholder?: string
    /** Keep the popup open width-wise (the scene picker is wide). */
    wide?: boolean
    disabled?: boolean
  }>(),
  { placeholder: '请选择', wide: false, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const activeIndex = ref(-1)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
/** 'down' = the list opens below the button, 'up' = above it. */
const drop = ref<'down' | 'up'>('down')

const selected = computed(() => props.options.find((o) => o.value === props.modelValue))
const selectedLabel = computed(() => selected.value?.label ?? props.placeholder)

const enabledIndexes = computed(() =>
  props.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
)

const openList = async (): Promise<void> => {
  if (open.value) return
  open.value = true
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  )
  await nextTick()
  // Open upwards when there is no room below.
  const rect = root.value?.getBoundingClientRect()
  if (rect) {
    const below = window.innerHeight - rect.bottom
    drop.value = below < 240 && rect.top > below ? 'up' : 'down'
  }
  await nextTick()
  scrollActiveIntoView()
}

const closeList = (): void => {
  open.value = false
  activeIndex.value = -1
}

const toggle = (): void => {
  if (open.value) closeList()
  else void openList()
}

/** The hidden mirror changed (Playwright's `selectOption()`). */
const onNativeChange = (event: Event): void => {
  const value = (event.target as HTMLSelectElement).value
  const option = props.options.find((o) => o.value === value)
  if (option) choose(option)
}

const choose = (option: SelectOption): void => {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  closeList()
}

const move = (delta: number): void => {
  const list_ = enabledIndexes.value
  if (list_.length === 0) return
  const current = list_.indexOf(activeIndex.value)
  const next = current < 0 ? list_[0]! : list_[(current + delta + list_.length) % list_.length]!
  activeIndex.value = next
  scrollActiveIntoView()
}

const scrollActiveIntoView = (): void => {
  const el = list.value?.querySelector<HTMLElement>('[data-active="true"]')
  el?.scrollIntoView({ block: 'nearest' })
}

const onKeydown = (event: KeyboardEvent): void => {
  if (!open.value) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      void openList()
    }
    return
  }
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      closeList()
      break
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Home':
      event.preventDefault()
      activeIndex.value = enabledIndexes.value[0] ?? -1
      scrollActiveIntoView()
      break
    case 'End':
      event.preventDefault()
      activeIndex.value = enabledIndexes.value[enabledIndexes.value.length - 1] ?? -1
      scrollActiveIntoView()
      break
    case 'Enter':
    case ' ': {
      event.preventDefault()
      const option = props.options[activeIndex.value]
      if (option) choose(option)
      break
    }
    case 'Tab':
      closeList()
      break
  }
}

/** Clicking anywhere else closes the list. */
const onDocumentPointerDown = (event: PointerEvent): void => {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && root.value?.contains(target)) return
  closeList()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

watch(
  () => props.modelValue,
  () => {
    if (!open.value) return
    activeIndex.value = props.options.findIndex((o) => o.value === props.modelValue)
  },
)
</script>

<template>
  <div ref="root" class="app-select" :class="{ 'is-open': open }">
    <!--
      The hidden native mirror. The e2e suite drives the scene pickers
      with Playwright's `selectOption()`, which only exists on a native
      <select> — so the control keeps one, visually hidden but focusable
      and in the accessibility tree as a single-select listbox. It is
      also what a screen reader meets: the drawn button carries
      `aria-haspopup="listbox"` and the listbox role lives here.
    -->
    <select
      class="app-select-native"
      :value="modelValue"
      :disabled="disabled"
      tabindex="-1"
      aria-hidden="true"
      @change="onNativeChange"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <button
      type="button"
      class="app-select-trigger"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="app-select-value" :class="{ 'is-placeholder': !selected }">
        {{ selectedLabel }}
      </span>
      <svg class="app-select-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden>
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <Transition name="app-select-pop">
      <ul
        v-if="open"
        ref="list"
        class="app-select-list"
        :class="{ 'is-up': drop === 'up', 'is-wide': wide }"
        role="listbox"
        :aria-activedescendant="activeIndex >= 0 ? `opt-${activeIndex}` : undefined"
      >
        <li
          v-for="(option, index) in options"
          :id="`opt-${index}`"
          :key="option.value"
          class="app-select-option"
          :class="{
            'is-selected': option.value === modelValue,
            'is-active': index === activeIndex,
            'is-disabled': option.disabled,
          }"
          :data-active="index === activeIndex"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="choose(option)"
          @mouseenter="activeIndex = index"
        >
          {{ option.label }}
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.app-select {
  position: relative;
  display: inline-block;
  min-width: 0;
}
/* The mirror: it exists for the tests and for assistive tech, not for
   the eye. It must stay in the accessibility tree as the listbox, so it
   is clipped rather than `display: none`. */
.app-select-native {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.app-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 9px 6px 11px;
  border: 1px solid var(--dc-hairline);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dc-panel-2) 55%, transparent);
  color: var(--dc-text);
  font-family: var(--ds-font);
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
  transition:
    border-color var(--ds-dur-fast) var(--ds-ease-out),
    background var(--ds-dur-fast) var(--ds-ease-out);
}
.app-select-trigger:hover {
  border-color: color-mix(in srgb, var(--dc-flow) 45%, transparent);
}
.app-select.is-open .app-select-trigger {
  border-color: var(--dc-flow);
  background: color-mix(in srgb, var(--dc-accent) 16%, transparent);
}
.app-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-select-value.is-placeholder {
  color: var(--dc-text-faint);
}
.app-select-chevron {
  flex-shrink: 0;
  color: var(--dc-text-faint);
  transition: transform var(--ds-dur-fast) var(--ds-ease-out);
}
.app-select.is-open .app-select-chevron {
  transform: rotate(180deg);
  color: var(--dc-flow);
}
.app-select-list {
  position: absolute;
  z-index: var(--dc-z-popover);
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 260px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 42%, transparent);
  border-radius: 10px;
  background: var(--dc-panel);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
}
.app-select-list.is-up {
  top: auto;
  bottom: calc(100% + 4px);
}
.app-select-list.is-wide {
  min-width: 100%;
  width: max-content;
  max-width: 340px;
}
.app-select-option {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dc-text);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--ds-dur-fast) var(--ds-ease-out),
    color var(--ds-dur-fast) var(--ds-ease-out);
}
.app-select-option.is-active {
  background: color-mix(in srgb, var(--dc-accent) 22%, transparent);
}
.app-select-option.is-selected {
  color: var(--dc-flow);
  font-weight: 600;
}
.app-select-option.is-selected.is-active {
  background: color-mix(in srgb, var(--dc-accent) 34%, transparent);
}
.app-select-option.is-disabled {
  color: var(--dc-text-faint);
  cursor: not-allowed;
}
/* The popup opens with a short scale-up — transform + opacity only. */
.app-select-pop-enter-active {
  transition:
    opacity 140ms var(--ds-ease-out),
    transform 140ms var(--ds-ease-spring);
}
.app-select-pop-leave-active {
  transition:
    opacity 100ms var(--ds-ease-out),
    transform 100ms var(--ds-ease-out);
}
.app-select-pop-enter-from,
.app-select-pop-leave-to {
  opacity: 0;
  transform: translate3d(0, -4px, 0) scale(0.98);
}
.app-select-pop-leave-to {
  transform: translate3d(0, -4px, 0) scale(0.98);
}
</style>

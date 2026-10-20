import { defineStore } from 'pinia'
import { ref } from 'vue'

export type SelectionKind = 'vehicle' | 'light'

export const useSelectionStore = defineStore('selection', () => {
  const id = ref<string | null>(null)
  const kind = ref<SelectionKind | null>(null)

  const select = (newKind: SelectionKind, newId: string) => {
    kind.value = newKind
    id.value = newId
  }
  const clear = () => {
    kind.value = null
    id.value = null
  }
  const isSelected = (checkKind: SelectionKind, checkId: string): boolean =>
    kind.value === checkKind && id.value === checkId

  return { id, kind, select, clear, isSelected }
})

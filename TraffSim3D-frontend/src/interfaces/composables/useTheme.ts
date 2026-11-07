// The theme singleton.
//
// The palette lives in `interfaces/theme/tokens.css`; this module only
// decides WHICH theme is active and mirrors it onto the document root
// (`data-theme`), so every component picks the change up through the
// CSS variables without re-rendering.
//
// Module-level state on purpose: the 3D scene, the dashboard and the
// theme picker must always agree on one theme — a per-component copy
// would let them drift (the reference project's rule: "大屏与 3D 场景
// 看到的一定是同一份").

import { readonly, ref } from 'vue'

export interface ThemeDefinition {
  id: string
  label: string
  description: string
  /** The swatches shown in the picker: base, panel, accent, flow, road. */
  swatches: readonly string[]
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'deep-space',
    label: '深空蓝',
    description: '默认。收敛的蓝青夜幕，长时间值守最省眼。',
    swatches: ['#04070f', '#0b1526', '#1e40af', '#0e7490', '#2b5fa8'],
  },
  {
    id: 'graphite',
    label: '石墨灰',
    description: '中性低饱和。亮环境 / 白墙投影时用。',
    swatches: ['#0a0b0d', '#16181c', '#3f4756', '#4b7f8f', '#47525f'],
  },
  {
    id: 'cyan',
    label: '城市青',
    description: '更冷的青夜。控制室与大屏。',
    swatches: ['#03090b', '#07202a', '#0e5f73', '#12a0b8', '#16788c'],
  },
]

const STORAGE_KEY = 'traffsim3d.theme'

const themeId = ref<string>(THEMES[0]!.id)

/** Mirror the theme onto the document root. */
const apply = (id: string): void => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = id
}

const setTheme = (id: string): void => {
  if (!THEMES.some((t) => t.id === id)) return
  themeId.value = id
  apply(id)
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // A private-mode browser without storage: the theme still applies
    // for this session, it just does not survive a reload.
  }
}

/** Restore the stored theme (or the default) — call once at boot. */
const initTheme = (): void => {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    stored = null
  }
  const id = stored && THEMES.some((t) => t.id === stored) ? stored : THEMES[0]!.id
  themeId.value = id
  apply(id)
}

export const useTheme = () => ({
  themeId: readonly(themeId),
  themes: THEMES,
  setTheme,
  initTheme,
})

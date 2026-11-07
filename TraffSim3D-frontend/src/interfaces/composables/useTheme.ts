// The theme controller.
//
// Three things live here:
//
//   1. WHICH theme — a module singleton, because the 3D scene and the
//      dashboard must never disagree (the reference project's rule:
//      "大屏与 3D 场景看到的一定是同一份").
//   2. HOW it changes — through the View Transition API when the
//      browser has it (Chrome/Edge: the new theme is revealed with a
//      circular wipe FROM the toggle button, which is the interaction
//      that makes a theme switch feel like a physical action rather
//      than a repaint). Elsewhere the change is applied with a short
//      cross-fade.
//   3. WHAT ELSE THE SWITCH BUYS — the heavy routes are WARMED while
//      the transition runs: SmartCity pulls a 5.3 MB Cesium runtime and
//      the AI playground a chart stack, and the first visit to either
//      pays for it. Pre-loading them during the ~400 ms wipe means the
//      user who switches the theme and then clicks through finds the
//      screen already warm.

import { readonly, ref } from 'vue'

export interface ThemeDefinition {
  id: string
  label: string
  description: string
  /** The swatches shown in the picker: base, panel, accent, flow, road. */
  swatches: readonly string[]
  /** The theme's display face: the dark theme is the grotesque, the
   *  light theme the serif (a document reads differently from an app). */
  display: 'sans' | 'serif'
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'deep-space',
    label: '深空蓝',
    description: '默认。夜幕色，适合长时间值守。',
    swatches: ['#000000', '#1c1c1e', '#2997ff', '#64d2ff', '#2b5fa8'],
    display: 'sans',
  },
  {
    id: 'paper',
    label: '纸面',
    description: '亮色。纸白底 + 衬线标题，像一份会动的文档。',
    swatches: ['#f5f5f7', '#ffffff', '#0066cc', '#0e7490', '#3f6ea8'],
    display: 'serif',
  },
  {
    id: 'graphite',
    label: '石墨灰',
    description: '中性低饱和。亮环境 / 白墙投影时用。',
    swatches: ['#0a0b0d', '#16181c', '#3f4756', '#4b7f8f', '#47525f'],
    display: 'sans',
  },
  {
    id: 'cyan',
    label: '城市青',
    description: '更冷的青夜。控制室与大屏。',
    swatches: ['#03090b', '#07202a', '#0e5f73', '#12a0b8', '#16788c'],
    display: 'sans',
  },
]

const STORAGE_KEY = 'traffsim3d.theme'

const themeId = ref<string>(THEMES[0]!.id)

/** Mirror the theme onto the document root. */
const apply = (id: string): void => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = id
  const theme = THEMES.find((t) => t.id === id)
  if (theme) {
    document.documentElement.dataset.themeFace = theme.display
  }
}

/**
 * The routes that are expensive to open. Warming them during the
 * theme transition means the click afterwards lands on a screen that is
 * already built.
 */
const HEAVY_ROUTES: ReadonlyArray<() => Promise<unknown>> = [
  () => import('@interfaces/views/SmartCityView.vue'),
  () => import('@interfaces/views/AIPlaygroundView.vue'),
  () => import('@interfaces/views/MapImporterView.vue'),
  () => import('@interfaces/views/SceneEditorView.vue'),
]

/** Warm the heavy routes in the background; failures are ignored. */
export const warmHeavyRoutes = (): void => {
  for (const load of HEAVY_ROUTES) {
    void load().catch(() => undefined)
  }
}

export const setTheme = (id: string, origin?: { x: number; y: number }): void => {
  const theme = THEMES.find((t) => t.id === id)
  if (!theme || theme.id === themeId.value) return

  const doc =
    typeof document === 'undefined'
      ? undefined
      : (document as Document & {
          startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> }
        })
  const start = doc?.startViewTransition

  const commit = (): void => {
    themeId.value = id
    apply(id)
    try {
      window.localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // A private-mode browser without storage: the theme still applies
      // for this session, it just does not survive a reload.
    }
  }

  if (start && origin) {
    // The wipe grows from the button the user pressed.
    const radius = Math.hypot(
      Math.max(origin.x, window.innerWidth - origin.x),
      Math.max(origin.y, window.innerHeight - origin.y),
    )
    const transition = start.call(doc!, () => {
      commit()
    })
    void transition.finished.then(() => warmHeavyRoutes())
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${origin.x}px ${origin.y}px)`,
          `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
        ],
      },
      {
        duration: 480,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
    return
  }

  // No View Transition API (or no origin): a plain cross-fade, and the
  // warm-up still happens.
  commit()
  warmHeavyRoutes()
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
  warmHeavyRoutes,
})

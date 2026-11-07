// The motion layer.
//
// The discipline (from the design work): animate ONLY `transform` and
// `opacity` — never `top`/`left`/`width`/`height` (they trigger layout
// on every frame); reveal elements with an IntersectionObserver, never
// with a `scroll` listener (continuous reflow); put `backdrop-filter`
// only on fixed/sticky chrome, never on scrolling content (the GPU
// repaints every frame otherwise).
//
// `useReveal` wires that up for a container: every child marked
// `data-reveal` fades up when it enters the viewport, staggered by its
// position. The animation itself is CSS (a keyframe), so the JS only
// toggles a class — the browser keeps the frames on the compositor.

import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export interface RevealOptions {
  /** The elements to reveal — default: every `[data-reveal]` inside. */
  selector?: string
  /** Stagger between the revealed elements (ms). */
  stagger?: number
  /** How far below the viewport an element may be and still count. */
  rootMargin?: string
}

export const useReveal = (target: Ref<HTMLElement | null>, options: RevealOptions = {}): void => {
  const selector = options.selector ?? '[data-reveal]'
  const stagger = options.stagger ?? 70
  const rootMargin = options.rootMargin ?? '0px 0px -8% 0px'
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    const root = target.value
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(selector))
    if (items.length === 0) return
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (an old browser): show everything rather than
      // leaving the page blank.
      for (const el of items) el.classList.add('is-revealed')
      return
    }
    items.forEach((el, i) => {
      el.style.setProperty('--reveal-delay', `${i * stagger}ms`)
      el.classList.add('reveal-pending')
    })
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-revealed')
          entry.target.classList.remove('reveal-pending')
          observer?.unobserve(entry.target)
        }
      },
      { rootMargin, threshold: 0.08 },
    )
    for (const el of items) observer.observe(el)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })
}

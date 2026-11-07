// The app-wide scroll reveal.
//
// `useReveal` is per-component; this one watches the whole document, so
// any view can opt in by putting `data-reveal` on its sections — the
// observer re-scans after every route change (the views mount fresh
// markup, and the old elements are gone with them).
//
// Only `transform` and `opacity` move (see theme/motion.css); the
// observer is an IntersectionObserver, never a scroll listener.

import { onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const STAGGER_MS = 70

export const useGlobalReveal = (): void => {
  const router = useRouter()
  let observer: IntersectionObserver | null = null

  const scan = (): void => {
    if (typeof IntersectionObserver === 'undefined') return
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-revealed)'),
    )
    if (items.length === 0) return
    items.forEach((el, i) => {
      el.style.setProperty('--reveal-delay', `${i * STAGGER_MS}ms`)
      el.classList.add('reveal-pending')
      observer?.observe(el)
    })
  }

  onMounted(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-revealed')
          entry.target.classList.remove('reveal-pending')
          observer?.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
    )
    scan()
    router.afterEach(() => {
      // The new view's markup arrives a tick later than the navigation.
      window.setTimeout(scan, 60)
    })
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })
}

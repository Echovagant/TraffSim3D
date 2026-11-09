<!--
  The showcase navigation — one component for every screen.

  Two shapes, because the app has two kinds of page:

    full     the floating glass capsule with the whole module list —
             the content pages (MapLab, AI Playground, DeliveryLab,
             Backend).
    minimal  a small floating brand pill — the immersive 3D screens
             (SceneLab, SmartCity), where a full bar would cover the
             canvas.

  The capsule is detached from the top of the page (Apple's floating
  island): a hairline border, a translucent chrome fill, a 20 px
  backdrop blur and one soft shadow. The active route sits in a
  brighter pill; the links react to the pointer with a 180 ms
  transition; the whole thing scales down a hair while pressed.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ThemeToggle from './ThemeToggle.vue'

const props = withDefaults(
  defineProps<{
    /** `full` = the capsule with the module list; `minimal` = brand only. */
    variant?: 'full' | 'minimal'
  }>(),
  { variant: 'full' },
)

interface NavLink {
  to: string
  label: string
  /** The "New" mark. */
  accent?: boolean
}

const LINKS: readonly NavLink[] = [
  { to: '/scene-editor', label: 'SceneLab' },
  { to: '/map-importer', label: 'MapLab' },
  { to: '/smart-city', label: 'SmartCity 3D', accent: true },
  { to: '/ai-playground', label: 'AI Proving Ground' },
  { to: '/deliverables', label: 'DeliveryLab' },
  { to: '/backend', label: 'Backend' },
]

const route = useRoute()
const isMinimal = computed(() => props.variant === 'minimal')
/**
 * `useRoute()` returns undefined when the component is mounted WITHOUT a
 * router — which is exactly what the unit tests do (they mount a view
 * in isolation). The active-route pill then simply never lights up
 * instead of throwing.
 */
const isActive = (to: string): boolean => route?.path === to
</script>

<template>
  <header class="showcase-nav" :class="`showcase-nav--${variant}`">
    <div class="capsule">
      <router-link to="/" class="brand" aria-label="返回首页">
        <span class="logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
            <circle cx="12" cy="12" r="3.2" fill="currentColor" opacity="0.95" />
            <ellipse
              cx="12"
              cy="12"
              rx="10"
              ry="4.6"
              stroke="currentColor"
              stroke-width="1.3"
              opacity="0.75"
            />
            <ellipse
              cx="12"
              cy="12"
              rx="10"
              ry="4.6"
              stroke="currentColor"
              stroke-width="1.3"
              opacity="0.45"
              transform="rotate(62 12 12)"
            />
          </svg>
        </span>
        <span class="project-name">TraffSim3D</span>
      </router-link>

      <nav v-if="!isMinimal" class="nav-links" aria-label="模块导航">
        <router-link
          v-for="link in LINKS"
          :key="link.to"
          :to="link.to"
          class="nav-link"
          :class="{ 'is-accent': link.accent, 'is-active': isActive(link.to) }"
        >
          {{ link.label }}
        </router-link>
      </nav>
      <router-link v-else to="/" class="back-pill" aria-label="返回首页">← 首页</router-link>
      <ThemeToggle />
    </div>
  </header>
</template>

<style scoped>
.showcase-nav {
  position: fixed;
  top: 14px;
  left: 0;
  right: 0;
  z-index: var(--dc-z-popover);
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.capsule {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px 7px 10px;
  border: 1px solid var(--dc-hairline);
  border-radius: 999px;
  background: var(--dc-chrome);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  transform: translate3d(0, 0, 0);
  animation: nav-in 720ms var(--ds-ease-spring) both;
  transition: transform var(--ds-dur) var(--ds-ease-spring);
}
@keyframes nav-in {
  from {
    opacity: 0;
    transform: translate3d(0, -14px, 0);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
}
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  text-decoration: none;
  color: var(--dc-text);
  transition: opacity var(--ds-dur-fast) var(--ds-ease-out);
}
.brand:hover {
  opacity: 0.75;
}
.logo {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(160deg, #2b6cff, #7d4bff);
  box-shadow: 0 4px 14px rgba(43, 108, 255, 0.42);
}
.project-name {
  font-family: var(--ds-font);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 2px;
}
.nav-link {
  position: relative;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 13px;
  letter-spacing: -0.1px;
  color: var(--dc-text-dim);
  text-decoration: none;
  transition:
    color var(--ds-dur-fast) var(--ds-ease-out),
    background var(--ds-dur-fast) var(--ds-ease-out),
    transform var(--ds-dur-fast) var(--ds-ease-out);
}
.nav-link:hover {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.07);
}
.nav-link:active {
  transform: scale(0.96);
}
.nav-link.is-active {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.13);
}
/* The "New" mark: a glowing dot, not a loud pill. */
.nav-link.is-accent::after {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 6px;
  border-radius: 999px;
  background: var(--dc-flow);
  box-shadow: 0 0 10px var(--dc-flow);
  vertical-align: 2px;
}
.back-pill {
  padding: 6px 13px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--dc-text-dim);
  text-decoration: none;
  transition:
    color var(--ds-dur-fast) var(--ds-ease-out),
    background var(--ds-dur-fast) var(--ds-ease-out);
}
.back-pill:hover {
  color: var(--dc-text);
  background: rgba(255, 255, 255, 0.09);
}

/* The minimal variant sits in the BOTTOM-right corner: the immersive
   screens carry their own chrome at the top (the editor's toolbar) and
   along the left (the panel column), so the top-left corner is taken —
   a brand pill there would overlap the toolbar (measured 2026-11-07). */
.showcase-nav--minimal {
  top: auto;
  bottom: 14px;
  justify-content: flex-end;
  padding-right: 14px;
}
.showcase-nav--minimal .capsule {
  padding: 5px 6px 5px 6px;
  gap: 6px;
}
.showcase-nav--minimal .project-name {
  font-size: 13px;
}

@media (max-width: 1080px) {
  .nav-links {
    display: none;
  }
}
</style>

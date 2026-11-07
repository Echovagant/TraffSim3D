<template>
  <!--
    Root layout. Intentionally a pass-through: every view brings its own
    chrome. This component exists only because Vue Router 4 needs a
    `<router-view />` somewhere in the rendered tree to mount the
    matched route's component — without it the URL changes via
    pushState but nothing visible updates.

    The one thing it DOES own is the route transition: each view enters
    with a short fade-up (transform + opacity only), so navigating
    between the modules reads as one continuous surface rather than a
    hard cut.
  -->
  <router-view v-slot="{ Component, route }">
    <transition name="ds-route" mode="out-in">
      <component :is="Component" :key="route.path" />
    </transition>
  </router-view>
</template>

<script setup>
// No chrome of its own — but the app-wide scroll reveal and the route
// transition live here, so any view can opt in with `data-reveal` on
// its sections.
import { useGlobalReveal } from '@interfaces/composables/useGlobalReveal'

useGlobalReveal()
</script>

<style>
/* The route transition — a short fade-up, transform + opacity only. */
.ds-route-enter-active {
  transition:
    opacity 420ms var(--ds-ease-out),
    transform 420ms var(--ds-ease-spring);
}
.ds-route-leave-active {
  transition:
    opacity 160ms var(--ds-ease-out),
    transform 160ms var(--ds-ease-out);
}
.ds-route-enter-from {
  opacity: 0;
  transform: translate3d(0, 10px, 0);
}
.ds-route-leave-to {
  opacity: 0;
  transform: translate3d(0, -6px, 0);
}
@media (prefers-reduced-motion: reduce) {
  .ds-route-enter-active,
  .ds-route-leave-active {
    transition: none;
  }
}
</style>

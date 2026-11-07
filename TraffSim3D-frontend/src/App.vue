<template>
  <!--
    Root layout. Intentionally a pass-through: every view brings its own
    top nav / toolbar. This component exists only because Vue Router 4
    needs a `<router-view />` somewhere in the rendered tree to mount
    the matched route's component — without it the URL changes via
    pushState but nothing visible updates.
  -->
  <router-view />
</template>

<script setup>
// No chrome of its own — but the app-wide scroll reveal lives here, so
// any view can opt in with `data-reveal` on its sections.
import { useGlobalReveal } from '@interfaces/composables/useGlobalReveal'

useGlobalReveal()
</script>

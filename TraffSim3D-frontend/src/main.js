import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

import App from '@/App.vue'
import router from '@interfaces/router'

// Plan 057: register GSAP plugins once at app boot. ScrollTrigger is
// used by HomeView for module-card stagger-on-scroll entrance and
// could power other scroll-driven animations later (SmartCity view
// hero text, page transitions, etc.). We register before mounting so
// any child component's onMounted can immediately use the plugin.
gsap.registerPlugin(ScrollTrigger)

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

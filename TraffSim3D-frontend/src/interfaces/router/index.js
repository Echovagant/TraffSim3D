import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '@interfaces/views/HomeView.vue'
import { ensureCesiumRuntime } from '@infrastructure/cesium/loadCesiumRuntime'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/scene-editor',
      name: 'scene-editor',
      component: () => import('@interfaces/views/SceneEditorView.vue'),
    },
    {
      path: '/simulation-lab',
      name: 'simulation-lab',
      component: () => import('@interfaces/views/SimulationLabView.vue'),
    },
    {
      path: '/ai-playground',
      name: 'ai-playground',
      component: () => import('@interfaces/views/AIPlaygroundView.vue'),
    },
    {
      path: '/map-importer',
      name: 'map-importer',
      component: () => import('@interfaces/views/MapImporterView.vue'),
    },
    {
      // Plan 055: Smart City view — Cesium basemap + Three.js overlay.
      // Distinct route from /scene-editor so the existing simulator
      // view stays untouched (all existing e2e tests still pass).
      //
      // Plan 066: the Cesium runtime (5.3 MB UMD) is loaded on demand
      // instead of being injected into index.html for every page. The
      // runtime must be in place before this chunk evaluates, hence the
      // explicit `ensureCesiumRuntime()` before the dynamic import.
      path: '/smart-city',
      name: 'smart-city',
      component: () =>
        ensureCesiumRuntime().then(() => import('@interfaces/views/SmartCityView.vue')),
    },
    {
      path: '/deliverables',
      name: 'deliverables',
      component: () => import('@interfaces/views/DeliveryView.vue'),
    },
    {
      path: '/backend',
      name: 'backend',
      component: () => import('@interfaces/views/BackendView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@interfaces/views/NotFoundView.vue'),
    },
  ],
})

export default router

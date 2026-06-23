import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '@interfaces/views/HomeView.vue'

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

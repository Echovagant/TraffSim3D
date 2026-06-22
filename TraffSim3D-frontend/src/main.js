import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from '@interfaces/views/HomeView.vue'
import router from '@interfaces/router'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

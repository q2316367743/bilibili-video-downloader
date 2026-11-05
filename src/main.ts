import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import 'virtual:uno.css'
import 'lazysizes'
import 'lazysizes/plugins/parent-fit/ls.parent-fit'
import VueScan, { type VueScanOptions } from 'z-vue-scan'
import { installFfmpegBridge } from './ffmpegBridge'

const pinia = createPinia()
const app = createApp(App)

const isProduction = import.meta.env.PROD
if (!isProduction) {
  app.use<VueScanOptions>(VueScan, {})
}

async function bootstrap(): Promise<void> {
  // core 通过事件把 ffmpeg 任务交给窗口执行，必须先挂好监听再让 UI 恢复下载任务
  try {
    await installFfmpegBridge()
  } catch (error) {
    console.error('安装 ffmpeg 桥接失败', error)
  }
  app.use(pinia).mount('#app')
}

void bootstrap()

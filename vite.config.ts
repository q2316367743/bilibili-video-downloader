import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vitejs.dev/config/
export default defineConfig({
  // 插件页面通过 plugin://<id>/ui/index.html 加载，资源必须是相对路径
  base: './',
  plugins: [vue(), UnoCSS(), vueJsx({}), vueDevTools()],
  server: {
    port: 5176,
    strictPort: true,
    host: false,
    watch: { ignored: ['**/src-dashou/dashou-dist/**', '**/src-dashou/ui/**'] },
  },
})

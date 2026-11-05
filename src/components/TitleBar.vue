<script setup lang="ts">
import icon from '../../src-dashou/assets/icon.png'
import { PhCopySimple, PhMinus, PhPushPin, PhSquare, PhX } from '@phosphor-icons/vue'
import { getCurrentWindow } from '@dashou/api/window'
import { onMounted, ref } from 'vue'
import { useStore } from '../store.ts'
import { ensureHttps } from '../utils.tsx'
import LoginDialog from '../dialogs/LoginDialog.vue'

const store = useStore()

const appWindow = getCurrentWindow()
const windowMaximised = ref<boolean>(false)
const windowAlwaysOnTop = ref<boolean>(false)

const loginDialogShowing = ref<boolean>(false)

onMounted(async () => {
  windowMaximised.value = await appWindow.isMaximized()
  await appWindow.onResized(async () => {
    windowMaximised.value = await appWindow.isMaximized()
  })
})

function handleAlwaysOnTopButton() {
  windowAlwaysOnTop.value = !windowAlwaysOnTop.value
  void appWindow.setAlwaysOnTop(windowAlwaysOnTop.value)
}
</script>

<template>
  <div
    class="titlebar flex items-center bg-[#F2F2F2] border-b-solid border-b-1 border-b-[#DADADA] h-9 flex-shrink-0 select-none">
    <img :src="icon" alt="icon" class="ml-2 mr-2 w-6 h-6" draggable="false" />
    <span class="text-base select-none">哔哩哔哩视频下载器</span>

    <div class="no-drag flex whitespace-nowrap ml-auto mr-4" @click="loginDialogShowing = true">
      <div v-if="store.userInfo !== undefined" class="flex items-center whitespace-nowrap cursor-pointer">
        <img
          class="w-8 h-8 rounded-full"
          :src="`${ensureHttps(store.userInfo.face)}@128w_128h`"
          alt=""
          draggable="false" />
        <div class="line-clamp-1">{{ store.userInfo.uname }}</div>
      </div>
      <div v-else class="flex items-center whitespace-nowrap cursor-pointer" @click="loginDialogShowing = true">
        <img
          class="w-8 h-8 rounded-full"
          src="https://i0.hdslb.com/bfs/face/member/noface.jpg@128w_128h"
          alt=""
          draggable="false" />
        <div class="line-clamp-1">未登录</div>
      </div>
    </div>

    <div
      title="窗口置顶"
      class="no-drag mr-2 cursor-pointer p-1.5 rounded-lg flex items-center justify-between hover:bg-gray-3/70"
      :class="windowAlwaysOnTop ? 'text-sky-5' : 'text-black'"
      @click="handleAlwaysOnTopButton">
      <PhPushPin size="18" :weight="windowAlwaysOnTop ? 'fill' : 'regular'" />
    </div>

    <div class="no-drag flex items-center select-none">
      <div
        class="flex items-center justify-center h-9 w-9 hover:bg-gray/20 cursor-pointer"
        @click="appWindow.minimize()">
        <PhMinus size="16" />
      </div>
      <div
        class="flex items-center justify-center h-9 w-9 hover:bg-gray/20 cursor-pointer"
        @click="appWindow.toggleMaximize()">
        <PhCopySimple v-if="windowMaximised" size="16" />
        <PhSquare v-else size="14" />
      </div>
      <div
        class="flex items-center justify-center h-9 w-9 hover:bg-red hover:text-white cursor-pointer"
        @click="appWindow.close()">
        <PhX size="16" />
      </div>
    </div>
    <LoginDialog v-model:showing="loginDialogShowing" />
  </div>
</template>

<style scoped>
.titlebar {
  -webkit-app-region: drag;
  app-region: drag;
}

.no-drag {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
</style>

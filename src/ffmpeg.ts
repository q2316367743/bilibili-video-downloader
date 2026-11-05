import { invoke, listen, type UnlistenFn } from '@dashou/api'

/**
 * 窗口侧 ffmpeg 封装。
 *
 * `@dashou/api` 的 runFFmpeg() 不给退出码，而 core 需要靠退出码判断合并是否成功；
 * 这里直接走 `plugin:ffmpeg|run` 命令 + 原始事件拿 runId / code / stderr。
 * 首次调用时宿主会先下载 ffmpeg 运行时（带不可关闭的进度窗口）。
 */

export interface FfmpegHandle {
  /** 强制结束；返回是否真的发出了结束请求 */
  kill: () => Promise<boolean>
}

interface HostEvent {
  runId?: unknown
  code?: unknown
  text?: unknown
}

const MAX_LOG_BYTES = 64 * 1024

export function runFfmpegInWindow(
  args: string[],
  onExit: (code: number, logs: string) => void
): FfmpegHandle {
  let runId = ''
  let finished = false
  let logs = ''
  const unlisteners: UnlistenFn[] = []
  const pending: Array<{ name: string; payload: HostEvent }> = []

  const cleanup = (): void => {
    for (const off of unlisteners.splice(0)) off()
    pending.length = 0
  }

  const handleEvent = (name: string, payload: HostEvent): void => {
    if (finished) return
    if (name === 'ffmpeg:log' && typeof payload.text === 'string') {
      if (logs.length < MAX_LOG_BYTES) logs += payload.text
      return
    }
    if (name === 'ffmpeg:exit') {
      finished = true
      cleanup()
      onExit(typeof payload.code === 'number' ? payload.code : -1, logs)
    }
  }

  const receive = (name: string, payload: unknown): void => {
    const value = payload !== null && typeof payload === 'object' ? (payload as HostEvent) : {}
    if (runId === '') {
      pending.push({ name, payload: value })
      return
    }
    if (value.runId !== runId) return
    handleEvent(name, value)
  }

  const start = async (): Promise<void> => {
    try {
      unlisteners.push(
        await listen<unknown>('ffmpeg:progress', (event) => receive('ffmpeg:progress', event.payload)),
        await listen<unknown>('ffmpeg:log', (event) => receive('ffmpeg:log', event.payload)),
        await listen<unknown>('ffmpeg:exit', (event) => receive('ffmpeg:exit', event.payload))
      )
      const result = await invoke<{ runId: string }>('plugin:ffmpeg|run', { args, cwd: '' })
      runId = result.runId
      for (const item of pending.splice(0)) {
        if (item.payload.runId === runId) handleEvent(item.name, item.payload)
      }
    } catch (error) {
      finished = true
      cleanup()
      const message = error instanceof Error ? error.message : String(error)
      onExit(-1, message)
    }
  }

  void start()

  return {
    kill: async (): Promise<boolean> => {
      if (runId === '') return false
      try {
        return await invoke<boolean>('plugin:ffmpeg|kill', { runId })
      } catch {
        return false
      }
    }
  }
}

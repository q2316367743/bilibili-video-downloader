import { listen } from '@dashou/api'
import { commands } from './bindings'
import { runFfmpegInWindow, type FfmpegHandle } from './ffmpeg'

/**
 * core 没有 ffmpeg 命名空间，视频合并 / 嵌入章节由窗口代跑：
 * core 发 `bili:ffmpeg-run`，这里执行后把退出码和 stderr 尾巴回传。
 */
export async function installFfmpegBridge(): Promise<void> {
  const running = new Map<string, FfmpegHandle>()

  await listen<{ id: string; args: string[] }>('bili:ffmpeg-run', (event) => {
    const { id, args } = event.payload
    const handle = runFfmpegInWindow(args, (code, logs) => {
      running.delete(id)
      void commands.completeFfmpeg(id, code, logs)
    })
    running.set(id, handle)
  })

  await listen<{ id: string }>('bili:ffmpeg-cancel', (event) => {
    const handle = running.get(event.payload.id)
    if (handle === undefined) return
    void handle.kill()
  })
}

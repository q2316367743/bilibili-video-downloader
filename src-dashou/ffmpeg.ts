import { randomUUID } from 'node:crypto'
import { abortError } from './net'
import type { Logger } from './logger'

export interface FfmpegResult {
  code: number
  logs: string
}

interface PendingRun {
  resolve: (result: FfmpegResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  cleanup: () => void
}

/**
 * FFmpeg 运行在窗口侧（宿主 ffmpeg 能力只开放给页面，core 没有对应命名空间）。
 *
 * core 发 `bili:ffmpeg-run`，窗口用 `plugin:ffmpeg|run` 执行并把退出码回传；
 * 暂停 / 删除任务时 core 发 `bili:ffmpeg-cancel`，窗口负责结束进程。
 */
export class FfmpegBridge {
  private readonly pending = new Map<string, PendingRun>()

  constructor(
    private readonly emit: (name: string, payload: unknown) => void,
    private readonly logger: Logger
  ) {}

  run(args: string[], signal: AbortSignal, timeoutMs = 15 * 60_000): Promise<FfmpegResult> {
    if (signal.aborted) return Promise.reject(abortError())
    const id = randomUUID()

    return new Promise<FfmpegResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        this.emit('bili:ffmpeg-cancel', { id })
        reject(abortError())
      }
      const timer = setTimeout(() => {
        cleanup()
        this.emit('bili:ffmpeg-cancel', { id })
        reject(new Error('视频处理超时，请检查文件是否损坏'))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer, cleanup })
      signal.addEventListener('abort', onAbort, { once: true })
      this.logger.info('开始视频处理', { args }, 'downloader.ffmpeg')
      this.emit('bili:ffmpeg-run', { id, args })
    })
  }

  /** 窗口回传执行结果 */
  complete(id: string, code: number, logs: string): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    pending.cleanup()
    if (code === 0) {
      this.logger.info('视频处理完成', { code }, 'downloader.ffmpeg')
      pending.resolve({ code, logs })
      return
    }
    this.logger.warn('视频处理失败', { code, tail: logs.slice(-2000) }, 'downloader.ffmpeg')
    pending.reject(
      new Error(`视频处理失败（ffmpeg 退出码 ${code}），原因可能是视频或音频文件损坏，建议[重来]试试`)
    )
  }
}

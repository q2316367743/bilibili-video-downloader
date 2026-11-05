import { definePluginApi, type PluginContext } from '@dashou/core'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BiliClient } from './bili'
import { defaultCanvasConfig, loadConfig, saveConfig } from './config'
import { DownloadManager, type CreateDownloadTaskParams, type RestartDownloadTaskParams } from './download'
import { FfmpegBridge } from './ffmpeg'
import { Logger } from './logger'
import { setProxy } from './net'
import { availableFormats } from './quality'
import type { Config, LogMetadata, PluginPathsInfo } from './types'

/**
 * 后台脚本：B 站接口、代理、分片下载、断点续传、ffmpeg 调度和文件落盘都在这里。
 * 窗口是沙箱页面，只负责展示和把用户操作转成 API 调用。
 */

let ctxRef: PluginContext | null = null
let dataDir = ''
let config: Config | null = null
let logger: Logger | null = null
let bili: BiliClient | null = null
let manager: DownloadManager | null = null
let ffmpeg: FfmpegBridge | null = null

function requireState(): {
  ctx: PluginContext
  config: Config
  logger: Logger
  bili: BiliClient
  manager: DownloadManager
  ffmpeg: FfmpegBridge
} {
  if (
    ctxRef === null ||
    config === null ||
    logger === null ||
    bili === null ||
    manager === null ||
    ffmpeg === null
  ) {
    throw new Error('插件正在启动，请稍后重试')
  }
  return { ctx: ctxRef, config, logger, bili, manager, ffmpeg }
}

function revealInFileManager(path: string): void {
  const platform = process.platform
  if (platform === 'darwin') {
    spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (platform === 'win32') {
    spawn('explorer', ['/select,', path], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [dirname(path)], { detached: true, stdio: 'ignore' }).unref()
}

type JsonRecord = Record<string, any>

const plugin = definePluginApi({
  async onReady(ctx) {
    ctxRef = ctx
    dataDir = ctx.paths.data
    await mkdir(dataDir, { recursive: true })

    config = await loadConfig(dataDir)
    logger = new Logger(dataDir, (jsonRaw) => {
      ctx.event.emit('log-event', { jsonRaw })
    }, config.enable_file_logger)
    logger.info('插件已启动', { version: (await ctx.plugin.info()).version })

    setProxy({
      mode: config.proxy_mode,
      host: config.proxy_host,
      port: config.proxy_port
    })
    bili = new BiliClient(config, logger)
    ffmpeg = new FfmpegBridge((name, payload) => {
      ctx.event.emit(name, payload)
    }, logger)
    manager = new DownloadManager({
      config: () => config as Config,
      bili,
      logger,
      ffmpeg,
      emitDownload: (payload) => {
        ctx.event.emit('download-event', payload)
      },
      dataDir
    })
    ctx.log('哔哩哔哩视频下载器已启动', 'info')
  },

  async onBeforeQuit() {
    manager?.stop()
    await logger?.flush()
  },

  onError(error) {
    logger?.error('插件运行时出错', error)
  },

  api: {
    getConfig: () => requireState().config,

    saveConfig: async (_ctx, args: { config: Config }) => {
      const state = requireState()
      const previous = state.config
      const next = args.config
      next.proxy_port = Number(next.proxy_port) || 7890
      next.proxy_mode = next.proxy_mode ?? 'NoProxy'
      // 前端类型里没有 bottom_percentage（原 Rust 字段标记了 serde(skip)），补回来
      next.danmaku_config = { ...defaultCanvasConfig(), ...(next.danmaku_config ?? {}) }

      config = next
      await saveConfig(dataDir, next)
      state.bili.updateConfig(next)
      setProxy({
        mode: next.proxy_mode,
        host: next.proxy_host,
        port: next.proxy_port
      })
      if (previous.enable_file_logger !== next.enable_file_logger) {
        state.logger.setFileEnabled(next.enable_file_logger)
      }
      state.logger.debug('保存配置成功')
      return null
    },

    getPaths: () => {
      const state = requireState()
      const info: PluginPathsInfo = {
        data: dataDir,
        logs_dir: state.logger.logsDir,
        config_path: join(dataDir, 'config.json'),
        download_dir: state.config.download_dir
      }
      return info
    },

    getPluginInfo: async () => {
      const state = requireState()
      const info = await state.ctx.plugin.info()
      return { id: info.id, name: info.name, version: info.version }
    },

    generateQrcode: () => requireState().bili.generateQrcode(),

    getQrcodeStatus: (_ctx, args: { qrcodeKey: string }) =>
      requireState().bili.getQrcodeStatus(args.qrcodeKey),

    getUserInfo: (_ctx, args: { sessdata: string }) => requireState().bili.getUserInfo(args.sessdata),

    getNormalInfo: (_ctx, args: { params: { Bvid: string } | { Aid: number } }) =>
      requireState().bili.getNormalInfo(args.params),

    getBangumiInfo: (_ctx, args: { params: { EpId: number } | { SeasonId: number } }) =>
      requireState().bili.getBangumiInfo(args.params),

    getCheeseInfo: (_ctx, args: { params: { EpId: number } | { SeasonId: number } }) =>
      requireState().bili.getCheeseInfo(args.params),

    getUserVideoInfo: (_ctx, args: { params: { pn: number; mid: number } }) =>
      requireState().bili.getUserVideoInfo(args.params),

    getFavFolders: (_ctx, args: { uid: number }) => requireState().bili.getFavFolders(args.uid),

    getFavInfo: (_ctx, args: { params: { media_list_id: number; pn: number } }) =>
      requireState().bili.getFavInfo(args.params),

    getWatchLaterInfo: (_ctx, args: { page: number }) =>
      requireState().bili.getWatchLaterInfo(args.page),

    getBangumiFollowInfo: (
      _ctx,
      args: { params: { vmid: number; type: number; pn: number; follow_status: number } }
    ) => requireState().bili.getBangumiFollowInfo(args.params),

    getHistoryInfo: (
      _ctx,
      args: {
        params: {
          pn: number
          keyword: string
          add_time_start: number
          add_time_end: number
          arc_max_duration: number
          arc_min_duration: number
          device_type: string
        }
      }
    ) => requireState().bili.getHistoryInfo(args.params),

    search: async (_ctx, args: { params: JsonRecord }) => {
      const { bili: client } = requireState()
      const params = args.params
      if (params['Normal'] !== undefined) {
        const info = await client.getNormalInfo(params['Normal'])
        return { Normal: info }
      }
      if (params['Bangumi'] !== undefined) {
        const query = params['Bangumi'] as { EpId: number } | { SeasonId: number }
        const info = await client.getBangumiInfo(query)
        if ('EpId' in query) {
          const episodes = [
            ...info.episodes,
            ...(info.section ?? []).flatMap((section) => section.episodes)
          ]
          const ep = episodes.find((episode) => episode.id === query.EpId) ?? null
          return { Bangumi: { ep, info } }
        }
        return { Bangumi: { ep: null, info } }
      }
      if (params['Cheese'] !== undefined) {
        const query = params['Cheese'] as { EpId: number } | { SeasonId: number }
        const info = await client.getCheeseInfo(query)
        if ('EpId' in query) {
          const ep = info.episodes.find((episode) => episode.id === query.EpId) ?? null
          return { Cheese: { ep, info } }
        }
        return { Cheese: { ep: null, info } }
      }
      if (params['UserVideo'] !== undefined) {
        const info = await client.getUserVideoInfo(params['UserVideo'])
        return { UserVideo: info }
      }
      const info = await client.getFavInfo(params['Fav'])
      return { Fav: info }
    },

    getAvailableMediaFormats: async (_ctx, args: { params: JsonRecord }) => {
      const { bili: client } = requireState()
      const params = args.params
      let mediaUrl: JsonRecord
      if (params['Normal'] !== undefined) {
        mediaUrl = await client.getNormalUrl(params['Normal'].bvid, params['Normal'].cid)
      } else if (params['Bangumi'] !== undefined) {
        mediaUrl = await client.getBangumiUrl(params['Bangumi'].cid)
      } else {
        mediaUrl = await client.getCheeseUrl(params['Cheese'].ep_id)
      }
      return availableFormats(mediaUrl)
    },

    getSkipSegments: (_ctx, args: { bvid: string; cid: number | null }) =>
      requireState().bili.getSkipSegments(args.bvid, args.cid),

    createDownloadTasks: (_ctx, args: { params: CreateDownloadTaskParams }) => {
      requireState().manager.createDownloadTasks(args.params)
      return null
    },

    pauseDownloadTasks: (_ctx, args: { taskIds: string[] }) => {
      requireState().manager.pauseDownloadTasks(args.taskIds)
      return null
    },

    resumeDownloadTasks: (_ctx, args: { taskIds: string[] }) => {
      requireState().manager.resumeDownloadTasks(args.taskIds)
      return null
    },

    deleteDownloadTasks: (_ctx, args: { taskIds: string[] }) => {
      requireState().manager.deleteDownloadTasks(args.taskIds)
      return null
    },

    restartDownloadTasks: (_ctx, args: { taskIds: string[] }) => {
      requireState().manager.restartDownloadTasks(args.taskIds)
      return null
    },

    restartDownloadTask: (_ctx, args: { params: RestartDownloadTaskParams }) => {
      requireState().manager.restartDownloadTask(args.params)
      return null
    },

    restoreDownloadTasks: async () => {
      await requireState().manager.restoreDownloadTasks()
      return null
    },

    getLogsDirSize: () => requireState().logger.logsDirSize(),

    openLogFile: (_ctx, args: { path: string }) =>
      requireState().logger.readLogFile(args.path) as Promise<LogMetadata[]>,

    showPathInFileManager: (_ctx, args: { path: string }) => {
      revealInFileManager(args.path)
      return null
    },

    completeFfmpeg: (_ctx, args: { id: string; code: number; logs: string }) => {
      requireState().ffmpeg.complete(args.id, args.code, args.logs)
      return null
    }
  }
})

export default plugin
export type Api = typeof plugin.api

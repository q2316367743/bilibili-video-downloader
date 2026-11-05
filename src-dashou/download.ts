import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BiliClient } from './bili'
import type { FfmpegBridge } from './ffmpeg'
import type { Logger } from './logger'
import { isAbort, sleep } from './net'
import { availableFormats, toAudioQuality, toCodecType, toVideoQuality } from './quality'
import {
  bangumiToEpisodeNfo,
  bangumiToTvshowNfo,
  cheeseToEpisodeNfo,
  cheeseToTvshowNfo,
  findBangumiEpisode,
  normalToMovieNfo
} from './nfo'
import { ChapterSegments, skipSegmentToChapter } from './chapters'
import { danmakuToXml, danmakusToAss, decodeDanmakuSegment, type DanmakuElem } from './danmaku'
import { filenameFilter, getEpisodeDirAndFilename, secondsToSrtTime, type FmtParams } from './fmt'
import type {
  AudioQuality,
  AudioTask,
  BangumiInfo,
  CheeseInfo,
  CodecType,
  Config,
  DanmakuTask,
  DownloadProgress,
  DownloadTaskState,
  EpisodeType,
  MediaForPrepare,
  NormalInfo,
  PlayerInfo,
  VideoQuality,
  VideoTask
} from './types'

const CHUNK_SIZE = 2 * 1024 * 1024
const TASK_DIR = '.下载任务'
const TEMP_SUFFIX = '.dashou-bilibili-video-downloader'

/* ───────────────────────── 并发工具 ───────────────────────── */

class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve) => {
      this.waiting.push(() => resolve(() => this.release()))
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next !== undefined) {
      next()
    } else {
      this.active -= 1
    }
  }
}

class Signal {
  version = 0
  private resolvers: Array<() => void> = []

  notify(): void {
    this.version += 1
    for (const resolve of this.resolvers.splice(0)) resolve()
  }

  waitForChange(version: number): Promise<void> {
    if (this.version !== version) return Promise.resolve()
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }
}

/* ───────────────────────── 文件工具 ───────────────────────── */

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  data: Buffer,
  position: number
): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
    if (result.bytesWritten <= 0) throw new Error('写入文件失败')
    written += result.bytesWritten
  }
}

/** 逐个 box 检查 MP4 是否完整（最后一个 box 正常收尾、且存在 moov） */
export async function isMp4Complete(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const realSize = (await handle.stat()).size
    let totalSize = 0
    let hasMoov = false
    let isFirst = true
    let position = 0

    while (true) {
      const header = Buffer.alloc(8)
      const read = await handle.read(header, 0, 8, position)
      if (read.bytesRead === 0) break
      if (read.bytesRead < 8) return false

      const rawSize = header.readUInt32BE(0)
      const boxType = header.toString('latin1', 4, 8)

      if (isFirst) {
        if (boxType !== 'ftyp') return false
        isFirst = false
      }
      if (boxType === 'moov') hasMoov = true

      let boxSize: number
      if (rawSize === 0) {
        return true
      } else if (rawSize === 1) {
        const large = Buffer.alloc(8)
        const largeRead = await handle.read(large, 0, 8, position + 8)
        if (largeRead.bytesRead < 8) return false
        boxSize = Number(large.readBigUInt64BE(0))
        if (boxSize < 16) return false
      } else {
        if (rawSize < 8) return false
        boxSize = rawSize
      }

      totalSize += boxSize
      if (totalSize > realSize) return false
      position += boxSize
    }

    return realSize === totalSize && hasMoov
  } finally {
    await handle.close()
  }
}

/* ───────────────────────── 进度数据结构 ───────────────────────── */

interface Tasks {
  video: VideoTask
  audio: AudioTask
  video_process: DownloadProgress['video_process_task']
  danmaku: DanmakuTask
  subtitle: DownloadProgress['subtitle_task']
  cover: DownloadProgress['cover_task']
  nfo: DownloadProgress['nfo_task']
  json: DownloadProgress['json_task']
}

function newTasks(config: Config, coverUrl: string): Tasks {
  return {
    video: {
      selected: config.download_video,
      url: '',
      video_quality: 'Unknown',
      codec_type: 'Unknown',
      content_length: 0,
      chunks: [],
      completed: false,
      skipped: false
    },
    audio: {
      selected: config.download_audio,
      url: '',
      audio_quality: 'Unknown',
      content_length: 0,
      chunks: [],
      completed: false,
      skipped: false
    },
    video_process: {
      merge_selected: config.auto_merge,
      embed_chapter_selected: config.embed_chapter,
      embed_skip_selected: config.embed_skip,
      completed: false,
      skipped: false
    },
    danmaku: {
      xml_selected: config.download_xml_danmaku,
      ass_selected: config.download_ass_danmaku,
      json_selected: config.download_json_danmaku,
      completed: false,
      skipped: false
    },
    subtitle: { selected: config.download_subtitle, completed: false },
    cover: { selected: config.download_cover, url: coverUrl, completed: false },
    nfo: { selected: config.download_nfo, completed: false, skipped: false },
    json: { selected: config.download_json, completed: false }
  }
}

function cloneTasks(tasks: Tasks): Tasks {
  return JSON.parse(JSON.stringify(tasks)) as Tasks
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function newProgress(partial: Partial<DownloadProgress> & { tasks: Tasks }): DownloadProgress {
  const { tasks, ...rest } = partial
  return {
    task_id: randomUUID(),
    episode_type: 'Normal',
    aid: 0,
    bvid: null,
    cid: 0,
    ep_id: null,
    duration: 0,
    pub_ts: 0,
    collection_title: '',
    part_title: null,
    part_order: null,
    episode_title: '',
    episode_order: 1,
    up_name: null,
    up_uid: null,
    up_avatar: null,
    episode_dir: '',
    filename: '',
    video_task: tasks.video,
    audio_task: tasks.audio,
    video_process_task: tasks.video_process,
    danmaku_task: tasks.danmaku,
    subtitle_task: tasks.subtitle,
    cover_task: tasks.cover,
    nfo_task: tasks.nfo,
    json_task: tasks.json,
    create_ts: nowSeconds(),
    completed_ts: null,
    is_drm: false,
    is_preview: false,
    ...rest
  }
}

function progressesForSingle(info: NormalInfo, cid: number | null, config: Config): DownloadProgress[] {
  const tasks = newTasks(config, info.pic)
  const owner = info.owner
  const base = {
    episode_type: 'Normal' as EpisodeType,
    aid: info.aid,
    bvid: info.bvid,
    pub_ts: info.pubdate,
    collection_title: info.title,
    episode_title: info.title,
    episode_order: 1,
    up_name: owner.name,
    up_uid: owner.mid,
    up_avatar: owner.face
  }

  if (cid !== null) {
    const page = info.pages.find((item) => item.cid === cid)
    if (page === undefined) throw new Error('找不到 cid 对应的分P')
    return [
      newProgress({
        ...base,
        tasks,
        cid: page.cid,
        duration: page.duration,
        part_title: page.part,
        part_order: page.page
      })
    ]
  }
  if (info.pages.length === 1) {
    return [newProgress({ ...base, tasks, cid: info.cid, duration: info.duration })]
  }
  return info.pages.map((page) =>
    newProgress({
      ...base,
      tasks: cloneTasks(tasks),
      cid: page.cid,
      duration: page.duration,
      part_title: page.part,
      part_order: page.page
    })
  )
}

function progressesForSeason(
  info: NormalInfo,
  aid: number,
  cid: number | null,
  config: Config
): DownloadProgress[] {
  const season = info.ugc_season
  if (season === null || season === undefined) return progressesForSingle(info, cid, config)

  const section = season.sections.find((item) => item.episodes.some((ep) => ep.aid === aid))
  if (section === undefined) throw new Error('找不到含有对应 aid 的合集章节')
  const index = section.episodes.findIndex((ep) => ep.aid === aid)
  const ep = section.episodes[index]
  if (ep === undefined) throw new Error('在合集章节中找不到对应视频')
  const episodeOrder = index + 1

  const tasks = newTasks(config, ep.arc.pic)
  const base = {
    episode_type: 'Normal' as EpisodeType,
    aid: ep.aid,
    bvid: ep.bvid,
    pub_ts: ep.arc.pubdate,
    collection_title: season.title,
    episode_title: ep.title,
    episode_order: episodeOrder,
    up_name: info.owner.name,
    up_uid: info.owner.mid,
    up_avatar: info.owner.face
  }

  if (cid !== null) {
    const page = ep.pages.find((item) => item.cid === cid)
    if (page === undefined) throw new Error('找不到 cid 对应的分P')
    return [
      newProgress({
        ...base,
        tasks,
        cid: page.cid,
        duration: page.duration,
        part_title: page.part,
        part_order: page.page
      })
    ]
  }
  if (ep.pages.length === 1) {
    const page = ep.pages[0]
    return [
      newProgress({
        ...base,
        tasks,
        cid: page?.cid ?? 0,
        duration: ep.arc.duration,
        part_title: null,
        part_order: null
      })
    ]
  }
  return ep.pages.map((page) =>
    newProgress({
      ...base,
      tasks: cloneTasks(tasks),
      cid: page.cid,
      duration: page.duration,
      part_title: page.part,
      part_order: page.page
    })
  )
}

function progressForBangumi(info: BangumiInfo, epId: number, config: Config): DownloadProgress {
  const found = findBangumiEpisode(info, epId)
  if (found === null) throw new Error('找不到对应章节')
  const { episode, order } = found
  if (episode.duration === null || episode.duration === undefined) {
    throw new Error('章节时长为空')
  }
  const tasks = newTasks(config, episode.cover)
  const up = info.up_info
  return newProgress({
    tasks,
    episode_type: 'Bangumi',
    aid: episode.aid,
    bvid: episode.bvid,
    cid: episode.cid,
    ep_id: episode.id,
    duration: Math.floor(episode.duration / 1000),
    pub_ts: episode.pub_time,
    collection_title: info.title,
    episode_title: episode.show_title ?? episode.title,
    episode_order: order,
    up_name: up?.uname ?? null,
    up_uid: up?.mid ?? null,
    up_avatar: up?.avatar ?? null
  })
}

function progressForCheese(info: CheeseInfo, epId: number, config: Config): DownloadProgress {
  const episode = info.episodes.find((ep) => ep.id === epId)
  if (episode === undefined) throw new Error('找不到 ep_id 对应的课程')
  const tasks = newTasks(config, episode.cover)
  return newProgress({
    tasks,
    episode_type: 'Cheese',
    aid: episode.aid,
    cid: episode.cid,
    ep_id: episode.id,
    duration: episode.duration,
    pub_ts: episode.release_date,
    collection_title: info.title,
    episode_title: episode.title,
    episode_order: episode.index,
    up_name: info.up_info.uname,
    up_uid: info.up_info.mid,
    up_avatar: info.up_info.avatar
  })
}

/* ───────────────────────── 任务 ───────────────────────── */

type EpisodeInfo =
  | { kind: 'Normal'; info: NormalInfo }
  | { kind: 'Bangumi'; info: BangumiInfo }
  | { kind: 'Cheese'; info: CheeseInfo }

export interface DownloadTaskDeps {
  config: () => Config
  bili: BiliClient
  logger: Logger
  ffmpeg: FfmpegBridge
  emitDownload: (payload: unknown) => void
  addBytes: (bytes: number) => void
  taskSem: Semaphore
  chunkSem: Semaphore
  dataDir: string
  removeTask: (taskId: string) => void
}

export class DownloadTask {
  state: DownloadTaskState
  readonly progress: DownloadProgress
  deleted = false

  private readonly deps: DownloadTaskDeps
  private readonly signal = new Signal()
  private controller: AbortController | null = null
  private loopPromise: Promise<void> | null = null
  private saveQueue: Promise<void> = Promise.resolve()
  private lastProgressEmit = 0
  private progressEmitTimer: NodeJS.Timeout | null = null
  private playerInfo: PlayerInfo | null = null
  private episodeInfo: EpisodeInfo | null = null

  constructor(deps: DownloadTaskDeps, progress: DownloadProgress, state: DownloadTaskState) {
    this.deps = deps
    this.progress = progress
    this.state = state
  }

  get taskId(): string {
    return this.progress.task_id
  }

  start(): void {
    if (this.loopPromise !== null) return
    this.loopPromise = this.loop()
  }

  setState(state: DownloadTaskState): void {
    if (this.state !== state) {
      this.state = state
      this.deps.emitDownload({
        event: 'TaskStateUpdate',
        data: { task_id: this.taskId, state }
      })
    }
    this.signal.notify()
  }

  pause(): void {
    this.setState('Paused')
  }

  resume(): void {
    this.setState('Pending')
  }

  restart(): void {
    this.markUncompleted()
    this.setState('Pending')
    this.controller?.abort()
  }

  delete(): void {
    this.deleted = true
    this.controller?.abort()
    this.deps.emitDownload({ event: 'TaskDelete', data: { task_id: this.taskId } })
    const progressPath = join(this.deps.dataDir, TASK_DIR, `${this.taskId}.json`)
    void rm(progressPath, { force: true }).catch(() => {})
    this.signal.notify()
  }

  private emitEvent(payload: unknown): void {
    this.deps.emitDownload(payload)
  }

  private updateProgress(update: (progress: DownloadProgress) => void): void {
    update(this.progress)
    this.emitProgress()
    this.save(false)
  }

  /** 分片很多时进度事件会非常密集，按 10 帧/秒合并一次 */
  private emitProgress(): void {
    const now = Date.now()
    const wait = 100 - (now - this.lastProgressEmit)
    if (wait <= 0) {
      this.lastProgressEmit = now
      this.emitEvent({ event: 'ProgressUpdate', data: { progress: this.progress } })
      return
    }
    if (this.progressEmitTimer === null) {
      this.progressEmitTimer = setTimeout(() => {
        this.progressEmitTimer = null
        this.lastProgressEmit = Date.now()
        this.emitEvent({ event: 'ProgressUpdate', data: { progress: this.progress } })
      }, wait)
    }
  }

  private save(allowCreate: boolean): void {
    const progress = this.progress
    const path = join(this.deps.dataDir, TASK_DIR, `${progress.task_id}.json`)
    this.saveQueue = this.saveQueue
      .then(async () => {
        if (this.deleted) return
        if (!allowCreate && !(await pathExists(path))) return
        await mkdir(join(this.deps.dataDir, TASK_DIR), { recursive: true })
        await writeFile(path, JSON.stringify(progress), 'utf8')
      })
      .catch((error: unknown) => {
        this.deps.logger.error('保存下载进度到文件失败', error)
      })
  }

  /** 创建任务时先把进度落盘 */
  persistNow(): void {
    this.save(true)
  }

  private async loop(): Promise<void> {
    this.emitEvent({ event: 'TaskCreate', data: { state: this.state, progress: this.progress } })
    let release: (() => void) | null = null

    while (!this.deleted) {
      if (this.state === 'Pending') {
        if (release === null) release = await this.deps.taskSem.acquire()
        if (this.deleted) break
        if (this.state !== 'Pending') {
          release()
          release = null
          continue
        }
        this.setState('Downloading')
        continue
      }

      if (this.state === 'Downloading') {
        if (release === null) release = await this.deps.taskSem.acquire()
        this.controller = new AbortController()
        const ok = await this.download(this.controller.signal)
        this.controller = null
        if (this.deleted) break
        if (this.state === 'Downloading') {
          if (ok) {
            await this.sleepBetweenTasks()
            if (!this.deleted && this.state === 'Downloading') this.setState('Completed')
          } else {
            this.setState('Failed')
          }
        }
        release()
        release = null
        continue
      }

      const version = this.signal.version
      await this.signal.waitForChange(version)
    }

    release?.()
  }

  private async sleepBetweenTasks(): Promise<void> {
    let remaining = Math.max(0, Math.trunc(this.deps.config().task_download_interval_sec))
    while (remaining > 0 && !this.deleted && this.state === 'Downloading') {
      this.emitEvent({ event: 'TaskSleeping', data: { task_id: this.taskId, remaining_sec: remaining } })
      await sleep(1000)
      remaining -= 1
    }
  }

  private async download(signal: AbortSignal): Promise<boolean> {
    if (isCompleted(this.progress)) {
      this.setState('Completed')
      return true
    }

    this.emitEvent({ event: 'ProgressPreparing', data: { task_id: this.taskId } })
    try {
      await this.process(signal)
      return true
    } catch (error) {
      if (isAbort(error) || signal.aborted || this.state !== 'Downloading') {
        return false
      }
      this.deps.logger.error('下载失败', error)
      return false
    }
  }

  private ensureActive(signal: AbortSignal): void {
    if (signal.aborted || this.state !== 'Downloading' || this.deleted) {
      const error = new Error('已取消')
      error.name = 'AbortError'
      throw error
    }
  }

  private markUncompleted(): void {
    const p = this.progress
    p.video_task.completed = false
    p.video_task.chunks.forEach((chunk) => {
      chunk.completed = false
    })
    p.video_task.skipped = false
    p.audio_task.completed = false
    p.audio_task.chunks.forEach((chunk) => {
      chunk.completed = false
    })
    p.audio_task.skipped = false
    p.video_process_task.completed = false
    p.video_process_task.skipped = false
    p.danmaku_task.completed = false
    p.danmaku_task.skipped = false
    p.subtitle_task.completed = false
    p.cover_task.completed = false
    p.nfo_task.completed = false
    p.nfo_task.skipped = false
    p.json_task.completed = false
    p.completed_ts = null
  }

  /* ───────────────────────── 主流程 ───────────────────────── */

  private async process(signal: AbortSignal): Promise<void> {
    await this.prepare(signal)
    this.ensureActive(signal)

    this.progress.completed_ts = null
    this.updateProgress((p) => {
      p.completed_ts = null
    })

    await mkdir(this.progress.episode_dir, { recursive: true })

    if (!this.progress.video_task.completed && this.progress.video_task.content_length !== 0) {
      await this.processMedia('video', signal)
      this.ensureActive(signal)
      this.deps.logger.debug('视频下载任务完成', {}, 'downloader')
    }

    if (!this.progress.audio_task.completed && this.progress.audio_task.content_length !== 0) {
      await this.processMedia('audio', signal)
      this.ensureActive(signal)
      this.deps.logger.debug('音频下载任务完成', {}, 'downloader')
    }

    if (!this.progress.video_process_task.completed) {
      await this.processVideo(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('视频处理任务完成', {}, 'downloader')
    }

    if (!isDanmakuCompleted(this.progress.danmaku_task)) {
      await this.processDanmaku(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('弹幕下载任务完成', {}, 'downloader')
    }

    if (!isSelectedTaskCompleted(this.progress.subtitle_task.selected, this.progress.subtitle_task.completed)) {
      await this.processSubtitle(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('字幕下载任务完成', {}, 'downloader')
    }

    if (!isSelectedTaskCompleted(this.progress.cover_task.selected, this.progress.cover_task.completed)) {
      await this.processCover(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('封面下载任务完成', {}, 'downloader')
    }

    if (!isSelectedTaskCompleted(this.progress.nfo_task.selected, this.progress.nfo_task.completed)) {
      await this.processNfo(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('NFO 下载任务完成', {}, 'downloader')
    }

    if (!isSelectedTaskCompleted(this.progress.json_task.selected, this.progress.json_task.completed)) {
      await this.processJson(signal)
      this.ensureActive(signal)
      this.deps.logger.debug('JSON 元数据下载任务完成', {}, 'downloader')
    }

    const completedTs = nowSeconds()
    this.progress.completed_ts = completedTs
    this.updateProgress((p) => {
      p.completed_ts = completedTs
    })
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const videoSelected = p.video_task.selected
    const videoCompleted = p.video_task.completed
    const audioSelected = p.audio_task.selected
    const audioCompleted = p.audio_task.completed

    if ((!videoSelected && !audioSelected) || (videoCompleted && audioCompleted)) {
      this.updateFmtFields()
      return
    }

    const bili = this.deps.bili
    if (p.episode_type === 'Normal') {
      if (p.bvid === null) throw new Error('缺少 bvid，无法获取视频链接')
      const mediaUrl = (await bili.getNormalUrl(p.bvid, p.cid)) as Record<string, any>
      const dash = mediaUrl['dash'] ?? {}
      const durl = mediaUrl['durl'] ?? []
      p.is_preview = durl.length > 0 && (dash['video'] ?? []).length === 0
      if (videoSelected && !videoCompleted) {
        const medias = await this.collectNormalVideoMedias(mediaUrl, signal)
        this.prepareVideo(medias)
      }
      if (audioSelected && !audioCompleted) {
        const medias = await this.collectNormalAudioMedias(mediaUrl, signal)
        this.prepareAudio(medias)
      }
    } else if (p.episode_type === 'Bangumi') {
      const mediaUrl = (await bili.getBangumiUrl(p.cid)) as Record<string, any>
      p.is_preview = mediaUrl['is_preview'] !== 0
      if (videoSelected && !videoCompleted) {
        const medias = await this.collectBangumiVideoMedias(mediaUrl, signal)
        this.prepareVideo(medias)
      }
      if (audioSelected && !audioCompleted) {
        const medias = await this.collectBangumiAudioMedias(mediaUrl, signal)
        this.prepareAudio(medias)
      }
    } else {
      if (p.ep_id === null) throw new Error('缺少 ep_id，无法获取课程视频链接')
      const mediaUrl = (await bili.getCheeseUrl(p.ep_id)) as Record<string, any>
      p.is_drm = mediaUrl['is_drm'] === true
      p.is_preview = mediaUrl['is_preview'] !== 0
      if (videoSelected && !videoCompleted) {
        const medias = await this.collectCheeseVideoMedias(mediaUrl, signal)
        this.prepareVideo(medias)
      }
      if (audioSelected && !audioCompleted) {
        const medias = await this.collectCheeseAudioMedias(mediaUrl, signal)
        this.prepareAudio(medias)
      }
    }

    this.updateFmtFields()
  }

  private updateFmtFields(): void {
    const p = this.progress
    const params: FmtParams = {
      task_id: p.task_id,
      episode_type: p.episode_type,
      aid: p.aid,
      bvid: p.bvid,
      cid: p.cid,
      ep_id: p.ep_id,
      duration: p.duration,
      pub_ts: p.pub_ts,
      collection_title: p.collection_title,
      episode_title: p.episode_title,
      episode_order: p.episode_order,
      part_title: p.part_title,
      part_order: p.part_order,
      up_name: p.up_name,
      up_uid: p.up_uid,
      create_ts: p.create_ts,
      video_quality: p.video_task.video_quality,
      codec_type: p.video_task.codec_type,
      audio_quality: p.audio_task.audio_quality
    }
    const { episodeDir, filename } = getEpisodeDirAndFilename(params, this.deps.config())
    p.episode_dir = episodeDir
    p.filename = filename
  }

  private async collectNormalVideoMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    const medias: MediaForPrepare[] = []
    const dash = mediaUrl['dash'] ?? {}
    for (const media of dash['video'] ?? []) {
      medias.push(
        await this.probeMedia(
          media['id'],
          media['codecid'],
          [...(media['backup_url'] ?? []), media['base_url']],
          signal
        )
      )
    }
    for (const durl of mediaUrl['durl'] ?? []) {
      medias.push(
        await this.probeMedia(
          mediaUrl['quality'],
          mediaUrl['video_codecid'],
          [...(durl['backup_url'] ?? []), durl['url']],
          signal
        )
      )
    }
    return medias.filter((media) => media.url_with_content_length.length > 0)
  }

  private async collectNormalAudioMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    const dash = mediaUrl['dash'] ?? {}
    const candidates: Array<{ id: number; urls: string[] }> = []
    for (const media of dash['audio'] ?? []) {
      candidates.push({ id: media['id'], urls: [...(media['backup_url'] ?? []), media['base_url']] })
    }
    for (const media of dash['dolby']?.['audio'] ?? []) {
      candidates.push({ id: media['id'], urls: [...(media['backup_url'] ?? []), media['base_url']] })
    }
    const flacAudio = dash['flac']?.['audio']
    if (flacAudio !== null && flacAudio !== undefined) {
      candidates.push({
        id: flacAudio['id'],
        urls: [...(flacAudio['backup_url'] ?? []), flacAudio['base_url']]
      })
    }
    return this.probeAllAudio(candidates, signal)
  }

  private async collectBangumiVideoMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    const medias: MediaForPrepare[] = []
    for (const media of mediaUrl['dash']?.['video'] ?? []) {
      medias.push(
        await this.probeMedia(
          media['id'],
          media['codecid'],
          [...(media['backup_url'] ?? []), media['base_url']],
          signal
        )
      )
    }
    for (const durl of mediaUrl['durls'] ?? []) {
      for (const detail of durl['durl'] ?? []) {
        medias.push(
          await this.probeMedia(
            durl['quality'],
            mediaUrl['video_codecid'],
            [...(detail['backup_url'] ?? []), detail['url']],
            signal
          )
        )
      }
    }
    return medias.filter((media) => media.url_with_content_length.length > 0)
  }

  private async collectBangumiAudioMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    const candidates = (mediaUrl['dash']?.['audio'] ?? []).map((media: Record<string, any>) => ({
      id: media['id'],
      urls: [...(media['backup_url'] ?? []), media['base_url']]
    }))
    return this.probeAllAudio(candidates, signal)
  }

  private async collectCheeseVideoMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    return this.collectBangumiVideoMedias(mediaUrl, signal)
  }

  private async collectCheeseAudioMedias(
    mediaUrl: Record<string, any>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    return this.collectBangumiAudioMedias(mediaUrl, signal)
  }

  private async probeAllAudio(
    candidates: Array<{ id: number; urls: string[] }>,
    signal: AbortSignal
  ): Promise<MediaForPrepare[]> {
    const results = await Promise.all(
      candidates.map(async (candidate) => ({
        id: candidate.id,
        codecid: 0,
        url_with_content_length: await this.deps.bili.getUrlsWithContentLength(candidate.urls, signal)
      }))
    )
    return results.filter((media) => media.url_with_content_length.length > 0)
  }

  private async probeMedia(
    id: number,
    codecid: number,
    urls: string[],
    signal: AbortSignal
  ): Promise<MediaForPrepare> {
    return {
      id,
      codecid,
      url_with_content_length: await this.deps.bili.getUrlsWithContentLength(
        urls.filter((url): url is string => typeof url === 'string' && url !== ''),
        signal
      )
    }
  }

  private selectVideo(medias: MediaForPrepare[]): MediaForPrepare {
    if (medias.length === 0) throw new Error('获取视频地址失败，没有可用的视频流')
    const video = this.progress.video_task
    const config = this.deps.config()
    const qualityUnknown = video.video_quality === 'Unknown'
    const codecUnknown = video.codec_type === 'Unknown'
    if (qualityUnknown !== codecUnknown) {
      throw new Error('画质和编码必须同时为 Unknown 或同时不为 Unknown')
    }

    const preferPriority = qualityUnknown
    let selected: MediaForPrepare | undefined
    if (!preferPriority) {
      selected = medias.find(
        (media) =>
          toVideoQuality(media.id) === video.video_quality &&
          toCodecType(media.codecid) === video.codec_type
      )
    }
    if (selected === undefined) {
      const qualityPriority = new Map<VideoQuality, number>(
        config.video_quality_priority.map((quality, index): [VideoQuality, number] => [quality, index])
      )
      const codecPriority = new Map<CodecType, number>(
        config.codec_type_priority.map((codec, index): [CodecType, number] => [codec, index])
      )
      let best: { media: MediaForPrepare; quality: number; codec: number } | null = null
      for (const media of medias) {
        const quality = qualityPriority.get(toVideoQuality(media.id)) ?? Number.MAX_SAFE_INTEGER
        const codec = codecPriority.get(toCodecType(media.codecid)) ?? Number.MAX_SAFE_INTEGER
        if (best === null || quality < best.quality || (quality === best.quality && codec < best.codec)) {
          best = { media, quality, codec }
        }
      }
      selected = best?.media
    }
    if (selected === undefined) throw new Error('获取视频地址失败，没有匹配的视频流')
    return selected
  }

  private prepareVideo(medias: MediaForPrepare[]): void {
    const video = this.progress.video_task
    const selected = this.selectVideo(medias)
    video.video_quality = toVideoQuality(selected.id)
    video.codec_type = toCodecType(selected.codecid)
    const [url, contentLength] =
      selected.url_with_content_length.find(([candidate]) => candidate.startsWith('https://upos-')) ??
      selected.url_with_content_length[0] ??
      ['', 0]
    video.url = url
    setChunks(video, contentLength)
  }

  private prepareAudio(medias: MediaForPrepare[]): void {
    const audio = this.progress.audio_task
    if (medias.length === 0) {
      audio.completed = true
      return
    }
    const config = this.deps.config()
    let selected: MediaForPrepare | undefined
    if (audio.audio_quality !== 'Unknown') {
      selected = medias.find((media) => toAudioQuality(media.id) === audio.audio_quality)
    }
    if (selected === undefined) {
      const priority = new Map<AudioQuality, number>(
        config.audio_quality_priority.map((quality, index): [AudioQuality, number] => [quality, index])
      )
      let best: { media: MediaForPrepare; priority: number } | null = null
      for (const media of medias) {
        const rank = priority.get(toAudioQuality(media.id)) ?? Number.MAX_SAFE_INTEGER
        if (best === null || rank < best.priority) best = { media, priority: rank }
      }
      selected = best?.media
    }
    if (selected === undefined) {
      audio.completed = true
      return
    }
    audio.audio_quality = toAudioQuality(selected.id)
    const [url, contentLength] =
      selected.url_with_content_length.find(([candidate]) => candidate.startsWith('https://upos-')) ??
      selected.url_with_content_length[0] ??
      ['', 0]
    audio.url = url
    setChunks(audio, contentLength)
  }

  /* ───────────────────────── 媒体分片 ───────────────────────── */

  private async processMedia(kind: 'video' | 'audio', signal: AbortSignal): Promise<void> {
    const p = this.progress
    const item = kind === 'video' ? p.video_task : p.audio_task
    const ext = kind === 'video' ? 'mp4' : 'm4a'
    const finalPath = join(p.episode_dir, `${p.filename}.${ext}`)
    const action = this.deps.config().file_exist_action

    if (action === 'Skip' && (await pathExists(finalPath))) {
      this.deps.logger.debug(`${kind === 'video' ? '视频' : '音频'}文件已存在，跳过下载`, {}, 'downloader')
      this.updateProgress((progress) => {
        const target = kind === 'video' ? progress.video_task : progress.audio_task
        target.skipped = true
        target.completed = true
      })
      return
    }

    const tempPath = join(p.episode_dir, `${p.filename}.${ext}${TEMP_SUFFIX}`)
    const expectedSize = item.content_length
    const existingSize = await fileSize(tempPath)
    const reuse = existingSize !== null && existingSize === expectedSize

    const handle = reuse ? await open(tempPath, 'r+') : await open(tempPath, 'w+')
    try {
      if (!reuse) await handle.truncate(expectedSize)

      const pending = item.chunks
        .map((chunk, index) => ({ chunk, index }))
        .filter(({ chunk }) => !chunk.completed)

      const workers = pending.map(async ({ chunk, index }) => {
        const release = await this.deps.chunkSem.acquire()
        try {
          this.ensureActive(signal)
          const data = await this.deps.bili.getMediaChunk(item.url, chunk.start, chunk.end, signal)
          this.ensureActive(signal)
          await writeAll(handle, data, chunk.start)
          this.deps.addBytes(data.length)
          this.updateProgress((progress) => {
            const target = kind === 'video' ? progress.video_task : progress.audio_task
            const targetChunk = target.chunks[index]
            if (targetChunk !== undefined) targetChunk.completed = true
          })
          const interval = this.deps.config().chunk_download_interval_sec
          if (interval > 0) await sleep(interval * 1000, signal)
        } finally {
          release()
        }
      })

      const results = await Promise.allSettled(workers)
      const failed = results.find((result) => result.status === 'rejected')
      if (failed !== undefined) {
        const reason = (failed as PromiseRejectedResult).reason
        if (isAbort(reason)) throw reason
        const chunkCount = item.chunks.length
        throw new Error(
          `${kind === 'video' ? '视频' : '音频'}有分片未下载完成，[继续]可以跳过已下载分片断点续传（共 ${chunkCount} 片）：${
            reason instanceof Error ? reason.message : String(reason)
          }`
        )
      }

      const allCompleted = item.chunks.every((chunk) => chunk.completed)
      if (!allCompleted) {
        throw new Error(
          `${kind === 'video' ? '视频' : '音频'}文件有分片未下载完成，[继续]可以跳过已下载分片断点续传`
        )
      }
    } finally {
      await handle.close()
    }

    if (!(await isMp4Complete(tempPath))) {
      this.updateProgress((progress) => {
        const target = kind === 'video' ? progress.video_task : progress.audio_task
        target.completed = false
        target.chunks.forEach((chunk) => {
          chunk.completed = false
        })
        target.skipped = false
      })
      throw new Error(
        `${kind === 'video' ? '视频' : '音频'}文件不完整，[继续]会重新下载所有分片`
      )
    }

    if (await pathExists(finalPath)) await rm(finalPath, { force: true })
    await rename(tempPath, finalPath)
    this.updateProgress((progress) => {
      const target = kind === 'video' ? progress.video_task : progress.audio_task
      target.completed = true
    })
  }

  /* ───────────────────────── 视频处理 ───────────────────────── */

  private async processVideo(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const task = p.video_process_task
    const embedSelected = task.embed_chapter_selected || task.embed_skip_selected

    if (p.is_drm) {
      this.updateProgress((progress) => {
        progress.video_process_task.skipped = true
        progress.video_process_task.completed = true
      })
      return
    }
    if (!task.merge_selected && !embedSelected) {
      this.updateProgress((progress) => {
        progress.video_process_task.completed = true
      })
      return
    }

    const videoPath = join(p.episode_dir, `${p.filename}.mp4`)
    if (!(await pathExists(videoPath))) {
      this.updateProgress((progress) => {
        progress.video_process_task.completed = true
      })
      return
    }

    const audioPath = join(p.episode_dir, `${p.filename}.m4a`)
    const hasAudio = await pathExists(audioPath)

    if (task.merge_selected && hasAudio) {
      const metadataPath = embedSelected ? await this.createChapterMetadata(signal) : null
      const outputPath = join(p.episode_dir, `${p.filename}-merged.mp4`)
      const args = ['-i', videoPath, '-i', audioPath]
      if (metadataPath !== null) {
        args.push('-i', metadataPath, '-map_metadata', '2')
      }
      args.push('-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outputPath, '-y')
      this.deps.logger.info('合并音视频', { args }, 'downloader.ffmpeg')
      await this.deps.ffmpeg.run(args, signal)
      this.ensureActive(signal)

      await rm(videoPath, { force: true })
      await rm(audioPath, { force: true })
      await rename(outputPath, videoPath)
      if (metadataPath !== null) await rm(metadataPath, { force: true })

      this.updateProgress((progress) => {
        progress.video_process_task.completed = true
      })
      return
    }

    if (embedSelected) {
      await this.embedChapters(videoPath, signal)
      return
    }

    // 只勾了自动合并但音频不存在：保留视频，直接视为完成
    this.updateProgress((progress) => {
      progress.video_process_task.completed = true
    })
  }

  private async embedChapters(videoPath: string, signal: AbortSignal): Promise<void> {
    const p = this.progress
    const metadataPath = await this.createChapterMetadata(signal)
    if (metadataPath === null) {
      this.updateProgress((progress) => {
        progress.video_process_task.completed = true
      })
      return
    }
    const outputPath = join(p.episode_dir, `${p.filename}-embed.mp4`)
    const args = ['-i', videoPath, '-i', metadataPath, '-map_metadata', '1', '-c', 'copy', outputPath, '-y']
    this.deps.logger.info('嵌入章节元数据', { args }, 'downloader.ffmpeg')
    await this.deps.ffmpeg.run(args, signal)
    this.ensureActive(signal)

    await rm(videoPath, { force: true })
    await rename(outputPath, videoPath)
    await rm(metadataPath, { force: true })
    this.updateProgress((progress) => {
      progress.video_process_task.completed = true
    })
  }

  private async createChapterMetadata(signal: AbortSignal): Promise<string | null> {
    const p = this.progress
    const task = p.video_process_task
    const chapters = new ChapterSegments()

    if (task.embed_chapter_selected) {
      const playerInfo = await this.getPlayerInfo(signal)
      chapters.segments = playerInfo.view_points.map((viewPoint) => ({
        title: viewPoint.content,
        start: viewPoint.from,
        end: viewPoint.to
      }))
    }

    if (task.embed_skip_selected && p.bvid !== null) {
      const skipSegments = await this.deps.bili.getSkipSegments(p.bvid, p.cid)
      for (const segment of skipSegments) {
        const chapter = skipSegmentToChapter(segment)
        if (chapter !== null) chapters.insert(chapter)
      }
    }

    if (chapters.segments.length === 0) return null

    const content = chapters.generateChapterMetadata(p.duration)
    const metadataPath = join(p.episode_dir, `${p.filename}.FFMETA.ini`)
    await writeFile(metadataPath, content, 'utf8')
    return metadataPath
  }

  private async getPlayerInfo(signal: AbortSignal): Promise<PlayerInfo> {
    this.ensureActive(signal)
    if (this.playerInfo === null) {
      this.playerInfo = await this.deps.bili.getPlayerInfo(this.progress.aid, this.progress.cid)
    }
    return this.playerInfo
  }

  /* ───────────────────────── 弹幕 / 字幕 / 封面 / NFO / JSON ───────────────────────── */

  private async processDanmaku(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const task = p.danmaku_task
    const xmlPath = join(p.episode_dir, `${p.filename}.弹幕.xml`)
    const assPath = join(p.episode_dir, `${p.filename}.弹幕.ass`)
    const jsonPath = join(p.episode_dir, `${p.filename}.弹幕.json`)

    if (this.deps.config().file_exist_action === 'Skip') {
      const skipXml = !task.xml_selected || (await pathExists(xmlPath))
      const skipAss = !task.ass_selected || (await pathExists(assPath))
      const skipJson = !task.json_selected || (await pathExists(jsonPath))
      if (skipXml && skipAss && skipJson) {
        this.updateProgress((progress) => {
          progress.danmaku_task.skipped = true
          progress.danmaku_task.completed = true
        })
        return
      }
    }

    const segments = await this.deps.bili.getDanmaku(p.aid, p.cid, p.duration, signal)
    this.ensureActive(signal)
    const elems: DanmakuElem[] = []
    const segmentData: Array<Record<string, unknown>> = []
    for (const segment of segments) {
      const decoded = decodeDanmakuSegment(segment)
      // 字段名保持和原 protobuf JSON 一致（snake_case）
      segmentData.push({
        elems: decoded.map((elem) => ({
          id: elem.id,
          progress: elem.progress,
          mode: elem.mode,
          fontsize: elem.fontsize,
          color: elem.color,
          mid_hash: elem.midHash,
          content: elem.content,
          ctime: elem.ctime,
          weight: elem.weight,
          action: elem.action,
          pool: elem.pool,
          id_str: elem.idStr,
          attr: elem.attr,
          animation: elem.animation,
          colorful: elem.colorful
        })),
        state: 0,
        ai_flag: null
      })
      elems.push(...decoded)
    }

    if (task.xml_selected) {
      await writeFile(xmlPath, danmakuToXml(elems, p.cid), 'utf8')
    }
    if (task.ass_selected) {
      const ass = danmakusToAss(elems, this.deps.config().danmaku_config, p.filename)
      await writeFile(assPath, ass, 'utf8')
    }
    if (task.json_selected) {
      await writeFile(jsonPath, JSON.stringify(segmentData), 'utf8')
    }

    this.updateProgress((progress) => {
      progress.danmaku_task.completed = true
    })
  }

  private async processSubtitle(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const playerInfo = await this.getPlayerInfo(signal)
    for (const subtitleDetail of playerInfo.subtitle.subtitles) {
      this.ensureActive(signal)
      const url = `http:${subtitleDetail.subtitle_url}`
      const subtitle = await this.deps.bili.getSubtitle(url)
      const lines: string[] = []
      subtitle.body.forEach((item, index) => {
        lines.push(
          `${index + 1}\n${secondsToSrtTime(item.from)} --> ${secondsToSrtTime(item.to)}\n${item.content}\n`
        )
      })
      const lan = filenameFilter(subtitleDetail.lan)
      await writeFile(join(p.episode_dir, `${p.filename}.${lan}.srt`), lines.join('\n'), 'utf8')
    }
    this.updateProgress((progress) => {
      progress.subtitle_task.completed = true
    })
  }

  private async processCover(signal: AbortSignal): Promise<void> {
    const p = this.progress
    this.ensureActive(signal)
    const { data, ext } = await this.deps.bili.getCoverDataAndExt(p.cover_task.url)
    await writeFile(join(p.episode_dir, `${p.filename}.${ext}`), data)
    this.updateProgress((progress) => {
      progress.cover_task.completed = true
    })
  }

  private async getEpisodeInfo(signal: AbortSignal): Promise<EpisodeInfo> {
    this.ensureActive(signal)
    if (this.episodeInfo !== null) return this.episodeInfo
    const p = this.progress
    if (p.episode_type === 'Normal') {
      this.episodeInfo = {
        kind: 'Normal',
        info: await this.deps.bili.getNormalInfo({ Aid: p.aid })
      }
    } else if (p.episode_type === 'Bangumi') {
      if (p.ep_id === null) throw new Error('缺少 ep_id')
      this.episodeInfo = {
        kind: 'Bangumi',
        info: await this.deps.bili.getBangumiInfo({ EpId: p.ep_id })
      }
    } else {
      if (p.ep_id === null) throw new Error('缺少 ep_id')
      this.episodeInfo = {
        kind: 'Cheese',
        info: await this.deps.bili.getCheeseInfo({ EpId: p.ep_id })
      }
    }
    return this.episodeInfo
  }

  private async processNfo(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const nfoPath = join(p.episode_dir, `${p.filename}.nfo`)
    if (this.deps.config().file_exist_action === 'Skip' && (await pathExists(nfoPath))) {
      this.updateProgress((progress) => {
        progress.nfo_task.skipped = true
        progress.nfo_task.completed = true
      })
      return
    }

    const episodeInfo = await this.getEpisodeInfo(signal)
    const bili = this.deps.bili

    if (episodeInfo.kind === 'Normal') {
      const info = episodeInfo.info
      const tags = await bili.getTags(p.aid)
      await writeFile(nfoPath, normalToMovieNfo(info, tags), 'utf8')
      if (info.ugc_season !== null && info.ugc_season !== undefined) {
        const cover = await bili.getCoverDataAndExt(info.ugc_season.cover)
        await writeFile(join(p.episode_dir, `poster.${cover.ext}`), cover.data)
      }
    } else if (episodeInfo.kind === 'Bangumi') {
      const info = episodeInfo.info
      if (p.ep_id === null) throw new Error('缺少 ep_id')
      await writeFile(join(p.episode_dir, 'tvshow.nfo'), bangumiToTvshowNfo(info), 'utf8')
      await writeFile(nfoPath, bangumiToEpisodeNfo(info, p.ep_id), 'utf8')
      const poster = await bili.getCoverDataAndExt(info.cover)
      await writeFile(join(p.episode_dir, `poster.${poster.ext}`), poster.data)
      if (info.bkg_cover !== '') {
        const fanart = await bili.getCoverDataAndExt(info.bkg_cover)
        await writeFile(join(p.episode_dir, `fanart.${fanart.ext}`), fanart.data)
      }
    } else {
      const info = episodeInfo.info
      if (p.ep_id === null) throw new Error('缺少 ep_id')
      await writeFile(join(p.episode_dir, 'tvshow.nfo'), cheeseToTvshowNfo(info), 'utf8')
      await writeFile(nfoPath, cheeseToEpisodeNfo(info, p.ep_id), 'utf8')
      const poster = await bili.getCoverDataAndExt(info.cover)
      await writeFile(join(p.episode_dir, `poster.${poster.ext}`), poster.data)
    }

    this.updateProgress((progress) => {
      progress.nfo_task.completed = true
    })
  }

  private async processJson(signal: AbortSignal): Promise<void> {
    const p = this.progress
    const episodeInfo = await this.getEpisodeInfo(signal)
    const json = JSON.stringify(episodeInfo.info)
    await writeFile(join(p.episode_dir, `${p.filename}-元数据.json`), json, 'utf8')
    this.updateProgress((progress) => {
      progress.json_task.completed = true
    })
  }
}

function setChunks(task: VideoTask | AudioTask, contentLength: number): void {
  if (task.content_length === contentLength && task.chunks.length > 0) return
  const chunkCount = Math.ceil(contentLength / CHUNK_SIZE)
  const chunks: Array<{ start: number; end: number; completed: boolean }> = []
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, contentLength) - 1
    chunks.push({ start, end, completed: false })
  }
  task.content_length = contentLength
  task.chunks = chunks
}

function isSelectedTaskCompleted(selected: boolean, completed: boolean): boolean {
  return !selected || completed
}

function isDanmakuCompleted(task: DanmakuTask): boolean {
  return (!task.xml_selected && !task.ass_selected && !task.json_selected) || task.completed
}

export function isCompleted(progress: DownloadProgress): boolean {
  return (
    isSelectedTaskCompleted(progress.video_task.selected, progress.video_task.completed) &&
    isSelectedTaskCompleted(progress.audio_task.selected, progress.audio_task.completed) &&
    isSelectedTaskCompleted(
      progress.video_process_task.merge_selected ||
        progress.video_process_task.embed_chapter_selected ||
        progress.video_process_task.embed_skip_selected,
      progress.video_process_task.completed
    ) &&
    isDanmakuCompleted(progress.danmaku_task) &&
    isSelectedTaskCompleted(progress.subtitle_task.selected, progress.subtitle_task.completed) &&
    isSelectedTaskCompleted(progress.cover_task.selected, progress.cover_task.completed) &&
    isSelectedTaskCompleted(progress.nfo_task.selected, progress.nfo_task.completed) &&
    isSelectedTaskCompleted(progress.json_task.selected, progress.json_task.completed)
  )
}

/* ───────────────────────── 管理器 ───────────────────────── */

export interface CreateDownloadTaskParams {
  Normal?: { info: NormalInfo; aid_cid_pairs: Array<[number, number | null]> }
  Bangumi?: { ep_ids: number[]; info: BangumiInfo }
  Cheese?: { ep_ids: number[]; info: CheeseInfo }
}

export interface RestartDownloadTaskParams {
  task_id: string
  video_task_selected: boolean
  audio_task_selected: boolean
  merge_selected: boolean
  embed_chapter_selected: boolean
  embed_skip_selected: boolean
  subtitle_task_selected: boolean
  xml_danmaku_selected: boolean
  ass_danmaku_selected: boolean
  json_danmaku_selected: boolean
  cover_task_selected: boolean
  nfo_task_selected: boolean
  json_task_selected: boolean
  video_quality: VideoQuality
  codec_type: CodecType
  audio_quality: AudioQuality
}

export class DownloadManager {
  readonly taskSem: Semaphore
  readonly chunkSem: Semaphore
  private readonly tasks = new Map<string, DownloadTask>()
  private bytePerSec = 0
  private speedTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: Omit<DownloadTaskDeps, 'taskSem' | 'chunkSem' | 'removeTask' | 'addBytes'>) {
    const config = deps.config()
    const taskConcurrency = Number.isFinite(config.task_concurrency)
      ? Math.max(1, Math.trunc(config.task_concurrency))
      : 3
    const chunkConcurrency = Number.isFinite(config.chunk_concurrency)
      ? Math.max(1, Math.trunc(config.chunk_concurrency))
      : 16
    this.taskSem = new Semaphore(taskConcurrency)
    this.chunkSem = new Semaphore(chunkConcurrency)
    this.speedTimer = setInterval(() => {
      const bytes = this.bytePerSec
      this.bytePerSec = 0
      const speed = `${(bytes / 1024 / 1024).toFixed(2)}MB/s`
      deps.emitDownload({ event: 'Speed', data: { speed } })
    }, 1000)
  }

  stop(): void {
    if (this.speedTimer !== null) clearInterval(this.speedTimer)
    this.speedTimer = null
  }

  getTaskCount(): number {
    return this.tasks.size
  }

  private taskDeps(): DownloadTaskDeps {
    return {
      ...this.deps,
      taskSem: this.taskSem,
      chunkSem: this.chunkSem,
      addBytes: (bytes) => {
        this.bytePerSec += bytes
      },
      removeTask: (taskId) => {
        this.tasks.delete(taskId)
      }
    }
  }

  createDownloadTasks(params: CreateDownloadTaskParams): void {
    const config = this.deps.config()
    const progresses: DownloadProgress[] = []
    const add = (create: () => DownloadProgress[]): void => {
      try {
        progresses.push(...create())
      } catch (error) {
        this.deps.logger.error('创建下载任务失败', error)
      }
    }

    if (params.Normal !== undefined) {
      const { info, aid_cid_pairs } = params.Normal
      for (const [aid, cid] of aid_cid_pairs) {
        add(() =>
          info.ugc_season !== null && info.ugc_season !== undefined
            ? progressesForSeason(info, aid, cid, config)
            : progressesForSingle(info, cid, config)
        )
      }
    } else if (params.Bangumi !== undefined) {
      for (const epId of params.Bangumi.ep_ids) {
        add(() => [progressForBangumi(params.Bangumi!.info, epId, config)])
      }
    } else if (params.Cheese !== undefined) {
      for (const epId of params.Cheese.ep_ids) {
        add(() => [progressForCheese(params.Cheese!.info, epId, config)])
      }
    }

    const autoStart = config.auto_start_download_task
    for (const progress of progresses) {
      const task = new DownloadTask(this.taskDeps(), progress, autoStart ? 'Pending' : 'Paused')
      this.tasks.set(task.taskId, task)
      task.persistNow()
      task.start()
      // TaskCreate 事件由任务循环发出；这里先把进度落盘
    }
  }

  async restoreDownloadTasks(): Promise<void> {
    const taskDir = join(this.deps.dataDir, TASK_DIR)
    await mkdir(taskDir, { recursive: true })
    let entries: string[]
    try {
      entries = await readdir(taskDir)
    } catch (error) {
      this.deps.logger.error('读取下载任务目录失败', error)
      return
    }
    for (const entry of entries) {
      const path = join(taskDir, entry)
      if (!entry.endsWith('.json')) {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      let progress: DownloadProgress
      try {
        progress = JSON.parse(await readFile(path, 'utf8')) as DownloadProgress
      } catch {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      try {
        if (typeof progress.task_id !== 'string' || progress.video_task === undefined) {
          throw new Error('下载任务文件格式不正确')
        }
        if (this.tasks.has(progress.task_id)) continue
        const task = new DownloadTask(
          this.taskDeps(),
          progress,
          isCompleted(progress) ? 'Completed' : 'Paused'
        )
        this.tasks.set(task.taskId, task)
        task.start()
      } catch (error) {
        this.deps.logger.error('恢复下载任务失败', error)
        await rm(path, { force: true }).catch(() => {})
      }
    }
  }

  pauseDownloadTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId)
      if (task === undefined) {
        this.deps.logger.warn('未找到 ID 对应的下载任务', { err_title: '暂停下载任务失败', task_id: taskId })
        continue
      }
      task.pause()
    }
  }

  resumeDownloadTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId)
      if (task === undefined) {
        this.deps.logger.warn('未找到 ID 对应的下载任务', { err_title: '继续下载任务失败', task_id: taskId })
        continue
      }
      task.resume()
    }
  }

  deleteDownloadTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId)
      if (task === undefined) {
        this.deps.logger.warn('未找到 ID 对应的下载任务', { err_title: '删除下载任务失败', task_id: taskId })
        continue
      }
      task.delete()
    }
  }

  restartDownloadTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId)
      if (task === undefined) {
        this.deps.logger.warn('未找到 ID 对应的下载任务', { err_title: '重来下载任务失败', task_id: taskId })
        continue
      }
      task.restart()
    }
  }

  restartDownloadTask(params: RestartDownloadTaskParams): void {
    const task = this.tasks.get(params.task_id)
    if (task === undefined) {
      this.deps.logger.warn('未找到 ID 对应的下载任务', {
        err_title: '重来下载任务失败',
        task_id: params.task_id
      })
      return
    }
    const progress = task.progress
    progress.video_task.selected = params.video_task_selected
    progress.audio_task.selected = params.audio_task_selected
    progress.video_process_task.merge_selected = params.merge_selected
    progress.video_process_task.embed_chapter_selected = params.embed_chapter_selected
    progress.video_process_task.embed_skip_selected = params.embed_skip_selected
    progress.subtitle_task.selected = params.subtitle_task_selected
    progress.danmaku_task.xml_selected = params.xml_danmaku_selected
    progress.danmaku_task.ass_selected = params.ass_danmaku_selected
    progress.danmaku_task.json_selected = params.json_danmaku_selected
    progress.cover_task.selected = params.cover_task_selected
    progress.nfo_task.selected = params.nfo_task_selected
    progress.json_task.selected = params.json_task_selected
    progress.video_task.video_quality = params.video_quality
    progress.video_task.codec_type = params.codec_type
    progress.audio_task.audio_quality = params.audio_quality
    task.restart()
  }

  getAvailableFormats(mediaUrl: Record<string, any>): ReturnType<typeof availableFormats> {
    return availableFormats(mediaUrl)
  }

  /** 供 API 查询：是否存在未完成的任务（目前 UI 不用，但保留给后续） */
  hasUncompleted(): boolean {
    for (const task of this.tasks.values()) {
      if (!isCompleted(task.progress)) return true
    }
    return false
  }
}

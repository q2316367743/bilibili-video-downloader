/**
 * core 侧用到的数据结构。
 *
 * 字段名保持和 B 站接口 / 原 Rust 版本一致（snake_case），
 * 前端的 `src/bindings.ts` 也是同一形状，两边可以直接序列化传递。
 */

export type ProxyMode = 'NoProxy' | 'System' | 'Custom'
export type FileExistAction = 'Overwrite' | 'Skip'

export type VideoQuality =
  | 'Unknown'
  | '240P'
  | '360P'
  | '480P'
  | '720P'
  | '720P60'
  | '1080P'
  | 'AiRepair'
  | '1080P+'
  | '1080P60'
  | '4K'
  | 'HDR'
  | 'Dolby'
  | '8K'

export type AudioQuality = 'Unknown' | '64K' | '132K' | '192K' | 'Dolby' | 'HiRes'

export type CodecType = 'Unknown' | 'Audio' | 'AVC' | 'HEVC' | 'AV1'

export interface CanvasConfig {
  duration: number
  width: number
  height: number
  font: string
  font_size: number
  width_ratio: number
  horizontal_gap: number
  lane_size: number
  float_percentage: number
  bottom_percentage: number
  alpha: number
  bold: boolean
  outline: number
  time_offset: number
}

export interface Config {
  download_dir: string
  enable_file_logger: boolean
  sessdata: string
  video_quality_priority: VideoQuality[]
  codec_type_priority: CodecType[]
  audio_quality_priority: AudioQuality[]
  download_video: boolean
  download_audio: boolean
  auto_merge: boolean
  embed_chapter: boolean
  embed_skip: boolean
  download_xml_danmaku: boolean
  download_ass_danmaku: boolean
  download_json_danmaku: boolean
  download_subtitle: boolean
  download_cover: boolean
  download_nfo: boolean
  download_json: boolean
  dir_fmt: string
  dir_fmt_for_part: string
  time_fmt: string
  proxy_mode: ProxyMode
  proxy_host: string
  proxy_port: number
  task_concurrency: number
  task_download_interval_sec: number
  chunk_concurrency: number
  chunk_download_interval_sec: number
  danmaku_config: CanvasConfig
  file_exist_action: FileExistAction
  auto_start_download_task: boolean
}

export type DownloadTaskState = 'Pending' | 'Downloading' | 'Paused' | 'Completed' | 'Failed'

export type EpisodeType = 'Normal' | 'Bangumi' | 'Cheese'

export interface MediaChunk {
  start: number
  end: number
  completed: boolean
}

export interface VideoTask {
  selected: boolean
  url: string
  video_quality: VideoQuality
  codec_type: CodecType
  content_length: number
  chunks: MediaChunk[]
  completed: boolean
  skipped: boolean
}

export interface AudioTask {
  selected: boolean
  url: string
  audio_quality: AudioQuality
  content_length: number
  chunks: MediaChunk[]
  completed: boolean
  skipped: boolean
}

export interface VideoProcessTask {
  merge_selected: boolean
  embed_chapter_selected: boolean
  embed_skip_selected: boolean
  completed: boolean
  skipped: boolean
}

export interface DanmakuTask {
  xml_selected: boolean
  ass_selected: boolean
  json_selected: boolean
  completed: boolean
  skipped: boolean
}

export interface SubtitleTask {
  selected: boolean
  completed: boolean
}

export interface CoverTask {
  selected: boolean
  url: string
  completed: boolean
}

export interface NfoTask {
  selected: boolean
  completed: boolean
  skipped: boolean
}

export interface JsonTask {
  selected: boolean
  completed: boolean
}

export interface DownloadProgress {
  task_id: string
  episode_type: EpisodeType
  aid: number
  bvid: string | null
  cid: number
  ep_id: number | null
  duration: number
  pub_ts: number
  collection_title: string
  part_title: string | null
  part_order: number | null
  episode_title: string
  episode_order: number
  up_name: string | null
  up_uid: number | null
  up_avatar: string | null
  episode_dir: string
  filename: string
  video_task: VideoTask
  audio_task: AudioTask
  video_process_task: VideoProcessTask
  subtitle_task: SubtitleTask
  danmaku_task: DanmakuTask
  cover_task: CoverTask
  nfo_task: NfoTask
  json_task: JsonTask
  create_ts: number
  completed_ts: number | null
  is_drm: boolean
  is_preview: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface NormalInfo {
  bvid: string
  aid: number
  videos: number
  tname: string
  tname_v2: string
  pic: string
  title: string
  pubdate: number
  desc: string
  duration: number
  owner: { mid: number; name: string; face: string }
  stat?: any
  cid: number
  pages: Array<{ cid: number; page: number; part: string; duration: number }>
  staff?: Array<{ name: string; title: string; face: string }> | null
  ugc_season?: UgcSeason | null
  [key: string]: any
}

export interface UgcSeason {
  id: number
  title: string
  cover: string
  intro: string
  sections: Array<{ episodes: Array<EpInUgcSeason> }>
}

export interface EpInUgcSeason {
  aid: number
  bvid: string
  title: string
  arc: { pic: string; pubdate: number; duration: number; title: string; author: { name: string; mid: number } }
  pages: Array<{ cid: number; page: number; part: string; duration: number }>
}

export interface EpInBangumi {
  aid: number
  bvid: string | null
  cid: number
  cover: string
  duration: number | null
  id: number
  link: string
  link_type: number | null
  pub_time: number
  show_title: string | null
  title: string
  share_copy?: string | null
  [key: string]: any
}

export interface BangumiInfo {
  title: string
  cover: string
  bkg_cover: string
  evaluate: string
  share_sub_title: string
  type: number
  styles: string[]
  areas: Array<{ id: number; name: string }>
  publish: { pub_time: string; is_finish: number }
  up_info: { uname: string; mid: number; avatar: string } | null
  episodes: EpInBangumi[]
  section: Array<{ episodes: EpInBangumi[] }> | null
  season_id: number
  [key: string]: any
}

export interface EpInCheese {
  aid: number
  cid: number
  cover: string
  duration: number
  id: number
  index: number
  release_date: number
  subtitle: string
  title: string
  [key: string]: any
}

export interface CheeseInfo {
  title: string
  subtitle: string
  cover: string
  release_status: string
  up_info: { uname: string; mid: number; avatar: string }
  episodes: EpInCheese[]
  [key: string]: any
}

export interface PlayerInfo {
  view_points: Array<{ content: string; from: number; to: number }>
  subtitle: { subtitles: Array<{ lan: string; subtitle_url: string }> }
  [key: string]: any
}

export interface MediaForPrepare {
  id: number
  codecid: number
  url_with_content_length: Array<[string, number]>
}

export interface SkipSegment {
  cid: string
  category: string
  actionType: string
  segment: number[]
  UUID: string
  videoDuration: number
  locked: number
  votes: number
  description: string
}

export interface LogMetadata {
  timestamp: string
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  fields: Record<string, unknown>
  target: string
  filename: string
  line_number: number
  span: unknown
  spans: Array<{ name: string } & Record<string, unknown>>
}

export interface PluginPathsInfo {
  data: string
  logs_dir: string
  config_path: string
  download_dir: string
}

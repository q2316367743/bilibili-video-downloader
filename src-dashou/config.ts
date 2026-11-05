import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CanvasConfig, Config } from './types'

export const DEFAULT_DIR_FMT = '{collection_title}/{episode_title}'
export const DEFAULT_DIR_FMT_FOR_PART =
  '{collection_title}/{episode_title}/{episode_title}-P{part_order} {part_title}'

export function defaultCanvasConfig(): CanvasConfig {
  return {
    duration: 15,
    width: 1280,
    height: 720,
    font: '黑体',
    font_size: 25,
    width_ratio: 1.2,
    horizontal_gap: 20,
    lane_size: 32,
    float_percentage: 0.5,
    bottom_percentage: 0.3,
    alpha: 0.7,
    bold: false,
    outline: 0.8,
    time_offset: 0
  }
}

export function defaultConfig(dataDir: string): Config {
  return {
    download_dir: join(dataDir, '视频下载'),
    enable_file_logger: true,
    sessdata: '',
    video_quality_priority: [
      '8K',
      'Dolby',
      'HDR',
      '4K',
      '1080P60',
      '1080P+',
      '1080P',
      'AiRepair',
      '720P60',
      '720P',
      '480P',
      '360P',
      '240P'
    ],
    codec_type_priority: ['AVC', 'HEVC', 'AV1'],
    audio_quality_priority: ['HiRes', 'Dolby', '192K', '132K', '64K'],
    download_video: true,
    download_audio: true,
    auto_merge: true,
    embed_chapter: true,
    embed_skip: true,
    download_xml_danmaku: true,
    download_ass_danmaku: true,
    download_json_danmaku: true,
    download_subtitle: true,
    download_cover: true,
    download_nfo: true,
    download_json: true,
    dir_fmt: DEFAULT_DIR_FMT,
    dir_fmt_for_part: DEFAULT_DIR_FMT_FOR_PART,
    time_fmt: '%Y-%m-%d_%H-%M-%S',
    proxy_mode: 'NoProxy',
    proxy_host: '127.0.0.1',
    proxy_port: 7890,
    task_concurrency: 3,
    task_download_interval_sec: 0,
    chunk_concurrency: 16,
    chunk_download_interval_sec: 0,
    danmaku_config: defaultCanvasConfig(),
    file_exist_action: 'Overwrite',
    auto_start_download_task: true
  }
}

/** 新版本加了字段时，用默认值补齐，避免配置整体被重置 */
function mergeConfig(raw: unknown, dataDir: string): Config {
  const base = defaultConfig(dataDir)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return base
  }
  const source = raw as Record<string, unknown>
  const merged = { ...base } as Record<string, unknown>
  for (const key of Object.keys(base)) {
    if (source[key] !== undefined) merged[key] = source[key]
  }
  if (typeof merged['download_dir'] !== 'string' || merged['download_dir'].trim() === '') {
    merged['download_dir'] = base.download_dir
  }
  // 嵌套的弹幕配置单独补齐
  const canvas = source['danmaku_config']
  if (canvas !== null && typeof canvas === 'object' && !Array.isArray(canvas)) {
    merged['danmaku_config'] = { ...defaultCanvasConfig(), ...(canvas as Record<string, unknown>) }
  }
  return merged as unknown as Config
}

export async function loadConfig(dataDir: string): Promise<Config> {
  const configPath = join(dataDir, 'config.json')
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    const config = defaultConfig(dataDir)
    await saveConfig(dataDir, config)
    return config
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const config = defaultConfig(dataDir)
    await saveConfig(dataDir, config)
    return config
  }
  const config = mergeConfig(parsed, dataDir)
  await saveConfig(dataDir, config)
  return config
}

export async function saveConfig(dataDir: string, config: Config): Promise<void> {
  const configPath = join(dataDir, 'config.json')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
}

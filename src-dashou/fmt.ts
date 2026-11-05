import { join } from 'node:path'
import type { AudioQuality, CodecType, Config, EpisodeType, VideoQuality } from './types'

/** 和原 Rust 版本一致：把文件名里不能用的字符替换掉 */
export function filenameFilter(input: string): string {
  const mapped = Array.from(input)
    .map((char) => {
      switch (char) {
        case '\\':
        case '/':
        case '\n':
          return ' '
        case ':':
          return '：'
        case '*':
          return '⭐'
        case '?':
          return '？'
        case '"':
          return "'"
        case '<':
          return '《'
        case '>':
          return '》'
        case '|':
          return '丨'
        default:
          return char
      }
    })
    .join('')
  return mapped.trim().replace(/\.+$/, '').trim()
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad(value: number, width = 2, fill = '0'): string {
  const text = String(Math.abs(Math.trunc(value)))
  const sign = value < 0 ? '-' : ''
  return sign + (fill === '0' ? text.padStart(width, fill) : text.padStart(width, fill))
}

/** chrono 常用 format 子集 */
export function formatTimestamp(ts: number, format: string): string {
  const date = new Date(ts * 1000)
  const dayOfYear =
    Math.floor(
      (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
        Date.UTC(date.getFullYear(), 0, 1)) /
        86_400_000
    ) + 1
  const replacements: Record<string, string> = {
    '%Y': String(date.getFullYear()),
    '%y': pad(date.getFullYear() % 100),
    '%m': pad(date.getMonth() + 1),
    '%d': pad(date.getDate()),
    '%e': String(date.getDate()).padStart(2, ' '),
    '%H': pad(date.getHours()),
    '%k': String(date.getHours()).padStart(2, ' '),
    '%M': pad(date.getMinutes()),
    '%S': pad(date.getSeconds()),
    '%j': pad(dayOfYear, 3),
    '%F': `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    '%T': `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    '%R': `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    '%s': String(Math.trunc(date.getTime() / 1000)),
    '%b': MONTHS[date.getMonth()]?.slice(0, 3) ?? '',
    '%B': MONTHS[date.getMonth()] ?? '',
    '%a': WEEKDAYS[date.getDay()]?.slice(0, 3) ?? '',
    '%A': WEEKDAYS[date.getDay()] ?? '',
    '%p': date.getHours() < 12 ? 'AM' : 'PM',
    '%n': '\n',
    '%t': '\t',
    '%%': '%'
  }
  let result = ''
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] === '%' && i + 1 < format.length) {
      const token = format.slice(i, i + 2)
      if (replacements[token] !== undefined) {
        result += replacements[token]
        i += 1
        continue
      }
    }
    result += format[i]
  }
  return result
}

/** Rust `strfmt::strfmt` 的常用子集：`{name}` / `{name:0>4}` / `{name:>4}` */
export function strfmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)(?::([^}]*))?\}/g, (_all, name: string, spec?: string) => {
    const value = vars[name] ?? ''
    if (spec === undefined || spec === '') return value
    const match = /^(0)?([<>^])(\d+)$/.exec(spec)
    if (match === null) return value
    const fill = match[1] === '0' ? '0' : ' '
    const align = match[2]
    const width = Number(match[3])
    if (align === '<') return value.padEnd(width, fill)
    if (align === '^') {
      const total = Math.max(0, width - value.length)
      const left = Math.floor(total / 2)
      return fill.repeat(left) + value + fill.repeat(total - left)
    }
    return value.padStart(width, fill)
  })
}

export interface FmtParams {
  task_id: string
  episode_type: EpisodeType
  aid: number
  bvid: string | null
  cid: number
  ep_id: number | null
  duration: number
  pub_ts: number
  collection_title: string
  episode_title: string
  episode_order: number
  part_title: string | null
  part_order: number | null
  up_name: string | null
  up_uid: number | null
  create_ts: number
  video_quality: VideoQuality
  codec_type: CodecType
  audio_quality: AudioQuality
}

export function getEpisodeDirAndFilename(
  params: FmtParams,
  config: Config
): { episodeDir: string; filename: string } {
  const raw: Record<string, unknown> = {
    task_id: params.task_id,
    episode_type: params.episode_type,
    aid: params.aid,
    bvid: params.bvid,
    cid: params.cid,
    ep_id: params.ep_id,
    duration: params.duration,
    pub_ts: params.pub_ts,
    collection_title: params.collection_title,
    episode_title: params.episode_title,
    episode_order: params.episode_order,
    part_title: params.part_title,
    part_order: params.part_order,
    up_name: params.up_name,
    up_uid: params.up_uid,
    create_ts: params.create_ts,
    video_quality: params.video_quality,
    codec_type: params.codec_type,
    audio_quality: params.audio_quality
  }

  raw['pub_ts'] = formatTimestamp(params.pub_ts, config.time_fmt)
  raw['create_ts'] = formatTimestamp(params.create_ts, config.time_fmt)

  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    vars[key] = value === null || value === undefined ? '' : String(value)
  }

  const fmt = params.part_title !== null ? config.dir_fmt_for_part : config.dir_fmt
  const names = fmt
    .split('/')
    .map((part) => filenameFilter(strfmt(part, vars)))
    .filter((name) => name !== '')

  const filename = names.pop() ?? ''
  const safeFilename = filename !== '' ? filename : filenameFilter(params.episode_title) || params.task_id
  let episodeDir = config.download_dir
  for (const name of names) episodeDir = join(episodeDir, name)

  return { episodeDir, filename: safeFilename }
}

/** 秒 -> `00:00:00,000`，srt 时间轴 */
export function secondsToSrtTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, '0')}`
}

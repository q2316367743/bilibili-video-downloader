import type { CanvasConfig } from './types'

export interface DanmakuElem {
  id: number
  progress: number
  mode: number
  fontsize: number
  color: number
  midHash: string
  content: string
  ctime: number
  weight: number
  action: string
  pool: number
  idStr: string
  attr: number
  animation: string
  colorful: number
}

/* ───────────────────────── protobuf ───────────────────────── */

/** 只需要 DanmakuElem 的字段，手写一个最小 protobuf 读取器，避免再引入依赖 */
function readVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < buffer.length) {
    const byte = buffer[cursor] ?? 0
    cursor += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [value, cursor]
    shift += 7
    if (shift > 63) throw new Error('弹幕数据格式错误')
  }
  throw new Error('弹幕数据不完整')
}

function skipField(buffer: Buffer, offset: number, wireType: number): number {
  if (wireType === 0) {
    const [, next] = readVarint(buffer, offset)
    return next
  }
  if (wireType === 1) return offset + 8
  if (wireType === 2) {
    const [length, next] = readVarint(buffer, offset)
    return next + length
  }
  if (wireType === 5) return offset + 4
  throw new Error('不支持的弹幕字段类型')
}

function decodeElem(buffer: Buffer): DanmakuElem {
  const elem: DanmakuElem = {
    id: 0,
    progress: 0,
    mode: 0,
    fontsize: 0,
    color: 0,
    midHash: '',
    content: '',
    ctime: 0,
    weight: 0,
    action: '',
    pool: 0,
    idStr: '',
    attr: 0,
    animation: '',
    colorful: 0
  }
  let offset = 0
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset)
    const field = Math.floor(tag / 8)
    const wireType = tag & 7
    offset = afterTag

    if (wireType === 2) {
      const [length, dataStart] = readVarint(buffer, offset)
      const data = buffer.subarray(dataStart, dataStart + length)
      offset = dataStart + length
      if (field === 6) elem.midHash = data.toString('utf8')
      else if (field === 7) elem.content = data.toString('utf8')
      else if (field === 10) elem.action = data.toString('utf8')
      else if (field === 12) elem.idStr = data.toString('utf8')
      else if (field === 22) elem.animation = data.toString('utf8')
      continue
    }
    if (wireType === 0) {
      const [value, next] = readVarint(buffer, offset)
      offset = next
      if (field === 1) elem.id = value
      else if (field === 2) elem.progress = value
      else if (field === 3) elem.mode = value
      else if (field === 4) elem.fontsize = value
      else if (field === 5) elem.color = value
      else if (field === 8) elem.ctime = value
      else if (field === 9) elem.weight = value
      else if (field === 11) elem.pool = value
      else if (field === 13) elem.attr = value
      else if (field === 24) elem.colorful = value
      continue
    }
    offset = skipField(buffer, offset, wireType)
  }
  return elem
}

/** 解析一个 DmSegMobileReply（field 1 = repeated DanmakuElem） */
export function decodeDanmakuSegment(buffer: Buffer): DanmakuElem[] {
  const elems: DanmakuElem[] = []
  let offset = 0
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset)
    const field = Math.floor(tag / 8)
    const wireType = tag & 7
    offset = afterTag
    if (field === 1 && wireType === 2) {
      const [length, dataStart] = readVarint(buffer, offset)
      elems.push(decodeElem(buffer.subarray(dataStart, dataStart + length)))
      offset = dataStart + length
    } else {
      offset = skipField(buffer, offset, wireType)
    }
  }
  return elems
}

export function decodeDanmakuSegments(buffers: Buffer[]): DanmakuElem[] {
  return buffers.flatMap((buffer) => decodeDanmakuSegment(buffer))
}

/* ───────────────────────── XML ───────────────────────── */

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sanitizeXmlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return (
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )
    })
    .join('')
}

/** 和原 Rust 版本的 yaserde 输出一致 */
export function danmakuToXml(elems: DanmakuElem[], cid: number): string {
  const items = elems.map((elem) => {
    const p = [
      Math.floor(elem.progress / 1000),
      elem.mode,
      elem.fontsize,
      elem.color,
      elem.ctime,
      elem.pool,
      elem.midHash,
      elem.idStr
    ].join(',')
    return `<d p="${xmlEscape(p)}">${xmlEscape(sanitizeXmlChars(elem.content))}</d>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?><i><chatid>${cid}</chatid>${items.join('')}</i>`
}

/* ───────────────────────── ASS ───────────────────────── */

type DanmakuType = 'Float' | 'Top' | 'Bottom' | 'Reverse'

interface Danmaku {
  timeline_s: number
  content: string
  type: DanmakuType
  fontsize: number
  rgb: [number, number, number]
}

interface Lane {
  last_shoot_time: number
  last_length: number
}

type Collision =
  | { kind: 'Separate' | 'NotEnoughTime'; closest_dis: number }
  | { kind: 'Collide'; time_needed: number }

function danmakuLength(danmaku: Danmaku, config: CanvasConfig): number {
  let width = 0
  for (const char of Array.from(danmaku.content)) {
    width += char.charCodeAt(0) < 128 ? 2 : 3
  }
  const pts = Math.floor((config.font_size * width) / 3)
  return pts * config.width_ratio
}

function laneAvailableFor(lane: Lane, other: Danmaku, config: CanvasConfig): Collision {
  const T = config.duration
  const W = config.width
  const gap = config.horizontal_gap

  const t1 = lane.last_shoot_time
  const t2 = other.timeline_s
  const l1 = lane.last_length
  const l2 = danmakuLength(other, config)

  const v1 = (W + l1) / T
  const v2 = (W + l2) / T
  const deltaT = t2 - t1
  const deltaX = v1 * deltaT - l1

  if (deltaX < gap) {
    if (l2 <= l1) {
      return { kind: 'Collide', time_needed: (gap - deltaX) / v1 }
    }
    const timeNeeded = T - (W - gap) / v2 - deltaT
    return { kind: 'Collide', time_needed: timeNeeded }
  }

  if (l2 <= l1) {
    return { kind: 'Separate', closest_dis: deltaX - gap }
  }
  const pos = v2 * (T - deltaT)
  if (pos < W - gap) {
    return { kind: 'NotEnoughTime', closest_dis: W - gap - pos }
  }
  return { kind: 'Collide', time_needed: (pos - (W - gap)) / v2 }
}

interface Drawable {
  danmaku: Danmaku
  duration: number
  styleName: string
  start: [number, number]
  end: [number, number]
}

class Canvas {
  private floatLanes: Array<Lane | null>

  constructor(private readonly config: CanvasConfig) {
    const floatLanesCount = Math.floor((config.float_percentage * config.height) / config.lane_size)
    this.floatLanes = new Array<Lane | null>(Math.max(0, floatLanesCount)).fill(null)
  }

  draw(source: Danmaku): Drawable | null {
    const danmaku: Danmaku = { ...source, timeline_s: source.timeline_s + this.config.time_offset }
    if (danmaku.timeline_s < 0) return null
    // 底部 / 顶部 / 逆向弹幕统一按浮动弹幕处理（原项目的 feature）
    if (danmaku.type !== 'Float') danmaku.type = 'Float'
    return this.drawFloat(danmaku)
  }

  private drawFloat(danmaku: Danmaku): Drawable | null {
    const collisions: Array<{ time: number; index: number }> = []
    for (let index = 0; index < this.floatLanes.length; index += 1) {
      const lane = this.floatLanes[index]
      if (lane === null || lane === undefined) return this.drawInLane(danmaku, index)
      const collision = laneAvailableFor(lane, danmaku, this.config)
      if (collision.kind === 'Separate' || collision.kind === 'NotEnoughTime') {
        return this.drawInLane(danmaku, index)
      }
      collisions.push({ time: (collision as { time_needed: number }).time_needed, index })
    }
    if (collisions.length > 0) {
      collisions.sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time))
      const first = collisions[0] as { time: number; index: number }
      if (first.time < 1) {
        danmaku.timeline_s += first.time + 0.01
        return this.drawInLane(danmaku, first.index)
      }
    }
    return null
  }

  private drawInLane(danmaku: Danmaku, laneIndex: number): Drawable {
    this.floatLanes[laneIndex] = {
      last_shoot_time: danmaku.timeline_s,
      last_length: danmakuLength(danmaku, this.config)
    }
    const y = laneIndex * this.config.lane_size
    const length = danmakuLength(danmaku, this.config)
    return {
      danmaku,
      duration: this.config.duration,
      styleName: 'Float',
      start: [this.config.width, y],
      end: [-Math.trunc(length), y]
    }
  }
}

function timePoint(t: number): string {
  const secs = Math.floor(t)
  const hour = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  const left = t - hour * 3600 - minutes * 60
  return `${hour}:${String(minutes).padStart(2, '0')}:${left.toFixed(2).padStart(5, '0')}`
}

function opacity(config: CanvasConfig): number {
  const value = 255 - Math.floor(config.alpha * 255)
  return Math.max(0, Math.min(255, value))
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function assStyle(config: CanvasConfig, name: string): string {
  const a = opacity(config)
  return (
    `Style: ${name},${config.font},${config.font_size},&H${hex2(a)}FFFFFF,&H00FFFFFF,` +
    `&H${hex2(a)}000000,&H00000000,${config.bold ? 1 : 0}, 0, 0, 0, 100, 100, 0.00, 0.00, 1, ` +
    `${config.outline}, 0, 7, 0, 0, 0, 1`
  )
}

function escapeAssText(text: string): string {
  const trimmed = text.trim()
  return trimmed.replace(/\n/g, '\\N')
}

/** 弹幕列表 -> ASS 文本；排序与碰撞处理与原 Rust 实现一致 */
export function danmakusToAss(elems: DanmakuElem[], config: CanvasConfig, title: string): string {
  const lines: string[] = []
  lines.push('[Script Info]')
  lines.push(
    '; Script generated by bilibili-video-downloader (https://github.com/lanyeeee/bilibili-video-downloader)'
  )
  lines.push(`Title: ${title}`)
  lines.push(
    'Script Updated By: bilibili-video-downloader (https://github.com/lanyeeee/bilibili-video-downloader)'
  )
  lines.push('ScriptType: v4.00+')
  lines.push(`PlayResX: ${config.width}`)
  lines.push(`PlayResY: ${config.height}`)
  lines.push(`Aspect Ratio: ${config.width}:${config.height}`)
  lines.push('Collisions: Normal')
  lines.push('WrapStyle: 2')
  lines.push('ScaledBorderAndShadow: yes')
  lines.push('YCbCr Matrix: TV.601')
  lines.push('')
  lines.push('')
  lines.push('[V4+ Styles]')
  lines.push(
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, ' +
      'Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'
  )
  lines.push(assStyle(config, 'Float'))
  lines.push(assStyle(config, 'Bottom'))
  lines.push(assStyle(config, 'Top'))
  lines.push('')
  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

  const danmakus: Danmaku[] = elems.map((elem) => ({
    timeline_s: elem.progress / 1000,
    content: elem.content,
    type: modeToType(elem.mode),
    fontsize: elem.fontsize,
    rgb: [(elem.color >> 16) & 0xff, (elem.color >> 8) & 0xff, elem.color & 0xff]
  }))
  danmakus.sort((a, b) => a.timeline_s - b.timeline_s)

  const canvas = new Canvas(config)
  for (const danmaku of danmakus) {
    const drawable = canvas.draw(danmaku)
    if (drawable === null) continue
    const [r, g, b] = drawable.danmaku.rgb as [number, number, number]
    lines.push(
      `Dialogue: 2,${timePoint(drawable.danmaku.timeline_s)},${timePoint(
        drawable.danmaku.timeline_s + drawable.duration
      )},${drawable.styleName},,0,0,0,,{\\move(${drawable.start[0]}, ${drawable.start[1]}, ${drawable.end[0]}, ${
        drawable.end[1]
      })\\c&H${hex2(b)}${hex2(g)}${hex2(r)}&}${escapeAssText(drawable.danmaku.content)}`
    )
  }

  return lines.join('\n')
}

function modeToType(mode: number): DanmakuType {
  if (mode === 4) return 'Bottom'
  if (mode === 5) return 'Top'
  if (mode === 6) return 'Reverse'
  return 'Float'
}

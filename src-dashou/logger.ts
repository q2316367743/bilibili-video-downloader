import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogMetadata } from './types'

export type LogLevel = LogMetadata['level']

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timestamp(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function toLogValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? '' }
  }
  if (depth >= 4) return String(value)
  if (Array.isArray(value)) return value.map((item) => toLogValue(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toLogValue(item, depth + 1)
    }
    return result
  }
  return String(value)
}

/**
 * 插件自己的日志：写 JSON Lines 到 `<data>/日志/<date>.log`，
 * 同时把同一条记录以 `log-event` 发给窗口（日志面板实时展示、ERROR 弹通知）。
 */
export class Logger {
  readonly logsDir: string
  private fileEnabled = true
  private queue: Promise<void> = Promise.resolve()
  private readonly emit: (jsonRaw: string) => void

  constructor(
    dataDir: string,
    emit: (jsonRaw: string) => void,
    fileEnabled: boolean
  ) {
    this.logsDir = join(dataDir, '日志')
    this.emit = emit
    this.fileEnabled = fileEnabled
  }

  setFileEnabled(enabled: boolean): void {
    this.fileEnabled = enabled
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>, target: string): void {
    const now = new Date()
    const meta: LogMetadata = {
      timestamp: timestamp(now),
      level,
      fields: { message, ...(toLogValue(fields) as Record<string, unknown>) },
      target,
      filename: 'core.mjs',
      line_number: 0,
      span: null,
      spans: []
    }
    let jsonRaw: string
    try {
      jsonRaw = JSON.stringify(meta)
    } catch {
      jsonRaw = JSON.stringify({
        ...meta,
        fields: { message: String(message) }
      })
    }
    this.emit(jsonRaw)

    if (!this.fileEnabled) return
    const file = join(this.logsDir, `${dateStamp(now)}.log`)
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.logsDir, { recursive: true })
        await appendFile(file, `${jsonRaw}\n`, 'utf8')
      })
      .catch(() => {
        // 日志写失败不能影响下载流程
      })
  }

  trace(message: string, fields: Record<string, unknown> = {}, target = 'bilibili'): void {
    this.write('TRACE', message, fields, target)
  }

  debug(message: string, fields: Record<string, unknown> = {}, target = 'bilibili'): void {
    this.write('DEBUG', message, fields, target)
  }

  info(message: string, fields: Record<string, unknown> = {}, target = 'bilibili'): void {
    this.write('INFO', message, fields, target)
  }

  warn(message: string, fields: Record<string, unknown> = {}, target = 'bilibili'): void {
    this.write('WARN', message, fields, target)
  }

  error(title: string, error: unknown, target = 'bilibili'): void {
    const message = error instanceof Error ? error.message : String(error)
    this.write('ERROR', message, { err_title: title, message }, target)
  }

  /** 等待队列里的文件写入落盘（退出 / 测试用） */
  async flush(): Promise<void> {
    await this.queue
  }

  async logsDirSize(): Promise<number> {
    let total = 0
    let entries: string[]
    try {
      entries = await readdir(this.logsDir)
    } catch {
      return total
    }
    for (const entry of entries) {
      try {
        const info = await stat(join(this.logsDir, entry))
        if (info.isFile()) total += info.size
      } catch {
        // 忽略无法读取的文件
      }
    }
    return total
  }

  /** 读取日志文件为 LogMetadata 列表，坏行跳过 */
  async readLogFile(path: string): Promise<LogMetadata[]> {
    const content = await readFile(path, 'utf8')
    const logs: LogMetadata[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        logs.push(JSON.parse(trimmed) as LogMetadata)
      } catch {
        // 跳过无法解析的行
      }
    }
    return logs
  }
}

export function levelAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[threshold]
}

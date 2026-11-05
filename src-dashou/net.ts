/**
 * 网络层：core 里直接走 Node，不受窗口 CSP / CORS 限制。
 *
 * 代理策略来自插件配置：
 * - NoProxy：直连
 * - System：HTTPS_PROXY 等环境变量，其次系统代理
 * - Custom：http://host:port
 */
import { execFileSync } from 'node:child_process'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'
import type { ProxyMode } from './types'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
export const REFERRER = 'https://www.bilibili.com/'

export interface ProxySetting {
  mode: ProxyMode
  host: string
  port: number
}

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: Buffer
  signal?: AbortSignal
  timeoutMs?: number
  retry?: number
  proxy?: ProxySetting
}

const MAX_REDIRECTS = 5

export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

/** 发起请求并返回完整响应体；网络错误重试 */
export async function request(url: string, options: RequestOptions = {}): Promise<RawResponse> {
  const attempts = options.retry ?? 2
  let last: unknown = new NetworkError('网络连接失败，请检查网络')
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const response = await once(url, options)
      // B 站风控的 412 是随机的，退避后重试通常能过
      if ((response.status === 412 || response.status === 429) && attempt < attempts) {
        await sleep(500 * (attempt + 1))
        continue
      }
      return response
    } catch (error) {
      if (isAbort(error)) throw error
      last = error
      if (attempt < attempts) await sleep(400 * (attempt + 1))
    }
  }
  throw last instanceof Error ? last : new NetworkError(String(last))
}

async function once(url: string, options: RequestOptions): Promise<RawResponse> {
  let target = url
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new NetworkError('无效的地址')
    }
    if (options.signal?.aborted) throw abortError()

    const proxy = proxyFor(parsed, options)
    const response =
      parsed.protocol === 'http:'
        ? await requestHttp(parsed, options, proxy)
        : await requestHttps(parsed, options, proxy)

    const location = response.headers.location
    if (response.status >= 300 && response.status < 400 && typeof location === 'string' && location !== '') {
      target = new URL(location, target).toString()
      // 跨域重定向后不再携带 Cookie，避免把 SESSDATA 发给 CDN
      if (new URL(target).origin !== parsed.origin) {
        options = { ...options, headers: stripCookie(options.headers) }
      }
      continue
    }
    return response
  }
  throw new NetworkError('页面跳转次数过多')
}

function stripCookie(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'cookie') continue
    next[key] = value
  }
  return next
}

function requestHttps(
  parsed: URL,
  options: RequestOptions,
  proxy: string | null
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const finish = async (): Promise<void> => {
      const tunnel = proxy === null ? null : await connectThroughProxy(parsed, proxy, options.signal).catch(reject)
      if (tunnel === undefined) return
      send(parsed, options, tunnel)
    }
    void finish()

    function send(target: URL, opts: RequestOptions, tunnel: tls.TLSSocket | null): void {
      try {
        const req = https.request(
          target,
          {
            method: opts.method ?? 'GET',
            timeout: opts.timeoutMs ?? 20_000,
            ...(tunnel === null ? {} : { createConnection: () => tunnel, servername: target.hostname }),
            headers: baseHeaders(opts.headers)
          },
          (res) => collect(res, resolve, reject)
        )
        bindAbort(req, opts.signal, reject)
        if (opts.body) req.write(opts.body)
        req.end()
      } catch (error) {
        reject(toNetworkError(error))
      }
    }
  })
}

function requestHttp(
  parsed: URL,
  options: RequestOptions,
  proxy: string | null
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    try {
      const useProxy = proxy !== null
      const proxyUrl = useProxy ? new URL(proxy) : null
      const req = http.request(
        useProxy && proxyUrl !== null
          ? {
              host: proxyUrl.hostname,
              port: Number(proxyUrl.port === '' ? '80' : proxyUrl.port),
              path: parsed.toString(),
              method: options.method ?? 'GET',
              timeout: options.timeoutMs ?? 20_000,
              headers: {
                ...baseHeaders(options.headers),
                Host: parsed.host
              }
            }
          : {
              host: parsed.hostname,
              port: Number(parsed.port === '' ? '80' : parsed.port),
              path: `${parsed.pathname}${parsed.search}`,
              method: options.method ?? 'GET',
              timeout: options.timeoutMs ?? 20_000,
              headers: baseHeaders(options.headers)
            },
        (res) => collect(res, resolve, reject)
      )
      bindAbort(req, options.signal, reject)
      if (options.body) req.write(options.body)
      req.end()
    } catch (error) {
      reject(toNetworkError(error))
    }
  })
}

function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: REFERRER,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    ...extra
  }
}

function collect(
  res: http.IncomingMessage,
  resolve: (value: RawResponse) => void,
  reject: (error: Error) => void
): void {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  res.on('end', () => {
    const body = decode(Buffer.concat(chunks), res.headers['content-encoding'])
    resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
  })
  res.on('error', (error) => reject(toNetworkError(error)))
}

function bindAbort(req: http.ClientRequest, signal: AbortSignal | undefined, reject: (error: Error) => void): void {
  req.on('timeout', () => req.destroy(new NetworkError('请求超时')))
  req.on('error', (error) => reject(toNetworkError(error)))
  if (signal === undefined) return

  const onAbort = (): void => {
    req.destroy(abortError())
  }
  if (signal.aborted) {
    onAbort()
    return
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // 请求结束（成功 / 失败 / 被销毁）后移除监听，避免大文件下载时堆积 listener
  req.once('close', () => signal.removeEventListener('abort', onAbort))
}

/* ───────────────────────── 代理 ───────────────────────── */

interface SystemProxy {
  http: string | null
  https: string | null
}

let systemProxyCache: { at: number; value: SystemProxy } | null = null
let runtimeProxy: ProxySetting = { mode: 'NoProxy', host: '', port: 0 }

/** 由插件在配置变更时调用 */
export function setProxy(setting: ProxySetting): void {
  runtimeProxy = setting
}

function proxyFor(target: URL, options: RequestOptions): string | null {
  const setting = options.proxy ?? runtimeProxy
  if (setting.mode === 'NoProxy') return null
  if (setting.mode === 'Custom') {
    if (setting.host.trim() === '') return null
    return `http://${setting.host.trim()}:${setting.port}`
  }
  if (bypassProxy(target)) return null
  const envHttps = env('HTTPS_PROXY') || env('https_proxy') || env('ALL_PROXY') || env('all_proxy')
  const envHttp = env('HTTP_PROXY') || env('http_proxy') || env('ALL_PROXY') || env('all_proxy')
  if (target.protocol === 'https:') return envHttps || envHttp || systemProxy('https') || systemProxy('http')
  return envHttp || systemProxy('http')
}

function bypassProxy(target: URL): boolean {
  const list = env('NO_PROXY') || env('no_proxy')
  if (list === '') return false
  const host = target.hostname.toLowerCase()
  for (const item of list.split(',')) {
    const rule = item.trim().toLowerCase()
    if (rule === '') continue
    if (rule === '*') return true
    const domain = rule.replace(/^\./, '').replace(/:\d+$/, '')
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}

function systemProxy(kind: keyof SystemProxy): string | null {
  const now = Date.now()
  if (systemProxyCache === null || now - systemProxyCache.at > 60_000) {
    systemProxyCache = { at: now, value: detectSystemProxy() }
  }
  return systemProxyCache.value[kind]
}

function detectSystemProxy(): SystemProxy {
  try {
    if (process.platform === 'darwin') return detectMacProxy()
    if (process.platform === 'win32') return detectWindowsProxy()
    return detectLinuxProxy()
  } catch {
    return { http: null, https: null }
  }
}

function detectMacProxy(): SystemProxy {
  const text = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 })
  const value = (key: string): string => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm').exec(text)
    return match?.[1] ?? ''
  }
  const build = (enabledKey: string, hostKey: string, portKey: string): string | null => {
    if (value(enabledKey) !== '1') return null
    const host = value(hostKey)
    const port = value(portKey)
    return host !== '' && port !== '' ? `http://${host}:${port}` : null
  }
  const http = build('HTTPEnable', 'HTTPProxy', 'HTTPPort')
  const https = build('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort') ?? http
  return { http, https }
}

function detectWindowsProxy(): SystemProxy {
  const output = execFileSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    { encoding: 'utf8', timeout: 1500 }
  )
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return { http: null, https: null }
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(output)?.[1]?.trim() ?? ''
  if (raw === '') return { http: null, https: null }
  if (!raw.includes('=')) {
    const value = `http://${raw}`
    return { http: value, https: value }
  }
  const map = new Map<string, string>()
  for (const part of raw.split(';')) {
    const [key, value] = part.split('=')
    if (key !== undefined && value !== undefined) map.set(key.trim().toLowerCase(), value.trim())
  }
  const http = map.get('http') ?? ''
  const https = map.get('https') ?? http
  return { http: http === '' ? null : `http://${http}`, https: https === '' ? null : `http://${https}` }
}

function detectLinuxProxy(): SystemProxy {
  const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
    encoding: 'utf8',
    timeout: 1500
  }).trim()
  if (mode !== "'manual'") return { http: null, https: null }
  const build = (schema: string): string | null => {
    const host = gsettings(`${schema}.host`)
    const port = gsettings(`${schema}.port`)
    return host !== '' && port !== '' ? `http://${host}:${port}` : null
  }
  return { http: build('org.gnome.system.proxy.http'), https: build('org.gnome.system.proxy.https') }
}

function gsettings(key: string): string {
  try {
    return execFileSync('gsettings', ['get', key], { encoding: 'utf8', timeout: 1500 })
      .trim()
      .replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/** HTTP CONNECT 隧道；只支持 http:// 代理 */
function connectThroughProxy(
  target: URL,
  proxyUrl: string,
  signal?: AbortSignal
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let proxy: URL
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(new NetworkError('代理地址无效'))
      return
    }
    if (proxy.protocol !== 'http:') {
      reject(new NetworkError('暂不支持这种代理类型'))
      return
    }

    const port = target.port === '' ? '443' : target.port
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port === '' ? '80' : proxy.port)
    })

    const onAbort = (): void => {
      fail(abortError())
    }
    const fail = (error: Error): void => {
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(error)
    }

    if (signal?.aborted) {
      fail(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.setTimeout(15_000, () => fail(new NetworkError('代理连接超时')))
    socket.once('error', fail)
    socket.once('connect', () => {
      const auth =
        proxy.username === ''
          ? ''
          : `Proxy-Authorization: Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
            ).toString('base64')}\r\n`
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n${auth}\r\n`
      )
    })

    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail(new NetworkError('代理响应异常'))
        return
      }
      socket.off('data', onData)
      socket.off('error', fail)
      socket.setTimeout(0)

      const head = buffer.subarray(0, end).toString('latin1')
      const rest = buffer.subarray(end + 4)
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0)
      if (status < 200 || status >= 300) {
        fail(new NetworkError(`代理连接失败（${status === 0 ? '未知' : status}）`))
        return
      }
      if (rest.length > 0) socket.unshift(rest)

      const secure = tls.connect({ socket, servername: target.hostname })
      secure.once('error', fail)
      secure.once('secureConnect', () => {
        secure.off('error', fail)
        signal?.removeEventListener('abort', onAbort)
        resolve(secure)
      })
    }
    socket.on('data', onData)
  })
}

/* ───────────────────────── 工具 ───────────────────────── */

function decode(body: Buffer, encoding: http.IncomingHttpHeaders['content-encoding']): Buffer {
  const value = String(encoding ?? '').toLowerCase()
  if (body.length === 0) return body
  try {
    if (value.includes('br')) return zlib.brotliDecompressSync(body)
    if (value.includes('gzip')) return zlib.gunzipSync(body)
    if (value.includes('deflate')) return zlib.inflateSync(body)
  } catch {
    // 压缩头与实际内容不一致时按原始字节处理
  }
  return body
}

function toNetworkError(error: unknown): Error {
  if (isAbort(error)) return error as Error
  const raw = error instanceof Error ? error : new Error(String(error))
  if (/ENOTFOUND|EAI_AGAIN/.test(raw.message)) return new NetworkError('域名解析失败，请检查网络')
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|TLS|certificate/i.test(raw.message)) {
    return new NetworkError('网络连接失败，请检查网络或代理设置')
  }
  return raw
}

export function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

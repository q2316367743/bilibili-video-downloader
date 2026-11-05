import { createHash } from 'node:crypto'
import { REFERRER, USER_AGENT, NetworkError, request, type ProxySetting } from './net'
import type {
  BangumiInfo,
  CheeseInfo,
  Config,
  NormalInfo,
  PlayerInfo,
  ProxyMode
} from './types'
import type { Logger } from './logger'

const API_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Referer: REFERRER,
  Accept: 'application/json, text/plain, */*'
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

const DEVICE_TYPE: Record<string, number> = { All: 0, PC: 1, Mobile: 2, Pad: 3, TV: 4 }

export class BiliError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = 'BiliError'
    this.code = code
  }
}

type ParamValue = string | number | boolean | null | undefined
type QueryParams = Record<string, ParamValue> | Array<[string, ParamValue]>

function queryString(params: QueryParams): string {
  const pairs = Array.isArray(params) ? params : Object.entries(params)
  return pairs
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** Rust 那版会把 `!'()*` 从签名串里过滤掉，保持一致 */
function wbiEncode(value: string): string {
  let result = ''
  for (const char of Array.from(value)) {
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      result += char
    } else if ("!'()*".includes(char)) {
      continue
    } else {
      result += encodeURIComponent(char)
    }
  }
  return result
}

function filenameOfUrl(url: string): string {
  const path = url.split('?')[0] ?? ''
  const last = path.slice(path.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(0, dot) : last
}

function parseBiliResp(body: string, context: string, ignoreCode = false): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new BiliError(`${context}失败：返回的数据无法解析`)
  }
  const resp = parsed as { code?: number; msg?: string; message?: string; data?: unknown; result?: unknown }
  const code = typeof resp.code === 'number' ? resp.code : 0
  if (code === 0 || ignoreCode) {
    return resp.data !== undefined ? resp.data : resp.result
  }
  throw new BiliError(biliErrorMessage(code, resp.msg ?? resp.message ?? ''), code)
}

function biliErrorMessage(code: number, msg: string): string {
  const detail = msg.trim() === '' ? '' : `：${msg.trim()}`
  if (code === -101) return '账号未登录或登录已过期，请重新登录'
  if (code === -403) return '没有访问权限'
  if (code === -10403) return '地区限制，请使用代理或切换线路后重试'
  if (code === -404) return '内容不存在或已被删除'
  return `请求失败（${code}）${detail}`
}

export class BiliClient {
  private readonly logger: Logger
  private config: Config
  private wbiKeys: { imgKey: string; subKey: string; at: number } | null = null

  constructor(config: Config, logger: Logger) {
    this.config = config
    this.logger = logger
  }

  updateConfig(config: Config): void {
    this.config = config
    this.wbiKeys = null
  }

  private get proxy(): ProxySetting {
    return {
      mode: this.config.proxy_mode as ProxyMode,
      host: this.config.proxy_host,
      port: this.config.proxy_port
    }
  }

  private cookie(): string {
    return `SESSDATA=${this.config.sessdata.trim().replace(/;$/, '')}`
  }

  private async apiGet(
    path: string,
    params?: QueryParams,
    options: {
      cookie?: boolean
      timeoutMs?: number
      headers?: Record<string, string>
      ignoreCode?: boolean
    } = {}
  ): Promise<unknown> {
    const query = params === undefined ? '' : queryString(params)
    const url = query === '' ? path : `${path}?${query}`
    const headers: Record<string, string> = { ...API_HEADERS, ...(options.headers ?? {}) }
    if (options.cookie !== false) headers.cookie = this.cookie()

    const response = await request(url, {
      headers,
      timeoutMs: options.timeoutMs ?? 10_000,
      proxy: this.proxy,
      retry: 1
    })
    const body = response.body.toString('utf8')
    if (response.status === 412 || response.status === 429) {
      throw new BiliError('访问被 B 站风控拦截，请稍后重试或登录后再试')
    }
    if (response.status !== 200) {
      throw new BiliError(`请求失败（HTTP ${response.status}）`)
    }
    return parseBiliResp(body, '获取数据', options.ignoreCode === true)
  }

  async generateQrcode(): Promise<{ url: string; qrcode_key: string }> {
    const data = (await this.apiGet(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
      undefined,
      { cookie: false }
    )) as { url: string; qrcode_key: string }
    if (data === null || typeof data !== 'object' || data.qrcode_key === undefined) {
      throw new BiliError('生成二维码失败')
    }
    return data
  }

  async getQrcodeStatus(qrcodeKey: string): Promise<{
    url: string
    refresh_token: string
    timestamp: number
    code: number
    message: string
    sessdata?: string
  }> {
    const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?${queryString({
      qrcode_key: qrcodeKey
    })}`
    const response = await request(url, {
      headers: { ...API_HEADERS },
      timeoutMs: 10_000,
      proxy: this.proxy,
      retry: 1
    })
    if (response.status !== 200) {
      throw new BiliError(`获取二维码状态失败（HTTP ${response.status}）`)
    }
    const data = parseBiliResp(response.body.toString('utf8'), '获取二维码状态') as {
      url: string
      refresh_token: string
      timestamp: number
      code: number
      message: string
      sessdata?: string
    }
    if (data === null || typeof data !== 'object' || typeof data.code !== 'number') {
      throw new BiliError('获取二维码状态失败：返回的数据格式不正确')
    }
    if (![0, 86101, 86090, 86038].includes(data.code)) {
      throw new BiliError(`二维码状态异常（${data.code}）`)
    }
    if (data.code === 0) {
      const cookies = response.headers['set-cookie'] ?? []
      let sessdata = ''
      for (const cookie of cookies) {
        const first = cookie.split(';')[0] ?? ''
        const eq = first.indexOf('=')
        if (eq >= 0 && first.slice(0, eq).trim() === 'SESSDATA') {
          sessdata = first.slice(eq + 1)
          break
        }
      }
      if (sessdata === '') {
        throw new BiliError('扫码成功，但没有拿到登录凭证，请重试')
      }
      data.sessdata = sessdata
    }
    return data
  }

  async getUserInfo(sessdata: string): Promise<Record<string, unknown>> {
    const url = 'https://api.bilibili.com/x/web-interface/nav'
    const response = await request(url, {
      headers: { ...API_HEADERS, cookie: `SESSDATA=${sessdata.replace(/;$/, '')}` },
      timeoutMs: 10_000,
      proxy: this.proxy,
      retry: 1
    })
    if (response.status !== 200) {
      throw new BiliError(`获取用户信息失败（HTTP ${response.status}）`)
    }
    const data = parseBiliResp(response.body.toString('utf8'), '获取用户信息')
    if (data === null || typeof data !== 'object') {
      throw new BiliError('获取用户信息失败：返回的数据格式不正确')
    }
    return data as Record<string, unknown>
  }

  async getNormalInfo(params: { Bvid: string } | { Aid: number }): Promise<NormalInfo> {
    const query: QueryParams = 'Bvid' in params ? { bvid: params.Bvid } : { aid: params.Aid }
    return (await this.apiGet('https://api.bilibili.com/x/web-interface/view', query)) as NormalInfo
  }

  async getBangumiInfo(params: { EpId: number } | { SeasonId: number }): Promise<BangumiInfo> {
    const query: QueryParams =
      'EpId' in params ? { ep_id: params.EpId } : { season_id: params.SeasonId }
    return (await this.apiGet('https://api.bilibili.com/pgc/view/web/season', query)) as BangumiInfo
  }

  async getCheeseInfo(params: { EpId: number } | { SeasonId: number }): Promise<CheeseInfo> {
    const query: QueryParams =
      'EpId' in params ? { ep_id: params.EpId } : { season_id: params.SeasonId }
    return (await this.apiGet('https://api.bilibili.com/pugv/view/web/season', query)) as CheeseInfo
  }

  async getUserVideoInfo(params: { pn: number; mid: number }): Promise<unknown> {
    const dmImgStr = randomBase64().slice(0, -2)
    const dmCoverImgStr = randomBase64().slice(0, -2)
    const query: Array<[string, ParamValue]> = [
      ['pn', params.pn],
      ['ps', 42],
      ['mid', params.mid],
      ['dm_img_list', '[]'],
      ['dm_img_str', dmImgStr],
      ['dm_cover_img_str', dmCoverImgStr],
      ['dm_img_inter', '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}']
    ]
    const signed = await this.wbi(query)
    return this.apiGet('https://api.bilibili.com/x/space/wbi/arc/search', signed)
  }

  async getNormalUrl(bvid: string, cid: number): Promise<Record<string, any>> {
    return (await this.apiGet('https://api.bilibili.com/x/player/wbi/playurl', {
      bvid,
      cid,
      qn: 127,
      fnval: 4048
    })) as Record<string, any>
  }

  async getBangumiUrl(cid: number): Promise<Record<string, any>> {
    const v2 = (await this.getBangumiUrlV2(cid)) as { video_info?: Record<string, any> }
    const info = v2.video_info
    if (info !== undefined && info['is_drm'] === true) {
      return this.getBangumiUrlV1(cid)
    }
    if (info === undefined) throw new BiliError('获取番剧视频链接失败')
    return info
  }

  private async getBangumiUrlV1(cid: number): Promise<Record<string, any>> {
    return (await this.apiGet('https://api.bilibili.com/pgc/player/web/playurl', {
      cid,
      qn: 127,
      fnval: 4048,
      drm_tech_type: 2
    })) as Record<string, any>
  }

  private async getBangumiUrlV2(cid: number): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/pgc/player/web/v2/playurl', {
      cid,
      qn: 127,
      fnval: 4048,
      drm_tech_type: 2,
      from_client: 'BROWSER'
    })
  }

  async getCheeseUrl(epId: number): Promise<Record<string, any>> {
    return (await this.apiGet('https://api.bilibili.com/pugv/player/web/playurl', {
      ep_id: epId,
      qn: 127,
      fnval: 4048,
      drm_tech_type: 2
    })) as Record<string, any>
  }

  async getPlayerInfo(aid: number, cid: number): Promise<PlayerInfo> {
    return (await this.apiGet('https://api.bilibili.com/x/player/wbi/v2', {
      aid,
      cid
    })) as PlayerInfo
  }

  async getFavFolders(uid: number): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all', { up_mid: uid })
  }

  async getFavInfo(params: { media_list_id: number; pn: number }): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/x/v3/fav/resource/list', {
      media_id: params.media_list_id,
      pn: params.pn,
      ps: 36,
      platform: 'web'
    })
  }

  async getWatchLaterInfo(page: number): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/x/v2/history/toview', { ps: 20, pn: page })
  }

  async getBangumiFollowInfo(params: {
    vmid: number
    type: number
    pn: number
    follow_status: number
  }): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/x/space/bangumi/follow/list', {
      vmid: params.vmid,
      type: params.type,
      pn: params.pn,
      ps: 24,
      follow_status: params.follow_status
    })
  }

  async getHistoryInfo(params: {
    pn: number
    keyword: string
    add_time_start: number
    add_time_end: number
    arc_max_duration: number
    arc_min_duration: number
    device_type: string
  }): Promise<unknown> {
    return this.apiGet('https://api.bilibili.com/x/web-interface/history/search', {
      pn: params.pn,
      keyword: params.keyword,
      business: 'archive',
      add_time_start: params.add_time_start,
      add_time_end: params.add_time_end,
      arc_max_duration: params.arc_max_duration,
      arc_min_duration: params.arc_min_duration,
      device_type: DEVICE_TYPE[params.device_type] ?? 0
    })
  }

  /** 分片下载：必须是 206 Partial Content */
  async getMediaChunk(url: string, start: number, end: number, signal?: AbortSignal): Promise<Buffer> {
    const response = await request(url, {
      headers: { ...API_HEADERS, range: `bytes=${start}-${end}` },
      timeoutMs: 30_000,
      proxy: this.proxy,
      retry: 3,
      signal
    })
    if (response.status !== 206) {
      throw new BiliError(`媒体分片下载失败（HTTP ${response.status}）`)
    }
    return response.body
  }

  /** HEAD 拿 Content-Length；部分 CDN 不支持 HEAD，再降级用 Range 探测 */
  async getContentLength(url: string, signal?: AbortSignal): Promise<number> {
    const head = await request(url, {
      method: 'HEAD',
      headers: API_HEADERS,
      timeoutMs: 15_000,
      proxy: this.proxy,
      retry: 1,
      signal
    })
    if (head.status === 200) {
      const length = Number(head.headers['content-length'] ?? '')
      if (Number.isFinite(length) && length > 0) return length
    }

    const probe = await request(url, {
      headers: { ...API_HEADERS, range: 'bytes=0-0' },
      timeoutMs: 15_000,
      proxy: this.proxy,
      retry: 1,
      signal
    })
    if (probe.status === 206) {
      const contentRange = String(probe.headers['content-range'] ?? '')
      const total = Number(contentRange.split('/')[1] ?? '')
      if (Number.isFinite(total) && total > 0) return total
      throw new BiliError('无法获取文件大小')
    }
    if (probe.status === 200) {
      const length = Number(probe.headers['content-length'] ?? '')
      if (Number.isFinite(length) && length > 0) return length
    }
    throw new BiliError(`无法获取文件大小（HTTP ${probe.status}）`)
  }

  /** 对一组候选地址并发探测大小，返回成功的那些 */
  async getUrlsWithContentLength(
    urls: string[],
    signal?: AbortSignal
  ): Promise<Array<[string, number]>> {
    const results = await Promise.all(
      urls.map(async (url): Promise<[string, number] | null> => {
        try {
          const length = await this.getContentLength(url, signal)
          return [url, length]
        } catch {
          return null
        }
      })
    )
    return results.filter((item): item is [string, number] => item !== null)
  }

  async getDanmaku(aid: number, cid: number, duration: number, signal?: AbortSignal): Promise<Buffer[]> {
    const segmentCount = Math.ceil(duration / 360)
    const results: Array<{ index: number; body: Buffer }> = []
    const indices = Array.from({ length: Math.max(segmentCount, 1) }, (_, i) => i + 1)

    const worker = async (index: number): Promise<void> => {
      const query = queryString({ type: 1, oid: cid, pid: aid, segment_index: index })
      const response = await request(`https://api.bilibili.com/x/v2/dm/web/seg.so?${query}`, {
        headers: { ...API_HEADERS, cookie: this.cookie() },
        timeoutMs: 20_000,
        proxy: this.proxy,
        retry: 2,
        signal
      })
      if (response.status !== 200) {
        throw new BiliError(`获取弹幕失败（HTTP ${response.status}）`)
      }
      results.push({ index, body: response.body })
    }

    let cursor = 0
    const threads = Array.from({ length: Math.min(8, indices.length) }, async () => {
      while (cursor < indices.length) {
        const index = indices[cursor] as number
        cursor += 1
        await worker(index)
      }
    })
    await Promise.all(threads)
    results.sort((a, b) => a.index - b.index)
    return results.map((item) => item.body)
  }

  async getSubtitle(url: string): Promise<{ body: Array<{ content: string; from: number; to: number }> }> {
    const response = await request(url, {
      headers: { ...API_HEADERS, cookie: this.cookie() },
      timeoutMs: 20_000,
      proxy: this.proxy,
      retry: 2
    })
    if (response.status !== 200) {
      throw new BiliError(`获取字幕失败（HTTP ${response.status}）`)
    }
    try {
      return JSON.parse(response.body.toString('utf8')) as {
        body: Array<{ content: string; from: number; to: number }>
      }
    } catch {
      throw new BiliError('获取字幕失败：数据无法解析')
    }
  }

  async getCoverDataAndExt(url: string): Promise<{ data: Buffer; ext: string }> {
    const response = await request(url, {
      headers: { ...API_HEADERS, cookie: this.cookie() },
      timeoutMs: 20_000,
      proxy: this.proxy,
      retry: 2
    })
    if (response.status !== 200) {
      throw new BiliError(`获取封面失败（HTTP ${response.status}）`)
    }
    const contentType = String(response.headers['content-type'] ?? '')
    const ext = contentType.startsWith('image/png')
      ? 'png'
      : contentType.startsWith('image/webp')
        ? 'webp'
        : contentType.startsWith('image/avif')
          ? 'avif'
          : 'jpg'
    return { data: response.body, ext }
  }

  async getTags(aid: number): Promise<Array<{ tag_name: string }>> {
    const data = (await this.apiGet('https://api.bilibili.com/x/web-interface/view/detail/tag', {
      aid
    })) as Array<{ tag_name: string }>
    return Array.isArray(data) ? data : []
  }

  async getSkipSegments(bvid: string, cid: number | null): Promise<Array<Record<string, any>>> {
    const query: QueryParams = { videoID: bvid, actionType: 'skip' }
    if (cid !== null) query['cid'] = cid
    const url = `https://bsbsb.top/api/skipSegments?${queryString(query)}`
    const response = await request(url, {
      headers: API_HEADERS,
      timeoutMs: 15_000,
      proxy: this.proxy,
      retry: 1
    })
    if (response.status === 404) return []
    if (response.status !== 200) {
      throw new BiliError(`获取跳过片段失败（HTTP ${response.status}）`)
    }
    try {
      const parsed = JSON.parse(response.body.toString('utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /* ───────────────────────── WBI 签名 ───────────────────────── */

  private async wbi(params: Array<[string, ParamValue]>): Promise<Array<[string, string]>> {
    const { imgKey, subKey } = await this.getWbiKeys()
    const mixinKey = MIXIN_KEY_ENC_TAB.slice(0, 32)
      .map((index) => (imgKey + subKey)[index] ?? '')
      .join('')

    const withTs: Array<[string, string]> = [
      ...params.map(([key, value]): [string, string] => [key, value === null || value === undefined ? '' : String(value)]),
      ['wts', String(Math.floor(Date.now() / 1000))]
    ]
    withTs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const query = withTs.map(([key, value]) => `${wbiEncode(key)}=${wbiEncode(value)}`).join('&')
    const wRid = md5(query + mixinKey)
    return [...withTs, ['w_rid', wRid]]
  }

  private async getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
    if (this.wbiKeys !== null && Date.now() - this.wbiKeys.at < 10 * 60_000) {
      return this.wbiKeys
    }
    // 未登录时 nav 也是 code=-101，但 data 里仍然有 wbi_img，需要忽略 code
    const data = (await this.apiGet(
      'https://api.bilibili.com/x/web-interface/nav',
      undefined,
      { ignoreCode: true }
    )) as {
      wbi_img?: { img_url?: string; sub_url?: string }
    }
    const imgUrl = data?.wbi_img?.img_url ?? ''
    const subUrl = data?.wbi_img?.sub_url ?? ''
    const imgKey = filenameOfUrl(imgUrl)
    const subKey = filenameOfUrl(subUrl)
    if (imgKey === '' || subKey === '') {
      throw new BiliError('获取 WBI 签名密钥失败')
    }
    this.wbiKeys = { imgKey, subKey, at: Date.now() }
    return { imgKey, subKey }
  }

  /** 供下载器判断错误类型 */
  static isNetworkError(error: unknown): boolean {
    return error instanceof NetworkError || (error instanceof Error && error.name === 'NetworkError')
  }

  log(message: string): void {
    this.logger.debug(message, {}, 'bilibili.client')
  }
}

function randomBase64(): string {
  const bytes = Buffer.alloc(48)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * (127 - 32 + 1)) + 32
  }
  return bytes.toString('base64')
}
